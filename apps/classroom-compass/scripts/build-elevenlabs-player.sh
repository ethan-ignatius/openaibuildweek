#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(CDPATH= cd -- "$project_dir/../.." && pwd)
source_file="$project_dir/headless/audio/cc-pcm-player.swift"
binary_dir="$repository_dir/.classroom-compass/bin"
binary_file="$binary_dir/cc-pcm-player"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "The current ElevenLabs PCM player requires macOS." >&2
  exit 2
fi

mkdir -p "$binary_dir"
if [ ! -x "$binary_file" ] || [ "$source_file" -nt "$binary_file" ]; then
  xcrun swiftc "$source_file" -o "$binary_file"
fi

echo "ElevenLabs streaming audio player ready: $binary_file"
