#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
environment_dir="$project_dir/.classroom-compass/vision-venv"
python_command=${CC_VISION_PYTHON:-python3}

if [ ! -x "$environment_dir/bin/python" ]; then
  "$python_command" -m venv "$environment_dir"
fi
"$environment_dir/bin/python" -m pip install --upgrade "rtmlib==0.0.15"
"$environment_dir/bin/python" -c 'from rtmlib import Body; Body(mode="balanced", backend="onnxruntime", device="cpu"); print("RTMPose-m and YOLOX-m are ready.")'
