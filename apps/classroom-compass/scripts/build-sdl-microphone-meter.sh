#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(CDPATH= cd -- "$project_dir/../.." && pwd)
output_dir="${CC_RUNTIME_DIR:-$repository_dir/.classroom-compass}/bin"
sdl_config=${CC_SDL2_CONFIG:-/opt/homebrew/opt/sdl2-compat/bin/sdl2-config}

if [ ! -x "$sdl_config" ]; then
  echo "SDL2 configuration was not found at $sdl_config. Install whisper-cpp first with npm run voice:setup." >&2
  exit 2
fi

mkdir -p "$output_dir"
# shellcheck disable=SC2046
clang++ -std=c++20 -O2 $($sdl_config --cflags) \
  "$project_dir/headless/adapters/sdl-microphone-meter.cpp" \
  $($sdl_config --libs) -o "$output_dir/cc-audio-meter"
