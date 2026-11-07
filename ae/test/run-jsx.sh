#!/bin/sh
# run-jsx.sh <wrapper.jsx> <result.aepx> [timeout_s]
# Runs a JSX file in the running After Effects 2026 (DoScriptFile is async and returns "0"),
# then waits for the script to save <result.aepx> and prints the JSON in its VH_RESULT folder comment.
# AE's "Allow Scripts to Write Files" pref stays off: results travel in a tiny XML project.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
jsx="$1"; res="$2"; to="${3:-3000}"
rm -f "$res"
t0=$(date +%s)
osascript -e "tell application \"Adobe After Effects 2026\" to DoScriptFile (POSIX file \"$jsx\")" >/dev/null
while [ ! -f "$res" ]; do /bin/sleep 1; [ $(( $(date +%s) - t0 )) -gt "$to" ] && { echo timeout; exit 1; }; done
/bin/sleep 1
echo "wall_s=$(( $(date +%s) - t0 ))"
python3 -I "$here/read-result.py" "$res"
