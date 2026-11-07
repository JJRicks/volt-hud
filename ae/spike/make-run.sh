#!/bin/sh
# make-run.sh <mode> <data.json> <out.aep> <wrapper.jsx> : writes a wrapper JSX that sets globals and evals build-hud.jsx
here="$(cd "$(dirname "$0")" && pwd)"
abs() { case "$1" in /*) echo "$1";; *) echo "$(pwd)/$1";; esac; }
cat > "$4" <<J
var VH_MODE = "$1"; var VH_DATA = "$(abs "$2")"; var VH_OUT = "$(abs "$3")";
\$.evalFile("$here/jsx/build-hud.jsx");
J
