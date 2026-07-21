#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

vision_python="$project_dir/.classroom-compass/vision-venv/bin/python"
vision_adapter="$project_dir/headless/adapters/rtmpose-camera-adapter.py"
whisper_model="$project_dir/.classroom-compass/models/ggml-small.en.bin"
tsx_bin="$project_dir/../../node_modules/.bin/tsx"

if [ ! -x "$vision_python" ]; then
  echo "Vision is not installed. Run: npm run setup:room" >&2
  exit 2
fi
if ! command -v whisper-stream >/dev/null 2>&1 || [ ! -f "$whisper_model" ]; then
  echo "Local Whisper is not installed. Run: npm run setup:room" >&2
  exit 2
fi
if [ ! -x "$tsx_bin" ]; then
  echo "Workspace dependencies are missing. Run: npm install" >&2
  exit 2
fi

camera_index=${CC_CAMERA_INDEX:-1}
case "$camera_index" in
  *[!0-9]*) echo "CC_CAMERA_INDEX must be a non-negative integer." >&2; exit 2 ;;
esac

if [ "${CC_CAMERA_PREVIEW:-0}" = "1" ]; then
  CC_CAMERA_COMMAND_JSON="[\"$vision_python\",\"$vision_adapter\",\"--camera\",\"$camera_index\",\"--preview\"]"
else
  CC_CAMERA_COMMAND_JSON="[\"$vision_python\",\"$vision_adapter\",\"--camera\",\"$camera_index\"]"
fi
CC_MICROPHONE_COMMAND_JSON="[\"$tsx_bin\",\"$project_dir/headless/adapters/whisper-stream-adapter.ts\"]"

CC_TUTOR_PROVIDER=${CC_TUTOR_PROVIDER:-teacher-brain}
CC_TEACHER_BRAIN_API_URL=${CC_TEACHER_BRAIN_API_URL:-http://127.0.0.1:8000}
if [ -z "${CC_TEACHER_BRAIN_ROSTER_JSON:-}" ]; then
  CC_TEACHER_BRAIN_ROSTER_JSON='[{"studentRef":"seat:camera-left","name":"Jordan","language":"English"},{"studentRef":"seat:camera-right","name":"Sofia","language":"Spanish"},{"studentRef":"seat:camera-center","name":"Riley","language":"English"}]'
fi
CC_LESSON_TITLE=${CC_LESSON_TITLE:-Equivalent Fractions}
CC_WHISPER_CAPTURE_NAME=${CC_WHISPER_CAPTURE_NAME:-Logitech Webcam C925e|Audio Streaming|MacBook Air Microphone|Microsoft Teams Audio}
CC_WHISPER_STEP_MS=${CC_WHISPER_STEP_MS:-2000}
CC_WHISPER_WINDOW_MS=${CC_WHISPER_WINDOW_MS:-6000}
CC_WHISPER_UTTERANCE_GAP_MS=${CC_WHISPER_UTTERANCE_GAP_MS:-2400}
CC_REQUIRE_HAND_RAISE=${CC_REQUIRE_HAND_RAISE:-1}
CC_STOP_ON_SENSOR_FAILURE=${CC_STOP_ON_SENSOR_FAILURE:-1}
CC_AUDIO_OUTPUT=${CC_AUDIO_OUTPUT:-system}

export CC_CAMERA_COMMAND_JSON CC_MICROPHONE_COMMAND_JSON
export CC_TUTOR_PROVIDER CC_TEACHER_BRAIN_API_URL CC_TEACHER_BRAIN_ROSTER_JSON CC_LESSON_TITLE
export CC_WHISPER_CAPTURE_NAME CC_WHISPER_STEP_MS CC_WHISPER_WINDOW_MS CC_WHISPER_UTTERANCE_GAP_MS
export CC_REQUIRE_HAND_RAISE CC_STOP_ON_SENSOR_FAILURE CC_AUDIO_OUTPUT

exec "$tsx_bin" headless/cli.ts run
