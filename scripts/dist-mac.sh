#!/usr/bin/env bash
set -euo pipefail

# Paprwork macOS Distribution Script
# Signs, notarizes, and packages the app for direct download (outside App Store)
#
# Prerequisites:
#   - .env.build with Apple credentials (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID, CSC_NAME)
#   - Developer ID Application certificate installed in Keychain
#   - npm install already run

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# Load Apple signing credentials
if [ -f .env.build ]; then
  set -a
  source .env.build
  set +a
  echo "Loaded .env.build (APPLE_ID=$APPLE_ID, TEAM=$APPLE_TEAM_ID)"
else
  echo "ERROR: .env.build not found in $PROJECT_DIR"
  echo ""
  echo "Create .env.build with:"
  echo "  APPLE_ID=your@email.com"
  echo "  APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx"
  echo "  APPLE_TEAM_ID=XXXXXXXXXX"
  echo "  CSC_NAME=<certificate-hash>"
  echo ""
  echo "See paprwork-olderVersion/.env.build for reference."
  exit 1
fi

# Verify certificate exists
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$CSC_NAME"; then
  echo "ERROR: Certificate $CSC_NAME not found in Keychain"
  echo "Run: security find-identity -v -p codesigning | grep 'Developer ID'"
  exit 1
fi
echo "Certificate found: $(security find-identity -v -p codesigning 2>/dev/null | grep "$CSC_NAME" | sed 's/.*"\(.*\)"/\1/')"

# Build into /tmp to avoid iCloud Drive extended attributes
# ~/Documents/ is iCloud-synced — macOS fileprovider adds com.apple.FinderInfo and
# com.apple.fileprovider.fpfs#P xattrs to new directories, which breaks codesign with:
# "resource fork, Finder information, or similar detritus not allowed"
BUILD_OUTPUT="/tmp/paprwork-release"
echo ""
echo "Using non-iCloud build directory: $BUILD_OUTPUT"
rm -rf "$BUILD_OUTPUT"
rm -rf release/

# Build the app (TypeScript + Vite UI)
echo ""
echo "Building app..."
npm run build

# Strip macOS extended attributes from source dirs (belt and suspenders)
xattr -cr node_modules 2>/dev/null || true
xattr -cr dist 2>/dev/null || true
xattr -cr src/electron 2>/dev/null || true
xattr -cr build 2>/dev/null || true

# Package, sign, notarize for Apple Silicon
echo ""
echo "Packaging for macOS (arm64)..."
echo "This will: code sign -> create DMG -> notarize with Apple -> staple ticket"
echo "(Notarization typically takes 2-5 minutes)"
echo ""
npx electron-builder --mac --arm64 -c.directories.output="$BUILD_OUTPUT"

# Copy artifacts back to project for convenience
echo ""
echo "Copying artifacts to ./release/..."
mkdir -p release
cp -R "$BUILD_OUTPUT"/* release/

echo ""
echo "============================================"
echo "  Build complete! Output in ./release/"
echo "============================================"
echo ""
ls -lh release/*.dmg release/*.zip 2>/dev/null || echo "(No DMG/ZIP found - check release/ directory)"
echo ""
echo "Next steps:"
echo "  1. Verify: codesign -vvv --deep --strict release/mac-arm64/Paprwork.app"
echo "  2. Verify: spctl --assess --type execute --verbose release/mac-arm64/Paprwork.app"
echo "  3. Upload DMG to website for distribution"
