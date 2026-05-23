#!/bin/bash
# Build patched llama-addon.node from source
#
# Prerequisites:
#   1. Run `npm install` first to get node-llama-cpp and its build infrastructure
#   2. Requires cmake and C++ build tools (Xcode CLI on macOS, build-essential on Linux)
#
# Usage:
#   chmod +x vendor/llama-addon/build.sh
#   ./vendor/llama-addon/build.sh
#
# Output:
#   vendor/llama-addon/binaries/<platform>/llama-addon.node

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ADDON_SRC_DIR="$PROJECT_ROOT/node_modules/node-llama-cpp/llama/addon"
PREBUILT_DIR="$PROJECT_ROOT/node_modules/@node-llama-cpp"

echo "[build] Copying patched C++ files to node_modules..."
cp "$SCRIPT_DIR/AddonContext.h" "$ADDON_SRC_DIR/AddonContext.h"
cp "$SCRIPT_DIR/AddonContext.cpp" "$ADDON_SRC_DIR/AddonContext.cpp"
echo "[build] Patched files copied."

# Detect platform tag (mirrors node-llama-cpp naming convention)
PLATFORM=""
case "$(uname -s)" in
    Darwin)
        case "$(uname -m)" in
            arm64) PLATFORM="mac-arm64-metal" ;;
            x86_64) PLATFORM="mac-x64" ;;
            *) echo "[build] ERROR: unsupported arch $(uname -m)"; exit 1 ;;
        esac
        ;;
    Linux)
        case "$(uname -m)" in
            x86_64) PLATFORM="linux-x64" ;;
            aarch64) PLATFORM="linux-arm64" ;;
            *) echo "[build] ERROR: unsupported arch $(uname -m)"; exit 1 ;;
        esac
        ;;
    *)
        echo "[build] ERROR: unsupported OS $(uname -s)"
        exit 1
        ;;
esac
echo "[build] Platform: $PLATFORM"

# Remove existing prebuilt binary to force source compilation
PREBUILT_BINARY="$PREBUILT_DIR/$PLATFORM/bins/$PLATFORM/llama-addon.node"
if [ -f "$PREBUILT_BINARY" ]; then
    echo "[build] Removing prebuilt binary: $PREBUILT_BINARY"
    rm "$PREBUILT_BINARY"
fi

# Clean cmake build cache to ensure patched C++ files are picked up
LLAMA_DIR="$PROJECT_ROOT/node_modules/node-llama-cpp/llama"
if [ -d "$LLAMA_DIR/build" ]; then
    echo "[build] Cleaning cmake build cache..."
    rm -rf "$LLAMA_DIR/build"
fi
# Also remove localBuilds to prevent stale cached binaries
if [ -d "$LLAMA_DIR/localBuilds" ]; then
    echo "[build] Cleaning localBuilds cache..."
    rm -rf "$LLAMA_DIR/localBuilds"
fi

# Trigger build via node-llama-cpp's own infrastructure.
# getLlamaForOptions() with usePrebuiltBinaries=false will compile from source.
echo "[build] Triggering source compilation via node-llama-cpp..."
cd "$PROJECT_ROOT"
node "$SCRIPT_DIR/build-trigger.mjs"

# Find the compiled binary
# node-llama-cpp places builds in bins/ directory or uses @node-llama-cpp/<platform>
COMPILED_BINARY=""
# Check the platform-specific package first (where prebuilt would go)
if [ -f "$PREBUILT_BINARY" ]; then
    COMPILED_BINARY="$PREBUILT_BINARY"
else
    # Check localBuilds directory
    LOCAL_BUILD=$(find "$PROJECT_ROOT/node_modules/node-llama-cpp/llama/localBuilds" -name "llama-addon.node" 2>/dev/null | head -1)
    if [ -n "$LOCAL_BUILD" ]; then
        COMPILED_BINARY="$LOCAL_BUILD"
    fi
fi

# Fallback: search for any recently built llama-addon.node
if [ -z "$COMPILED_BINARY" ]; then
    COMPILED_BINARY=$(find "$PROJECT_ROOT/node_modules/node-llama-cpp" -name "llama-addon.node" 2>/dev/null | head -1)
fi

if [ -z "$COMPILED_BINARY" ]; then
    echo "[build] ERROR: could not find compiled llama-addon.node"
    exit 1
fi

echo "[build] Found compiled binary: $COMPILED_BINARY"

# Copy to vendor/binaries
OUTPUT_DIR="$SCRIPT_DIR/binaries/$PLATFORM"
mkdir -p "$OUTPUT_DIR"
cp "$COMPILED_BINARY" "$OUTPUT_DIR/llama-addon.node"

echo "[build] Done! Binary copied to: $OUTPUT_DIR/llama-addon.node"
ls -lh "$OUTPUT_DIR/llama-addon.node"

# Copy the .dylib files that our source-built .node depends on but the official
# @node-llama-cpp prebuilt package doesn't provide (it ships .so Mach-O bundles
# instead of .dylib shared libraries — Mach-O bundles can't be dlopen'd by a dylib).
# The prebuilt package DOES include libggml-base.dylib, libggml.metal.*.dylib, and
# libllama.metal.*.dylib — those are already present after npm install.
DYLIB_SRC_DIR=$(dirname "$COMPILED_BINARY")/bin
if [ -d "$DYLIB_SRC_DIR" ]; then
    for dylib in libggml-cpu.dylib libggml-blas.dylib libggml-metal.dylib; do
        if [ -f "$DYLIB_SRC_DIR/$dylib" ]; then
            cp "$DYLIB_SRC_DIR/$dylib" "$OUTPUT_DIR/$dylib"
            echo "[build] Copied $dylib to vendor"
        fi
    done
    for dylib in "$DYLIB_SRC_DIR"/libllama.metal.*.dylib "$DYLIB_SRC_DIR"/libggml.metal.*.dylib; do
        if [ -f "$dylib" ]; then
            cp "$dylib" "$OUTPUT_DIR/$(basename "$dylib")"
            echo "[build] Copied $(basename "$dylib") to vendor"
        fi
    done
else
    # Fallback: search in localBuilds
    DYLIB_SRC_DIR=$(dirname "$COMPILED_BINARY")
    for dylib in libggml-cpu.dylib libggml-blas.dylib libggml-metal.dylib; do
        FOUND=$(find "$PROJECT_ROOT/node_modules/node-llama-cpp/llama/localBuilds" -name "$dylib" 2>/dev/null | head -1)
        if [ -n "$FOUND" ]; then
            cp "$FOUND" "$OUTPUT_DIR/$dylib"
            echo "[build] Copied $dylib to vendor"
        fi
    done
    for pattern in "libllama.metal.*.dylib" "libggml.metal.*.dylib"; do
        while IFS= read -r FOUND; do
            if [ -n "$FOUND" ]; then
                cp "$FOUND" "$OUTPUT_DIR/$(basename "$FOUND")"
                echo "[build] Copied $(basename "$FOUND") to vendor"
            fi
        done < <(find "$PROJECT_ROOT/node_modules/node-llama-cpp/llama/localBuilds" -name "$pattern" 2>/dev/null)
    done
fi
