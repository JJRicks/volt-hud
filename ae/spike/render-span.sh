#!/bin/sh
# render-span.sh <project.aep> <startFrame> <frames> <out.mov> : aerender a span of the VOLT HUD comp to ProRes 4444 + alpha
AER="/Applications/Adobe After Effects 2026/aerender"
p="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
o="$(cd "$(dirname "$4")" && pwd)/$(basename "$4")"; rm -f "$o"
s=$(python3 -I -c 'import time;print(time.time())')
"$AER" -project "$p" -comp "VOLT HUD" -s "$2" -e $(( $2 + $3 - 1 )) -RStemplate "Best Settings" -OMtemplate "High Quality with Alpha" -output "$o" > "${o%.mov}.log" 2>&1; rc=$?
e=$(python3 -I -c 'import time;print(time.time())')
echo "$(basename "$o") frames=$3 rc=$rc wall=$(python3 -I -c "print(round($e-$s,2))")s $(grep -o 'Total Time Elapsed: [0-9]* Seconds' "${o%.mov}.log")"
rm -rf "${p} Logs"
