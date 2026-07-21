#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$project_dir/.classroom-compass/bin"
source_file="$project_dir/headless/adapters/macos-speech-adapter.swift"
plist_file="$project_dir/headless/adapters/macos-speech-adapter-Info.plist"
output_file="$output_dir/cc-macos-speech"

mkdir -p "$output_dir"
/usr/bin/swiftc -swift-version 5 "$source_file" \
  -framework Speech -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$plist_file" \
  -o "$output_file"
/usr/bin/codesign --force --sign - "$output_file" >/dev/null
chmod 700 "$output_file"
printf 'Built %s\n' "$output_file"
