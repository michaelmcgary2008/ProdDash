#!/bin/zsh
# Build ProdDash.app — the menu-bar launcher.
#
#   ./build.sh                 build into launcher/macos/build/ProdDash.app
#   ./build.sh --install       …and copy it to /Applications
#   ./build.sh --run           …and launch it when it's built
#   ./build.sh --arch native   build for this Mac only (faster; default is universal)
#
# Needs the Xcode command line tools (swiftc). No other dependencies — the app
# is Swift and system frameworks, nothing to install and nothing to vendor.
set -e -u
cd "$(dirname "$0")"

APP_NAME="ProdDash"
BUNDLE_ID="org.waterschurch.proddash"
OUT_DIR="build"
APP="$OUT_DIR/$APP_NAME.app"
ARCHS=(arm64 x86_64)
INSTALL=0
RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --run) RUN=1 ;;
    --arch) shift; [[ "${1:-}" == "native" ]] && ARCHS=($(uname -m)) || ARCHS=("${1:-arm64}") ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

if ! command -v swiftc >/dev/null; then
  echo "build.sh: swiftc not found — install the Xcode command line tools:" >&2
  echo "          xcode-select --install" >&2
  exit 1
fi

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Resources/Info.plist)
echo "ProdDash Launcher $VERSION — building for ${ARCHS[*]}"

rm -rf "$OUT_DIR"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT_DIR/obj"

# One binary per architecture, then lipo them together, so the same .app runs
# on the booth's Apple Silicon and on any Intel Mac still in service.
SLICES=()
for arch in "${ARCHS[@]}"; do
  echo "  compiling $arch"
  swiftc -O -whole-module-optimization \
    -target "$arch-apple-macos13.0" \
    -module-name ProdDashLauncher \
    -o "$OUT_DIR/obj/$APP_NAME-$arch" \
    Sources/*.swift
  SLICES+=("$OUT_DIR/obj/$APP_NAME-$arch")
done

if [[ ${#SLICES[@]} -gt 1 ]]; then
  lipo -create "${SLICES[@]}" -output "$APP/Contents/MacOS/$APP_NAME"
else
  cp "${SLICES[1]}" "$APP/Contents/MacOS/$APP_NAME"
fi
chmod +x "$APP/Contents/MacOS/$APP_NAME"

cp Resources/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# App icon: ProdDash's own, straight from the web app's icons.
SOURCE_ICON="../../public/icons/icon-512.png"
if [[ -f "$SOURCE_ICON" ]]; then
  echo "  building the icon"
  ICONSET="$OUT_DIR/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size "$SOURCE_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
  done
  # iconutil wants Apple's names, including the @2x pairs.
  mv "$ICONSET/icon_32x32.png"     "$ICONSET/icon_16x16@2x.png"
  cp "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32@2x.png"
  mv "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32.png"
  cp "$ICONSET/icon_256x256.png"   "$ICONSET/icon_128x128@2x.png"
  cp "$ICONSET/icon_512x512.png"   "$ICONSET/icon_256x256@2x.png"
  mv "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
else
  echo "  (no $SOURCE_ICON — the app will use the generic icon)"
fi

rm -rf "$OUT_DIR/obj"

# Ad-hoc signature: enough for macOS to run it and to hang privacy permissions
# off it. Note that the signature changes on every rebuild, so macOS may treat
# a rebuilt app as a new one and ask for the microphone again.
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP" >/dev/null 2>&1 \
  && echo "  signed (ad-hoc)" \
  || echo "  warning: could not sign the app — permissions may not stick"

echo "built $APP"

if [[ $INSTALL -eq 1 ]]; then
  DEST="/Applications/$APP_NAME.app"
  # A running copy holds its own bundle open; stop it before replacing it.
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "installed $DEST"
  APP="$DEST"
fi

if [[ $RUN -eq 1 ]]; then
  open "$APP"
fi
