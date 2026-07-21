#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repository_dir=$(CDPATH= cd -- "$project_dir/../.." && pwd)
model_dir="${CC_RUNTIME_DIR:-$repository_dir/.classroom-compass}/models"
model_file="$model_dir/ggml-small.en.bin"
model_url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
expected_sha256="c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d"

if ! command -v whisper-stream >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    printf '%s\n' 'Homebrew is required. Install it, then run: brew install whisper-cpp' >&2
    exit 1
  fi
  brew install whisper-cpp
fi

mkdir -p "$model_dir"
if [ ! -f "$model_file" ]; then
  temporary_model="$model_file.download"
  trap 'rm -f "$temporary_model"' EXIT INT TERM
  curl --fail --location --progress-bar --output "$temporary_model" "$model_url"
  actual_sha256=$(shasum -a 256 "$temporary_model" | awk '{print $1}')
  if [ "$actual_sha256" != "$expected_sha256" ]; then
    printf 'Whisper model checksum mismatch: %s\n' "$actual_sha256" >&2
    exit 1
  fi
  mv "$temporary_model" "$model_file"
  trap - EXIT INT TERM
fi

actual_sha256=$(shasum -a 256 "$model_file" | awk '{print $1}')
if [ "$actual_sha256" != "$expected_sha256" ]; then
  printf 'Existing Whisper model checksum mismatch: %s\n' "$actual_sha256" >&2
  exit 1
fi

printf 'Local Whisper is ready: %s\n' "$model_file"
