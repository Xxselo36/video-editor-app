#!/usr/bin/env bash
# apt-get install for CI: bounded attempts on three mirrors, and an
# offline install from .debs cached by actions/cache when there are some.
#
# The runner's Ubuntu mirror sometimes stalls a download for 10+ minutes
# (seen twice in a row on 2026-09-30: the web e2e job hit its 15-min
# limit before a test ran), was down for good on 2026-10-01, and in early
# October failed both attempts about 7 times in 2 days (the second one
# rewrote only the sources files, which on the runner images name the
# mirror list below rather than a mirror: most likely the same mirror).
# apt's own Acquire timeouts catch a dead connection; `timeout` catches a
# transfer that crawls. Unpacking takes seconds, so a stalled attempt is
# only ever a download and is safe to kill; dpkg --configure -a tidies up
# before the next attempt. Every attempt downloads to the same directory,
# so a later attempt resumes what an earlier one fetched.
#
# Network attempts (60 s for apt-get update, 150 s for the install):
#   1. the runner's own apt sources
#   2. every Ubuntu source switched to archive.ubuntu.com
#   3. every Ubuntu source switched to mirrors.edge.kernel.org (not run by
#      Canonical, unlike the first two)
# The runner images list their mirrors in /etc/apt/apt-mirrors.txt (a
# mirror+file: source), so the switch rewrites that list as well as the
# sources. The whole script gives up after BUDGET seconds (~11.7 min),
# well inside the callers' timeout-minutes (25 or more).
#
# Usage:
#   apt-install.sh PACKAGE...
#   APT_DEB_CACHE=DIR apt-install.sh PACKAGE...
#       DIR, owned by the runner user, holds the .debs an earlier run
#       saved (restored by actions/cache/restore). Install from them first
#       with no network: apt-get --no-download --no-remove, no downgrades,
#       so a set from another runner image fails before dpkg runs. If that
#       fails, use the network as above. After a successful install, DIR
#       holds the .debs this install needed (those installed now at their
#       exact version) and save=true goes to $GITHUB_OUTPUT for an
#       actions/cache/save step.
#   apt-install.sh --cache-key PACKAGE... >> "$GITHUB_OUTPUT"
#       key= and restore-key= for that cache: OS release, architecture and
#       package list, then the runner image version. restore-key leaves
#       the image version out, so a new image tries the last image's .debs
#       (and downloads if they do not fit).
set -uo pipefail

if [ "${1:-}" = --cache-key ]; then
  shift
  # shellcheck disable=SC1091
  os=$(. /etc/os-release && echo "${ID:-linux}-${VERSION_ID:-none}")
  pkgs=$(printf '%s\n' "$@" | LC_ALL=C sort -u | sha256sum | cut -c1-16)
  # GitHub's runners set ImageVersion; elsewhere, what dpkg has installed.
  image=${ImageVersion:-dpkg-$(dpkg-query -W | sha256sum | cut -c1-16)}
  prefix="apt-debs-v1-${os}-$(dpkg --print-architecture)-${pkgs}-"
  echo "key=${prefix}${image}"
  echo "restore-key=${prefix}"
  exit 0
fi

if [ $# = 0 ]; then
  echo "::error title=apt-get::usage: $0 PACKAGE... (or --cache-key PACKAGE...)"
  exit 2
fi

BUDGET=700
deadline=$((SECONDS + BUDGET))
# Downloads land here (root's, like /var/cache/apt/archives: apt keeps a
# lock file and an _apt-owned partial/ in it), never in APT_DEB_CACHE.
archives=/var/cache/apt/ci-archives
apt=(sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20
     -o Acquire::https::Timeout=20 -o Dpkg::Use-Pty=0
     -o DPkg::Lock::Timeout=30 -o "Dir::Cache::archives=${archives}/")
sudo mkdir -p "$archives/partial"

# capped SECONDS COMMAND...: COMMAND under `timeout`, for at most SECONDS
# and never past the deadline (10 s spare for the KILL after the TERM).
# Sets $cap to the limit used; 124 = timed out, or no time left.
cap=0
capped() {
  local left=$((deadline - SECONDS - 10))
  cap=$1
  shift
  [ "$left" -lt "$cap" ] && cap=$left
  [ "$cap" -gt 0 ] || { cap=0; return 124; }
  timeout -k 10 "$cap" "$@"
}

# why EXIT: what a capped command's exit status means.
why() {
  if [ "$1" = 124 ]; then echo "timed out after ${cap} s"; else echo "failed (exit $1)"; fi
}

# installed PACKAGE[:ARCH] [VERSION]: dpkg has it fully installed (at VERSION).
# shellcheck disable=SC2016  # dpkg-query's format, not the shell's
status_fmt='${db:Status-Abbrev}${Version}\n'
installed() {
  local line
  while IFS= read -r line; do
    if [ -n "${2:-}" ]; then
      [ "$line" = "ii $2" ] && return 0
    else
      [ "${line:0:3}" = "ii " ] && return 0
    fi
  done < <(dpkg-query -W -f="$status_fmt" "$1" 2>/dev/null)
  return 1
}

# use_mirror URL: point every Ubuntu archive source at URL, in the apt
# sources and in the mirror lists their mirror+file: URIs name.
ubuntu_uri='https?://([a-z0-9.-]+\.)?(archive|security)\.ubuntu\.com/ubuntu([/[:space:]]|$)'
use_mirror() {
  local f lists=() files=(/etc/apt/sources.list /etc/apt/sources.list.d/*.list
                          /etc/apt/sources.list.d/*.sources)
  mapfile -t lists < <(grep -ho 'mirror+file:[^[:space:]]*' "${files[@]}" 2>/dev/null \
                         | sed 's/^mirror+file://' | sort -u)
  files+=("${lists[@]}")
  if ! grep -qsE "$ubuntu_uri" "${files[@]}"; then
    echo "::warning title=apt-get::no Ubuntu archive URI left to switch in the apt sources; this attempt uses them as they are"
  fi
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    sudo sed -i -E "s#${ubuntu_uri}#${1}\3#g" "$f"
  done
  echo "apt-get: apt sources now: $(grep -hsv '^[[:space:]]*#' "${files[@]}" \
    | grep -oE '(https?|mirror\+file):[^[:space:]]+' | sort -u | tr '\n' ' ')"
}

# install_offline PACKAGE...: install from the .debs in APT_DEB_CACHE
# without the network, then check that every PACKAGE is installed.
install_offline() {
  local deb rc p here=()
  for deb in "$APT_DEB_CACHE"/*.deb; do
    [ -e "$deb" ] && here+=("$archives/${deb##*/}")
  done
  echo "apt-get: ${#here[@]} cached .debs in $APT_DEB_CACHE"
  if [ ${#here[@]} -gt 0 ]; then
    sudo cp "$APT_DEB_CACHE"/*.deb "$archives/" || return 1
    capped 150 "${apt[@]}" install -y -qq --no-download --no-remove \
      --no-install-recommends "${here[@]}"
    rc=$?
    if [ "$rc" != 0 ]; then
      echo "apt-get: the offline install $(why "$rc")"
      return 1
    fi
  fi
  for p in "$@"; do
    installed "$p" || { echo "apt-get: $p is not installed"; return 1; }
  done
}

# save_debs PACKAGE...: refill APT_DEB_CACHE with the .debs in $archives
# that are installed at their exact version, for actions/cache/save. A
# failure here only costs the cache, never the install.
save_debs() {
  [ -n "${APT_DEB_CACHE:-}" ] || return 0
  local deb pkg ver arch n=0
  if ! { mkdir -p "$APT_DEB_CACHE" \
         && rm -f "$APT_DEB_CACHE"/*.deb "$APT_DEB_CACHE/packages.txt"; }; then
    echo "::warning title=apt-get::could not empty $APT_DEB_CACHE; the .debs are not cached"
    return 0
  fi
  for deb in "$archives"/*.deb; do
    [ -e "$deb" ] || continue
    # shellcheck disable=SC2016  # dpkg-deb's format, not the shell's
    read -r pkg ver arch < <(dpkg-deb --show \
      --showformat='${Package} ${Version} ${Architecture}\n' "$deb") || continue
    installed "$pkg:$arch" "$ver" || continue
    if ! cp "$deb" "$APT_DEB_CACHE/"; then
      echo "::warning title=apt-get::could not copy $deb to $APT_DEB_CACHE; the .debs are not cached"
      return 0
    fi
    n=$((n + 1))
  done
  printf '%s\n' "$@" > "$APT_DEB_CACHE/packages.txt" || return 0
  echo "apt-get: $n .debs in $APT_DEB_CACHE to cache"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "save=true" >> "$GITHUB_OUTPUT"; fi
}

fix=()
if [ -n "${APT_DEB_CACHE:-}" ] && [ -f "$APT_DEB_CACHE/packages.txt" ]; then
  if install_offline "$@"; then
    echo "apt-get: installed $* from the cached .debs (no network)"
    save_debs "$@"
    exit 0
  fi
  echo "::warning title=apt-get::the cached .debs did not install (another runner image?); downloading instead"
  capped 60 sudo dpkg --configure -a || true
  # In case dpkg got as far as unpacking some of them.
  fix=(--fix-broken)
fi

mirrors=('' http://archive.ubuntu.com/ubuntu http://mirrors.edge.kernel.org/ubuntu)
names=("the runner's mirror" archive.ubuntu.com mirrors.edge.kernel.org)
for attempt in 1 2 3; do
  where="attempt ${attempt} of 3 (${names[attempt - 1]})"
  if [ "$((deadline - SECONDS))" -lt 60 ]; then
    echo "::warning title=apt-get::out of time (${BUDGET} s) before ${where}"
    break
  fi
  if [ "$attempt" -gt 1 ]; then
    echo "::warning title=apt-get::switching the Ubuntu sources to ${mirrors[attempt - 1]}"
    use_mirror "${mirrors[attempt - 1]}"
  fi
  capped 60 "${apt[@]}" update -qq
  rc=$?
  if [ "$rc" = 124 ]; then
    echo "::warning title=apt-get::${where}: apt-get update $(why "$rc")"
  else
    # A failed update (e.g. one bad third-party source) may still have
    # refreshed the Ubuntu lists: try the install anyway.
    if [ "$rc" != 0 ]; then
      echo "::warning title=apt-get::${where}: apt-get update $(why "$rc"); trying the install anyway"
    fi
    capped 150 "${apt[@]}" install -y -qq --no-install-recommends "${fix[@]}" "$@"
    rc=$?
    if [ "$rc" = 0 ]; then
      save_debs "$@"
      exit 0
    fi
    echo "::warning title=apt-get::${where}: apt-get install $(why "$rc")"
  fi
  if [ "$attempt" -lt 3 ]; then
    capped 60 sudo dpkg --configure -a || true
    sleep 5
  fi
done
echo "::error title=apt-get::installing $* failed on every mirror tried within ${BUDGET} s (the runner's, archive.ubuntu.com, mirrors.edge.kernel.org); see the apt-get warnings above"
exit 1
