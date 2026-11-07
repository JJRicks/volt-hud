#!/bin/sh
# render-frames.sh <project.aep> <n> : aerender RQ items 1..n (single TIFF+alpha frames), then write
# <base>-fK.png (alpha kept) and <base>-fK-over.png (over a mid-grey/sky backdrop, for looking at).
AER="/Applications/Adobe After Effects 2026/aerender"
p="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; base="${p%.aep}"
for i in $(seq 1 "$2"); do
  s=$(date +%s)
  "$AER" -project "$p" -rqindex $i > "$base-rq$i.log" 2>&1; rc=$?
  echo "rq$i rc=$rc wall=$(( $(date +%s) - s ))s"
done
for t in "$base"-f*-*.tif; do
  [ -f "$t" ] || continue
  k=$(echo "$t" | sed -E 's/.*-f([0-9]+)-[0-9]+\.tif/\1/')
  ffmpeg -loglevel error -y -i "$t" "$base-f$k.png"
  ffmpeg -loglevel error -y -i "$t" -filter_complex "[0]split[a][b];[a]geq=r='90+40*Y/H':g='110+30*Y/H':b='125+10*Y/H',format=rgb24[bg];[bg][b]overlay" -frames:v 1 "$base-f$k-over.png"
  rm "$t"
done
rm -rf "$p Logs"
ls "$base"-f*.png
