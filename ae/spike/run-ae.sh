#!/bin/sh
# run-ae.sh <mode> <data.json> <out.aep> : runs build-hud.jsx in the running AE and waits for the result
set -e
here="$(cd "$(dirname "$0")" && pwd)"
res="${3%.aep}-result.aepx"; rm -f "$res"
"$here/make-run.sh" "$1" "$2" "$3" "$here/out/run.jsx"
t0=$(date +%s)
osascript -e "tell application \"Adobe After Effects 2026\" to DoScriptFile (POSIX file \"$here/out/run.jsx\")" >/dev/null
while [ ! -f "$res" ]; do /bin/sleep 1; [ $(( $(date +%s) - t0 )) -gt 3000 ] && { echo timeout; exit 1; }; done
/bin/sleep 1
echo "wall_s=$(( $(date +%s) - t0 ))"
python3 -I "$here/read-result.py" "$res"
