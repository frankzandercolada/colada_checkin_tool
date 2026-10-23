#!/usr/bin/env bash
# Builds distributable packages for colada365 Check-in.
#
#   bash packaging/build-dist.sh              # all platforms
#   bash packaging/build-dist.sh linux        # linux only (x64 + arm64)
#   bash packaging/build-dist.sh macos windows
#
# Output: dist/colada-checkin-<version>-<platform>.tar.gz|zip
# Each package contains a self-contained binary (Node runtime embedded — the
# target machine needs nothing installed) plus an installer/uninstaller.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NODE_TARGET=node22
PLATFORMS=("$@")
[ ${#PLATFORMS[@]} -eq 0 ] && PLATFORMS=(linux macos windows)

BIN_OUT=dist/bin
STAGE=dist/stage
rm -rf "$BIN_OUT" "$STAGE"
mkdir -p "$BIN_OUT" "$STAGE" dist

targets=()
for p in "${PLATFORMS[@]}"; do
  case "$p" in
    linux)   targets+=("$NODE_TARGET-linux-x64" "$NODE_TARGET-linux-arm64");;
    macos)   targets+=("$NODE_TARGET-macos-x64" "$NODE_TARGET-macos-arm64");;
    windows) targets+=("$NODE_TARGET-win-x64");;
    *) echo "Unknown platform: $p (use linux|macos|windows)"; exit 1;;
  esac
done

echo "→ Building binaries: ${targets[*]}"
IFS=,; TARGET_CSV="${targets[*]}"; unset IFS
# Build from a CLEAN staging copy containing only server/, public/ and
# package.json — pkg's static analysis follows fs references and must never
# get the chance to embed config.json or the data/ directory (credentials!).
BUILD_SRC=dist/build-src
BIN_OUT_ABS="$(pwd)/$BIN_OUT"
rm -rf "$BUILD_SRC"; mkdir -p "$BUILD_SRC"
cp -R server public package.json "$BUILD_SRC/"
ln -sfn "$(pwd)/node_modules" "$BUILD_SRC/node_modules"
# --no-bytecode (+ --public/--public-packages, which it requires) ships plain
# JS instead of V8 bytecode — bytecode is host-specific and cross-compiled
# binaries would crash on the target OS. It also skips pkg's bytecode step,
# which runs the target-arch node and so needed Rosetta for the x64 targets.
(cd "$BUILD_SRC" && npx -y @yao-pkg/pkg . --no-bytecode --public --public-packages "*" --targets "$TARGET_CSV" --out-path "$BIN_OUT_ABS")
rm -rf "$BUILD_SRC"

# Guard: abort if any credential from the local config/data ended up in a binary
echo "→ Scanning binaries for leaked credentials"
SECRETS=$(node -e '
const fs = require("fs");
const out = new Set();
const grab = o => { for (const k of ["clientSecret", "clientId"]) if (o && o[k]) out.add(o[k]); };
try { grab(JSON.parse(fs.readFileSync("config.json", "utf8"))); } catch(e) {}
try { JSON.parse(fs.readFileSync("data/projects.json", "utf8")).forEach(grab); } catch(e) {}
console.log([...out].join("\n"));')
for bin in "$BIN_OUT"/*; do
  while IFS= read -r sec; do
    [ -z "$sec" ] && continue
    if grep -qa -- "$sec" "$bin"; then
      echo "❌ SECURITY: credential string found in $(basename "$bin") — aborting build."
      exit 1
    fi
  done <<< "$SECRETS"
done
echo "   ✓ no local credentials found in any binary"

# pkg names outputs <name>-<platform>-<arch>[.exe]
package_tar() { # $1=binary  $2=platform-dir-with-installers  $3=archive-suffix
  local bin="$1" extras="$2" suffix="$3"
  local name="colada-checkin-$VERSION-$suffix"
  local dir="$STAGE/$name"
  mkdir -p "$dir"
  cp "$bin" "$dir/colada-checkin"
  chmod 0755 "$dir/colada-checkin"
  cp "$extras"/* "$dir/"
  chmod 0755 "$dir"/*.sh 2>/dev/null || true
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "dist/$name.tar.gz" -C "$STAGE" "$name" 2>/dev/null || tar -czf "dist/$name.tar.gz" -C "$STAGE" "$name"
  echo "   dist/$name.tar.gz"
}

echo "→ Assembling packages"
for p in "${PLATFORMS[@]}"; do
  case "$p" in
    linux)
      package_tar "$BIN_OUT/colada365-checkin-linux-x64"   packaging/linux linux-x64
      package_tar "$BIN_OUT/colada365-checkin-linux-arm64" packaging/linux linux-arm64
      ;;
    macos)
      package_tar "$BIN_OUT/colada365-checkin-macos-x64"   packaging/macos macos-x64
      package_tar "$BIN_OUT/colada365-checkin-macos-arm64" packaging/macos macos-arm64
      ;;
    windows)
      name="colada-checkin-$VERSION-windows-x64"
      dir="$STAGE/$name"
      mkdir -p "$dir"
      cp "$BIN_OUT/colada365-checkin-win-x64.exe" "$dir/colada-checkin.exe"
      cp packaging/windows/*.ps1 "$dir/"
      (cd "$STAGE" && zip -qr "../../dist/$name.zip" "$name")
      echo "   dist/$name.zip"
      ;;
  esac
done

rm -rf "$STAGE"
echo ""
echo "✅ Done — packages in dist/:"
ls -lh dist/*.tar.gz dist/*.zip 2>/dev/null | awk '{print "   " $9 "  (" $5 ")"}'
