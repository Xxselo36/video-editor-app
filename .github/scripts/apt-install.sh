#!/usr/bin/env bash
# apt-get install for CI, with short network timeouts and one retry.
#
# The runner's Ubuntu mirror sometimes stalls a download for 10+ minutes
# (seen twice in a row on 2026-09-30: the web e2e job hit its 15-min
# limit before a test ran). apt's own Acquire timeouts catch a dead
# connection; `timeout` catches a transfer that crawls. Unpacking takes
# seconds, so a stalled attempt is only ever a download and is safe to
# kill; dpkg --configure -a tidies up before the retry.
#
# Usage: .github/scripts/apt-install.sh ffmpeg espeak-ng
set -uo pipefail

opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20
      -o Acquire::https::Timeout=20 -o Dpkg::Use-Pty=0)

# The runner's own mirror (azure.archive.ubuntu.com) was down for good
# on 2026-10-01: attempt 3 switches every apt source to the main Ubuntu
# archive (archive.ubuntu.com / security.ubuntu.com).
use_main_archive() {
  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list \
           /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    sudo sed -i -E 's#https?://[a-z0-9.-]*\.?azure\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g' "$f"
  done
}

for attempt in 1 2 3; do
  if [ "$attempt" = 3 ]; then
    echo "::warning title=apt-get::switching to archive.ubuntu.com"
    use_main_archive
  fi
  if timeout 120 sudo apt-get "${opts[@]}" update -qq \
     && timeout 240 sudo apt-get "${opts[@]}" install -y -qq \
          --no-install-recommends "$@"; then
    exit 0
  fi
  echo "::warning title=apt-get::attempt ${attempt} failed or timed out; retrying"
  sudo dpkg --configure -a || true
  sleep 5
done
echo "::error title=apt-get::installing $* failed three times (mirror down?)"
exit 1
