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
echo "🗜️  Creating $ZIP_FILE..."
# Lambda has no runtime dependencies (uses Node 18+ built-in fetch).
# Only @types/* devDependencies exist, so node_modules isn't needed at runtime;
# include it only if it grew real prod deps.
if [ -d "node_modules" ] && [ -n "$(ls -A node_modules 2>/dev/null)" ] && find node_modules -mindepth 1 -maxdepth 1 -type d ! -name '@types' ! -name 'typescript' ! -name '.bin' | grep -q .; then
    zip -rq "$ZIP_FILE" index.js node_modules
else
    zip -rq "$ZIP_FILE" index.js
fi

echo ""
echo "🧹 Cleaning up temporary files..."
rm -f index.js

echo ""
echo "✅ Build complete: $ZIP_FILE ($(du -h "$ZIP_FILE" | cut -f1))"
echo ""
echo "💡 Next: ./deploy-lambda-s3.sh"
