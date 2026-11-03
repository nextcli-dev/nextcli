#!/usr/bin/env bash
# Records the VS Code README demo GIFs into extensions/vscode/media/readme/.
#
# usage (from extensions/vscode):
#   DEMO_CONFIG_DIR=<dir with config.yaml and .env> e2e/demo/record.sh [scene ...]
#
# Scenes: agent chat edit autocomplete (default: all). See e2e/demo/README.md.
set -euo pipefail

cd "$(dirname "$0")/../.."
SCENES=("$@")
[ ${#SCENES[@]} -eq 0 ] && SCENES=(agent chat edit autocomplete)

# The same gpt-fast commit the GIFs were recorded on; the scenes use its line numbers.
GPT_FAST_SHA=6ecad9b5b6b987d17ac4303965545873d0192086

fail() {
  echo "record.sh: $*" >&2
  exit 1
}

[ "$(uname)" = Darwin ] || fail "macOS only (the GIFs use macOS window chrome and Cmd shortcuts)"
for cmd in git npm ffmpeg uv; do
  command -v "$cmd" >/dev/null || fail "$cmd is required"
done
[ -n "${DEMO_CONFIG_DIR:-}" ] && [ -f "$DEMO_CONFIG_DIR/config.yaml" ] ||
  fail "set DEMO_CONFIG_DIR to a directory containing config.yaml (and .env if it uses secrets)"

WORK=$(mktemp -d)
# WORK holds a copy of the .env with API keys, so always remove it.
trap 'rm -rf "$WORK"' EXIT
# Screenshots per scene; set DEMO_FRAMES_DIR to keep them, e.g. to debug a failed scene.
FRAMES=${DEMO_FRAMES_DIR:-$WORK/frames}

# Extension: DEMO_VSIX, or the macOS build from the latest stable VS Code release.
VSIX=${DEMO_VSIX:-}
if [ -z "$VSIX" ]; then
  command -v gh >/dev/null || fail "gh is required to download the VSIX (or set DEMO_VSIX)"
  case "$(uname -m)" in
    arm64) ARCH=darwin-arm64 ;;
    *) ARCH=darwin-x64 ;;
  esac
  # Stable tags are vscode-vX.Y.Z; releases before 1.4.2 used vX.Y.Z-vscode.
  TAG=$(gh release list -R nextcli-dev/nextcli --limit 50 --exclude-pre-releases --json tagName \
    --jq '[.[] | select(.tagName | test("^vscode-v|-vscode$"))][0].tagName')
  echo "Downloading nextcli-$ARCH from $TAG"
  gh release download "$TAG" -R nextcli-dev/nextcli --pattern "nextcli-$ARCH-*.vsix" --dir "$WORK/vsix"
  VSIX=$(ls "$WORK"/vsix/*.vsix)
fi

# Demo project.
PROJECT="$WORK/gpt-fast"
git clone --quiet https://github.com/meta-pytorch/gpt-fast.git "$PROJECT"
git -C "$PROJECT" checkout --quiet -B main "$GPT_FAST_SHA"

# VS Code and ChromeDriver for vscode-extension-tester (kept in the gitignored e2e/storage).
if [ ! -d "e2e/storage/Visual Studio Code.app" ]; then
  npm run e2e:get-vscode
  npm run e2e:get-chromedriver
  npm run e2e:sign-vscode
fi
# VS Code keeps an IPC socket in its profile (e2e/storage/settings) and fails to
# start if that socket path is longer than 103 characters.
STORAGE=$(cd e2e/storage && pwd -P)
[ ${#STORAGE} -le 75 ] ||
  fail "$STORAGE is too long for VS Code's IPC socket; use a checkout at a shorter path"
npx extest install-vsix -f "$VSIX" --extensions_dir "$WORK/extensions" --storage "$STORAGE"

# Clean global dir: only the model config, no rules, history or sessions.
mkdir -p "$WORK/global"
cp "$DEMO_CONFIG_DIR/config.yaml" "$WORK/global/"
[ -f "$DEMO_CONFIG_DIR/.env" ] && cp "$DEMO_CONFIG_DIR/.env" "$WORK/global/"
touch "$WORK/global/.onboarding_complete"

npm run -s e2e:compile
mkdir -p media/readme

for scene in "${SCENES[@]}"; do
  echo "== $scene"
  git -C "$PROJECT" checkout --quiet -- .
  if [ "$scene" = autocomplete ]; then
    # Leave line 264 for autocomplete to finish, as in the original GIF.
    sed -i '' "264s/.*/    parser.add_argument('--max_seq_length'/" "$PROJECT/eval.py"
  fi

  # A shell started from a VS Code terminal or extension inherits
  # ELECTRON_RUN_AS_NODE=1, which makes the downloaded VS Code run as plain Node.
  env -u ELECTRON_RUN_AS_NODE \
    CONTINUE_GLOBAL_DIR="$WORK/global" \
    DEMO_OUT="$FRAMES" \
    DEMO_PROJECT="$PROJECT" \
    DEMO_SCENE="$scene" \
    NODE_ENV=e2e \
    npx extest run-tests ./e2e/_output/demo/ReadmeDemo.test.js \
    --code_settings e2e/demo/settings.json \
    --extensions_dir "$WORK/extensions" \
    --storage "$STORAGE"

  uv run --quiet --no-project --with pillow --with numpy \
    python e2e/demo/compose.py "$FRAMES/$scene" "media/readme/$scene.gif"
done
