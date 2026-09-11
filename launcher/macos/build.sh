#!/bin/zsh
# Build ProdDash.app — the whole application: launcher, server and its own
# Node runtime, with nothing to install first.
#
#   ./build.sh                 build/ProdDash.app, self-contained
#   ./build.sh --dmg           …and build/ProdDash-<version>-arm64.dmg
#   ./build.sh --install       …and copy it to /Applications
#   ./build.sh --run           …and launch it
#   ./build.sh --notarize      with --dmg: notarise and staple (needs a
#                              Developer ID and a notarytool keychain profile)
#   ./build.sh --dev           launcher only — no Node, no server payload, so
#                              it runs against the checkout. Seconds, not
#                              minutes, while working on the launcher itself.
#
# Signing: a "Developer ID Application" certificate is used when one is
# installed (override with CODESIGN_IDENTITY). Without one the app is signed
# ad-hoc, which is fine on your own Macs but makes another Mac ask before it
# will open the app.
#
# Needs the Xcode command line tools. Everything else it fetches or builds.
set -e -u
cd "$(dirname "$0")"

APP_NAME="ProdDash"
BUNDLE_ID="org.waterschurch.proddash"
LAUNCHER_VERSION="1.0.0"
# The Node the app ships. Bump it here; the download is checksum-verified
# against nodejs.org's own SHASUMS256.txt and cached in .cache/.
NODE_VERSION="v24.21.0"
ARCH="arm64"
DEPLOYMENT_TARGET="13.0"

REPO_ROOT="../.."
OUT_DIR="build"
CACHE_DIR=".cache"
APP="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"
PAYLOAD="$CONTENTS/Resources/app"

DEV=0
INSTALL=0
RUN=0
MAKE_DMG=0
NOTARIZE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) DEV=1 ;;
    --install) INSTALL=1 ;;
    --run) RUN=1 ;;
    --dmg) MAKE_DMG=1 ;;
    --notarize) NOTARIZE=1; MAKE_DMG=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "build.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

command -v swiftc >/dev/null || {
  echo "build.sh: swiftc not found — install the Xcode command line tools:" >&2
  echo "          xcode-select --install" >&2
  exit 1
}

# The product's version is ProdDash's own; the launcher keeps its own number
# for when something is wrong with the launcher rather than the dashboard.
VERSION=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)
[[ -n "$VERSION" ]] || { echo "build.sh: can't read the version from package.json" >&2; exit 1; }

echo "ProdDash $VERSION (launcher $LAUNCHER_VERSION) — building for $ARCH"

rm -rf "$OUT_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

# ── the launcher ─────────────────────────────────────────────────────────
echo "  compiling the launcher"
swiftc -O -whole-module-optimization \
  -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
  -module-name ProdDashLauncher \
  -o "$CONTENTS/MacOS/$APP_NAME" \
  Sources/*.swift

cp Resources/Info.plist "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$CONTENTS/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$CONTENTS/Info.plist" >/dev/null
/usr/libexec/PlistBuddy -c "Set :ProdDashLauncherVersion $LAUNCHER_VERSION" "$CONTENTS/Info.plist" >/dev/null
printf 'APPL????' > "$CONTENTS/PkgInfo"

SOURCE_ICON="$REPO_ROOT/public/icons/icon-512.png"
if [[ -f "$SOURCE_ICON" ]]; then
  echo "  building the icon"
  ICONSET="$OUT_DIR/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size "$SOURCE_ICON" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null 2>&1
  done
  mv "$ICONSET/icon_32x32.png"     "$ICONSET/icon_16x16@2x.png"
  cp "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32@2x.png"
  mv "$ICONSET/icon_64x64.png"     "$ICONSET/icon_32x32.png"
  cp "$ICONSET/icon_256x256.png"   "$ICONSET/icon_128x128@2x.png"
  cp "$ICONSET/icon_512x512.png"   "$ICONSET/icon_256x256@2x.png"
  mv "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
  rm -rf "$ICONSET"
fi

# ── the server, and the Node that runs it ────────────────────────────────
if [[ $DEV -eq 0 ]]; then
  TARBALL="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
  mkdir -p "$CACHE_DIR"
  if [[ ! -f "$CACHE_DIR/$TARBALL" ]]; then
    echo "  fetching Node $NODE_VERSION (~50 MB, cached for next time)"
    curl -fsSL --retry 3 -o "$CACHE_DIR/$TARBALL.part" "https://nodejs.org/dist/$NODE_VERSION/$TARBALL"
    mv "$CACHE_DIR/$TARBALL.part" "$CACHE_DIR/$TARBALL"
  fi
  SUMS="$CACHE_DIR/SHASUMS256-$NODE_VERSION.txt"
  [[ -f "$SUMS" ]] || curl -fsSL --retry 3 -o "$SUMS" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  # This binary is about to be signed with your name on it — check it every build.
  WANT=$(awk -v f="$TARBALL" '$2 == f {print $1}' "$SUMS")
  GOT=$(shasum -a 256 "$CACHE_DIR/$TARBALL" | awk '{print $1}')
  if [[ -z "$WANT" || "$WANT" != "$GOT" ]]; then
    echo "build.sh: $TARBALL does not match nodejs.org's checksum — refusing to ship it" >&2
    exit 1
  fi
  echo "  embedding Node $NODE_VERSION"
  mkdir -p "$CONTENTS/Resources/node/bin"
  tar -xzf "$CACHE_DIR/$TARBALL" -C "$CONTENTS/Resources/node/bin" --strip-components 2 \
    "node-$NODE_VERSION-darwin-$ARCH/bin/node"

  echo "  embedding ProdDash $VERSION"
  mkdir -p "$PAYLOAD/config"
  cp "$REPO_ROOT/server.js" "$REPO_ROOT/package.json" "$PAYLOAD/"
  cp -R "$REPO_ROOT/public" "$REPO_ROOT/modules" "$PAYLOAD/"
  # Only the checked-in defaults: config/ also holds this machine's own
  # modules.json and layouts when ProdDash has ever run from the checkout.
  cp "$REPO_ROOT/config/proddash.json" "$PAYLOAD/config/"
  find "$PAYLOAD" -name '.DS_Store' -delete

  # A module's native helper is built here, so the Mac running ProdDash needs
  # no compiler: <name>.swift beside a module's files becomes <name>.
  for source in "$PAYLOAD"/modules/*/*.swift; do
    [[ -e "$source" ]] || continue
    helper="${source%.swift}"
    echo "  compiling $(basename "$(dirname "$source")")/$(basename "$helper")"
    swiftc -O -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" -o "$helper" "$source"
  done
fi

# ── signing ──────────────────────────────────────────────────────────────
IDENTITY="${CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Developer ID Application/ {print $2; exit}')
fi
if [[ -n "$IDENTITY" ]]; then
  echo "  signing as $IDENTITY"
  SIGN=(--force --sign "$IDENTITY" --options runtime --timestamp)
else
  echo "  signing ad-hoc (no Developer ID installed — other Macs will ask before opening it)"
  IDENTITY="-"
  SIGN=(--force --sign -)
fi

# Nested code first, outermost last, or the outer signature seals a lie.
if [[ -f "$CONTENTS/Resources/node/bin/node" ]]; then
  codesign "${SIGN[@]}" --entitlements Resources/node.entitlements "$CONTENTS/Resources/node/bin/node"
fi
if [[ $DEV -eq 0 ]]; then
  for helper in "$PAYLOAD"/modules/*/*; do
    # A compiled helper is the extensionless executable beside a module's
    # sources — test the name, not the path, which has dots all over it.
    name=$(basename "$helper")
    [[ -f "$helper" && -x "$helper" && "$name" != *.* ]] || continue
    echo "  signing $name"
    codesign "${SIGN[@]}" --entitlements Resources/helper.entitlements "$helper"
  done
fi
codesign "${SIGN[@]}" --entitlements Resources/ProdDash.entitlements --identifier "$BUNDLE_ID" "$APP"
codesign --verify --deep --strict "$APP" && echo "  signature verifies"

SIZE=$(du -sh "$APP" | awk '{print $1}')
echo "built $APP ($SIZE)"

# ── disk image ───────────────────────────────────────────────────────────
if [[ $MAKE_DMG -eq 1 ]]; then
  DMG="$OUT_DIR/$APP_NAME-$VERSION-$ARCH.dmg"
  STAGE="$OUT_DIR/dmg"
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"     # drag-to-install, the usual way
  hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$STAGE" \
    -ov -format UDZO -quiet "$DMG"
  rm -rf "$STAGE"
  [[ "$IDENTITY" == "-" ]] || codesign --force --sign "$IDENTITY" --timestamp "$DMG"
  echo "built $DMG ($(du -sh "$DMG" | awk '{print $1}'))"

  if [[ $NOTARIZE -eq 1 ]]; then
    if [[ "$IDENTITY" == "-" ]]; then
      echo "build.sh: can't notarise an ad-hoc signed app — a Developer ID is required" >&2
      exit 1
    fi
    PROFILE="${NOTARY_PROFILE:-proddash}"
    echo "  notarising as keychain profile \"$PROFILE\" (a few minutes)"
    xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
    xcrun stapler staple "$DMG"
    echo "  notarised and stapled — this opens anywhere with no warning"
  fi
fi

if [[ $INSTALL -eq 1 ]]; then
  DEST="/Applications/$APP_NAME.app"
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "installed $DEST"
  APP="$DEST"
fi

[[ $RUN -eq 1 ]] && open "$APP"
exit 0
