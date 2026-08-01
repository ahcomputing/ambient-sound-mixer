#!/usr/bin/env bash
# install-screenshots.sh — turn real phone screenshots into the manifest assets.
#
#   ./scripts/install-screenshots.sh shot-1.png shot-2.png shot-3.png
#
# Take them on the ACTUAL PHONE. Android's rich install dialog does not appear
# at all while the manifest still points at the template's placeholders, and a
# desktop browser faking a phone viewport makes worse source material than the
# real device.
#
# The first image becomes the narrow (phone) screenshot; up to three are tiled
# side by side for the wide (desktop) one, which Chrome wants in landscape and
# a phone cannot produce on its own.
#
# Images are SCALED TO FIT and padded with the app's own background colour,
# never stretched — a distorted screenshot in the install dialog looks broken.
#
# The manifest's `sizes` must match the files byte-for-byte or Chrome silently
# ignores the screenshots and falls back to the plain install prompt, so the
# output dimensions here are fixed to what manifest.webmanifest declares.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WIDE_W=1920;   WIDE_H=1080
BG="#0a1128"                  # --color-bg / manifest background_color

# The narrow screenshot keeps the phone's OWN dimensions — no scaling, no
# letterboxing, real pixels. The manifest is then rewritten to match, because
# the two agreeing is the thing Chrome actually cares about.
#
# Chrome's rich install dialog also requires the long side to be at most 2.3x
# the short side. A 1080x2400 phone is 2.22, which just fits; a taller one
# would not, so the ratio is checked below rather than assumed.

GREEN=$'\033[32m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
die() { echo "${RED}✗${RESET}  $*" >&2; exit 1; }

(( $# >= 1 )) || die "usage: $0 <phone-screenshot.png> [more.png ...]"
command -v convert >/dev/null || die "ImageMagick 'convert' not found"

for f in "$@"; do [[ -f "$f" ]] || die "no such file: $f"; done

# ── narrow: the phone screenshot, untouched ────────────────────────────────
# The \n matters: without a trailing newline `read` returns non-zero at EOF
# even though it assigned both variables, and set -e kills the script silently.
read -r NARROW_W NARROW_H < <(identify -format '%w %h\n' "$1")
LONG=$(( NARROW_H > NARROW_W ? NARROW_H : NARROW_W ))
SHORT=$(( NARROW_H > NARROW_W ? NARROW_W : NARROW_H ))
(( LONG * 10 <= SHORT * 23 )) \
  || die "$1 is ${NARROW_W}x${NARROW_H}; Chrome needs the long side ≤ 2.3x the short one"

convert "$1" -strip screenshots/narrow.png
echo "${GREEN}✓${RESET}  screenshots/narrow.png  ${DIM}${NARROW_W}x${NARROW_H}, native, from $(basename "$1")${RESET}"

# ── wide: up to three tiled, so the landscape asset is still real pixels ───
COUNT=$(( $# > 3 ? 3 : $# ))
TILE_W=$(( WIDE_W / COUNT ))
convert "${@:1:$COUNT}" \
        -resize "$(( TILE_W - 40 ))x$(( WIDE_H - 80 ))" \
        -background "$BG" -gravity center -extent "${TILE_W}x${WIDE_H}" \
        +append -background "$BG" -gravity center -extent "${WIDE_W}x${WIDE_H}" \
        -strip screenshots/wide.png
echo "${GREEN}✓${RESET}  screenshots/wide.png    ${DIM}${COUNT} tiled${RESET}"

# ── keep the manifest honest ───────────────────────────────────────────────
# A `sizes` that disagrees with the file makes Chrome drop the screenshot
# silently and fall back to the plain install prompt — the exact bug this
# script exists to fix — so the manifest is rewritten from the files, never
# maintained alongside them.
python3 - "${NARROW_W}x${NARROW_H}" "${WIDE_W}x${WIDE_H}" <<'PY'
import re, sys
narrow, wide = sys.argv[1], sys.argv[2]
path = 'manifest.webmanifest'
text = open(path).read()
for name, size in (('narrow', narrow), ('wide', wide)):
    text = re.sub(
        r'("src": "\./screenshots/%s\.png", "sizes": ")[0-9]+x[0-9]+(")' % name,
        r'\g<1>%s\g<2>' % size, text)
open(path, 'w').write(text)
PY

for pair in "narrow ${NARROW_W}x${NARROW_H}" "wide ${WIDE_W}x${WIDE_H}"; do
  name="${pair%% *}"; want="${pair##* }"
  got=$(identify -format '%wx%h' "screenshots/$name.png")
  [[ "$got" == "$want" ]] || die "$name.png is $got but $want was expected"
  grep -q "\"src\": \"./screenshots/$name.png\", \"sizes\": \"$want\"" manifest.webmanifest \
    || die "manifest still does not declare $name.png at $want"
done
python3 -c 'import json;json.load(open("manifest.webmanifest"))' \
  || die "manifest.webmanifest is no longer valid JSON"

echo "${GREEN}✓${RESET}  manifest.webmanifest updated and still valid JSON"
echo "${DIM}   next: ./scripts/deploy.sh${RESET}"
