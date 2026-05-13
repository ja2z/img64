#!/bin/bash

# Build script: compiles TypeScript and produces img64.zip ready for Lambda upload.
# Zip contains index.js at the root plus production node_modules.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ZIP_FILE="img64.zip"

echo "🧹 Cleaning previous build artifacts..."
[ -f "$ZIP_FILE" ] && rm -f "$ZIP_FILE" && echo "  ✓ Removed $ZIP_FILE"
[ -d "dist" ] && rm -rf dist && echo "  ✓ Removed dist/"
[ -f "index.js" ] && rm -f index.js && echo "  ✓ Removed stale index.js"

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "🔨 Compiling TypeScript..."
npm run build

if [ ! -f "dist/index.js" ]; then
    echo "❌ Error: dist/index.js not found after compile"
    exit 1
fi

cp dist/index.js index.js
echo "  ✓ Copied index.js to root"

echo ""
echo "📦 Installing prod-only deps into a clean tree..."
# Reinstall with --omit=dev so the zip only contains runtime deps.
rm -rf node_modules
npm install --omit=dev --silent

echo ""
echo "🗜️  Creating $ZIP_FILE..."
zip -rq "$ZIP_FILE" index.js node_modules

echo ""
echo "🧹 Cleaning up temporary files..."
rm -f index.js
# Restore full deps (incl. devDeps) so subsequent `tsc` / editor tooling work
npm install --silent

echo ""
echo "✅ Build complete: $ZIP_FILE ($(du -h "$ZIP_FILE" | cut -f1))"
echo ""
echo "💡 Next: ./deploy-lambda-s3.sh"
