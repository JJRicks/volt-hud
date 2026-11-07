#!/bin/sh
# fake-gh.sh: a stand-in for `gh` that serves releases from a local folder, for testing the Mac app's
# update path without GitHub. Layout: $VOLTHUD_FAKE_RELEASES/<tag>/<asset files> (what package-release.sh writes).
# Use: VOLTHUD_GH=/path/to/fake-gh.sh VOLTHUD_FAKE_RELEASES=/path/to/out/release <app or volthud-installer>
# VOLTHUD_FAKE_AUTH=1 pretends gh is logged out.
set -eu
R="${VOLTHUD_FAKE_RELEASES:?set VOLTHUD_FAKE_RELEASES}"
json_list() { first=1; printf '['; for d in "$R"/*/; do [ -d "$d" ] || continue; t="$(basename "$d")"
  [ $first = 1 ] || printf ','; first=0
  printf '{"tagName":"%s","isDraft":false,"isPrerelease":false,"publishedAt":"%s"}' "$t" "$(date -u -r "$d" +%Y-%m-%dT%H:%M:%SZ)"; done; printf ']\n'; }
case "${1:-} ${2:-}" in
  "auth status") exit "${VOLTHUD_FAKE_AUTH:-0}" ;;
  "release list") json_list ;;
  "release view")
    [ -d "$R/$3" ] || { echo "release not found" >&2; exit 1; }
    first=1; printf '{"assets":['; for f in "$R/$3"/*; do [ $first = 1 ] || printf ','; first=0; printf '{"name":"%s"}' "$(basename "$f")"; done; printf ']}\n' ;;
  "release download")
    tag="$3"; shift 3; out="."; pats=""
    while [ $# -gt 0 ]; do case "$1" in -D) out="$2"; shift 2 ;; -p) pats="$pats
$2"; shift 2 ;; -R) shift 2 ;; *) shift ;; esac; done
    printf '%s\n' "$pats" | while IFS= read -r p; do [ -z "$p" ] || cp "$R/$tag/$p" "$out/"; done ;;
  *) echo "fake-gh: unsupported: $*" >&2; exit 9 ;;
esac
