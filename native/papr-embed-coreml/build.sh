#!/bin/sh
# Builds the Neural Engine helper (arm64 macOS 15+). Output: build/papr-embed-coreml
set -e
cd "$(dirname "$0")"
mkdir -p build
swiftc -O -target arm64-apple-macos15.0 -framework CoreML main.swift -o build/papr-embed-coreml
