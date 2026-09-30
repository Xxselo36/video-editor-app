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

for attempt in 1 2; do
  if timeout 120 sudo apt-get "${opts[@]}" update -qq \
     && timeout 240 sudo apt-get "${opts[@]}" install -y -qq \
          --no-install-recommends "$@"; then
    exit 0
  fi
  echo "::warning title=apt-get::attempt ${attempt} failed or timed out; retrying"
  sudo dpkg --configure -a || true
  sleep 5
done
echo "::error title=apt-get::installing $* failed twice (mirror down?)"
exit 1
