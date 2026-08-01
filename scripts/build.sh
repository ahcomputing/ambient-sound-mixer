#!/usr/bin/env bash
# build.sh — assemble the shippable tree into a directory.
#
#   ./scripts/build.sh <outdir>
#
# Produces a webroot you can serve with any static server. This is the whole
# build: there is no bundler, no npm, no transpile. What it actually does is the
# two things that must never be done by hand:
#
#   1. The precache list in sw.js is GENERATED from what is really shipping.
#      A hand-maintained list drifts from the module graph and offline support
#      breaks quietly when it does.
#
#   2. The cache version is a CONTENT HASH of the build, not a counter someone
#      remembers to bump. Forgetting the bump strands every installed client on
#      old code.
#
# The audio gets its own cache, hashed over assets/ alone, so a one-line CSS
# change does not make every installed phone re-download several MB of MP3.
#
# Deployment is deliberately not here — see the project README.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="${1:-}"
[[ -n "$OUT" ]] || { echo "usage: $0 <outdir>" >&2; exit 1; }

# The output directory is emptied before use, so refuse anything that looks like
# somewhere real. `build.sh .` or a mistyped path would otherwise delete work.
OUT_ABS="$(readlink -m "$OUT")"
REPO_ABS="$(pwd -P)"
case "$OUT_ABS" in
  "$REPO_ABS"|"$REPO_ABS"/*/..*|/|"$HOME") echo "refusing to build into $OUT_ABS" >&2; exit 1 ;;
esac
[[ -e "$OUT_ABS/.git" ]] && { echo "refusing to build into a git worktree" >&2; exit 1; }

rm -rf "${OUT_ABS:?}"
mkdir -p "$OUT_ABS"
OUT="$OUT_ABS"

# NEVER substitute tokens in the working tree: that destroys them, and the
# *second* build then ships a stale constant version string — a cache that never
# invalidates again. Exactly the bug this script exists to prevent, so it must
# not commit it itself. Everything happens in the output copy.
#
# `server` is excluded pre-emptively: if this app grows a backend, its source
# must never land in a public webroot.
#
# screenshots/ is allow-listed down to the two generated files. This used to be
# a comment telling you not to leave raw material there, which is not a control:
# the phone screenshots went straight into that directory and would have
# shipped, full-resolution, alongside them. Includes must precede the exclude —
# rsync takes the first matching rule.
rsync -a \
  --exclude '.git' --exclude '.gitignore' --exclude '.github' \
  --exclude '.claude' \
  --exclude 'scripts' --exclude 'deploy' --exclude 'tests' \
  --exclude 'server' \
  --exclude '*.md' --exclude 'doc.html' \
  --exclude 'icons/icon-source-1024.png' \
  --include 'screenshots/narrow.png' --include 'screenshots/wide.png' \
  --exclude 'screenshots/*' \
  ./ "$OUT/"

# Content hash over every shipped file, paths included so a rename registers.
BUILD_ID=$(cd "$OUT" && find . -type f | LC_ALL=C sort | \
  while IFS= read -r f; do printf '%s\0' "$f"; cat "$f"; done \
  | sha256sum | cut -c1-16)

# Media is cache-first at runtime, so only the shell needs precaching — but
# icons and fonts are included because an offline first launch should not be
# missing its own icon.
#
# assets/audio/manifest.json is shell, not media: it is what the catalog is
# built from, and without it an offline cold start renders no sounds at all. It
# is .json, so it takes the networkFirst path, whose offline fallback is a cache
# lookup — which only hits because it is precached here.
PRECACHE=$(cd "$OUT" && find . -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.webmanifest' \
     -o -path './icons/*' -o -path './styles/fonts/*' \
     -o -path './assets/audio/manifest.json' \) \
  ! -name 'sw.js' ! -name 'favicon.ico' \
  | LC_ALL=C sort | sed "s|^|'|; s|$|',|" | tr '\n' ' ')
PRECACHE="'./', $PRECACHE"

# The audio, warmed separately and non-atomically — see warmMedia() in sw.js.
MEDIA=$(cd "$OUT" && find . -type f \
  \( -name '*.mp3' -o -name '*.ogg' -o -name '*.wav' \) \
  | LC_ALL=C sort | sed "s|^|'|; s|$|',|" | tr '\n' ' ')

# `-path './assets/*'` rather than `find ./assets` so a tree without assets
# returns empty instead of erroring out under `set -e`.
MEDIA_ID=$(cd "$OUT" && find . -path './assets/*' -type f | LC_ALL=C sort | \
  while IFS= read -r f; do printf '%s\0' "$f"; cat "$f"; done \
  | sha256sum | cut -c1-16)

python3 - "$OUT/sw.js" "$BUILD_ID" "$PRECACHE" "$MEDIA_ID" "$MEDIA" <<'PY'
import sys
path, build_id, precache, media_id, media = sys.argv[1:6]
s = open(path).read()
s = (s.replace('{{BUILD_ID}}', build_id)
      .replace('/*{{PRECACHE_LIST}}*/', precache)
      .replace('{{MEDIA_ID}}', media_id)
      .replace('/*{{MEDIA_LIST}}*/', media))
open(path, 'w').write(s)
PY

# A literal {{BUILD_ID}} reaching production is silent and permanent.
if grep -q '{{' "$OUT/sw.js"; then
  echo "unreplaced token left in sw.js — refusing to continue" >&2
  exit 1
fi

# The two ids go to STDOUT as one line, so a caller can capture them; anything
# human belongs on stderr. They are deliberately not written into $OUT — a file
# dropped in there after the hash is computed would ship to the webroot and be
# served, and would make the file count disagree with what was hashed.
echo "$BUILD_ID $MEDIA_ID"
