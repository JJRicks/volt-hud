#!/bin/sh
# render-frames.sh <project.aep> : aerender RQ items 1-3 (single frames) one at a time, then TIFF -> PNG
AER="/Applications/Adobe After Effects 2026/aerender"
p="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; base="${p%.aep}"
for i in 1 2 3; do
  log="$base-rq$i.log"
  s=$(python3 -I -c 'import time;print(time.time())')
  "$AER" -project "$p" -rqindex $i > "$log" 2>&1; rc=$?
  e=$(python3 -I -c 'import time;print(time.time())')
  echo "rq$i rc=$rc wall=$(python3 -I -c "print(round($e-$s,2))")s $(grep -E 'Total Time Elapsed|PROGRESS:  [0-9]|Finished composition' "$log" | tr '\n' ' ')"
done
for t in "$base"-*.tif; do [ -f "$t" ] && ffmpeg -loglevel error -y -i "$t" "${t%.tif}.png" && rm "$t"; done
ls -la "$base"-*.png
