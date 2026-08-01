#!/usr/bin/env bash
# make-icons.sh — regenerate the icon set from scripts/icon-source.svg.
#
# This exists so the icon step is repeatable. init.sh generates icons too, but
# only as part of a full initialise: re-running it with --force re-prompts for
# name/slug/target, re-runs the demo-strip, rm -rf's a deploy dir and
# re-substitutes tokens across the whole tree. On an already-customised repo
# that is destructive, and "I just wanted to nudge the icon" is not worth it.
#
# The six convert invocations below are lifted verbatim from init.sh's icon
# block, with BG_COLOR resolved. Keep them in sync if that block ever changes.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BG_COLOR='#0a1128'
SRC='scripts/icon-source.svg'

command -v inkscape >/dev/null || {
  # ImageMagick's internal MSVG renderer is weak on anything beyond flat shapes,
  # and rsvg-convert is not installed here, so this is not optional.
  echo "inkscape is required to rasterise $SRC" >&2; exit 1; }
command -v convert >/dev/null || {
  echo "ImageMagick 6 'convert' is required (this fleet has IM6; 'magick' does not exist)" >&2; exit 1; }

inkscape "$SRC" --export-type=png --export-filename=icons/icon-source-1024.png -w 1024 -h 1024
echo "  rasterised $SRC -> icons/icon-source-1024.png"

cd icons
convert icon-source-1024.png -resize 192x192 -depth 8 -strip icon-192.png
convert icon-source-1024.png -resize 512x512 -depth 8 -strip icon-512.png
# Artwork at ~66% so it survives the maskable safe circle's 80% crop.
convert icon-source-1024.png -resize 676x676 -background "$BG_COLOR" \
        -gravity center -extent 1024x1024 -resize 512x512 -depth 8 -strip icon-maskable-512.png
convert icon-maskable-512.png -resize 192x192 -depth 8 -strip icon-maskable-192.png
# iOS renders transparency as black, so flatten it here rather than discovering
# it on a home screen.
convert icon-source-1024.png -resize 180x180 -background "$BG_COLOR" \
        -alpha remove -alpha off -depth 8 -strip apple-touch-icon.png
convert icon-source-1024.png -define icon:auto-resize=48,32,16 favicon.ico

if command -v pngquant >/dev/null; then
  pngquant --force --quality 65-90 --ext .png \
    icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png apple-touch-icon.png
fi

cd ..
echo "  icon set regenerated:"
ls -la icons/
