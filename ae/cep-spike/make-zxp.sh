#!/bin/sh
# make-zxp.sh <ZXPSignCmd> <workdir> : stage ext/ + bundled node_modules (no symlinks), self-sign, write <workdir>/volthud-cepspike.zxp
set -e
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/../.." && pwd)"
Z="$1"; W="$2"; mkdir -p "$W"; rm -rf "$W/stage" "$W/volthud-cepspike.zxp"
cp -R "$here/ext" "$W/stage"
mkdir -p "$W/stage/node_modules"
for m in gopro-telemetry binary-parser; do cp -RL "$repo/node_modules/$m" "$W/stage/node_modules/$m"; done
find "$W/stage" -name .DS_Store -delete
[ -z "$(find "$W/stage" -type l)" ] || { echo "symlinks present"; exit 1; }
# throwaway self-signed cert, generated per build in the workdir (never committed)
[ -f "$W/selfsigned.p12" ] || "$Z" -selfSignedCert US ID "Volt HUD spike" "Volt HUD spike" spikepass "$W/selfsigned.p12"
"$Z" -sign "$W/stage" "$W/volthud-cepspike.zxp" "$W/selfsigned.p12" spikepass
"$Z" -verify "$W/volthud-cepspike.zxp"
ls -la "$W/volthud-cepspike.zxp"
