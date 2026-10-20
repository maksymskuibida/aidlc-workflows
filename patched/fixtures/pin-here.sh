#!/bin/bash
# Register the current checkout's pin to an installed build: `aidlc config --pin <version>`, waiting
# while another session's aidlc holds the machine-wide transaction lock. Fails loudly with what aidlc
# said (it reports a refusal on stdout), so a fixture never runs on in an unpinned checkout.
# Usage: pin-here.sh <version>
out=""
for try in 1 2 3 4 5 6 7 8 9 10; do
  out=$(AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 aidlc config --pin "$1" --yes 2>&1) && exit 0
  case "$out" in *"another AI-DLC mutation holds"*) sleep 3;; *) break;; esac
done
echo "pin-here: aidlc config --pin $1 in $PWD failed: $out" >&2
exit 1
