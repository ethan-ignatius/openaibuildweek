# Teacher Brain + Classroom Compass

This repository combines the Teacher Brain reasoning harness from `main` with the
Classroom Compass live vision, audio, tutoring, and projector runtime from the
`vision-audio` work.

Teacher Brain supplies teacher-authored lesson planning, learner context,
schema-validated board actions, interruption-aware lesson orchestration, bilingual
responses, journaling, replay, and external-ground-truth evaluations. Classroom
Compass supplies the local classroom loop: RTMPose multi-person hand raises,
Whisper transcription, turn gating, age-appropriate tutoring, comprehension
coaching, system audio, and a safe projector surface.

The intended live flow is:

```text
teacher lesson / Teacher Brain
             ↓
camera → local pose detector → raised-hand seat zone
microphone → local Whisper → called-on question
             ↓
reviewed computation policy or schema-validated tutor provider
             ↓
spoken explanation + validated projector scene
             ↓
student response → specific feedback, clue, and bounded retry
```

Classroom speech cannot grant tools, modify system policy, or create executable
board code. Raw camera frames and microphone samples remain ephemeral by default.

## Repository layout

```text
apps/
  classroom-compass/  Live camera, speech, tutor loop, and Visual Stage/Excalidraw projector
  board/              Teacher Brain schema-board compatibility projector
  dashboard/          Reserved operator dashboard workspace
packages/
  harness/            Python agent tools, memory, orchestration, and journals
  perception/         Perception extension point
  voice/              Voice extension point
  evals/               ASSISTments and NCTE evaluation suites
  shared/              Shared TypeScript and JSON schemas
server/                FastAPI, WebSocket hub, SQLite, and setup API
docs/                  Architecture, harness, evaluation, and demo notes
```

## Install

Node.js 22.13 or newer is required.

```bash
cd "/Users/emanuelherrera/AI Builds/ClassroomCompass"
npm install
```

For the Python harness and server:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'
```

## Run the Teacher Brain demo

The Teacher Brain API is the optional frontier-model provider and requires an
`OPENAI_API_KEY`. Copy `.env.example` to an ignored `.env`, load those variables,
and start the API in terminal 1:

```bash
source .venv/bin/activate
uvicorn server.app.main:app --host 127.0.0.1 --port 8000
```

Start the Classroom Compass projector in terminal 2:

```bash
npm run dev:excalidraw
```

Open the printed `/board` URL, normally `http://localhost:3000/board`. Then run
the bilingual simulated-classroom flow in terminal 3:

```bash
npm run demo:teacher-brain
```

The runtime begins a Teacher Brain lesson, accepts simulated interruptions, speaks
the response, and sends only validated public board actions to the projector. If
credentials are unavailable, use `npm run tutor:demo --workspace
classroom-compass`; that deterministic decimal flow needs no model or API key.

## Run the live conference-room trial

One-time local setup:

```bash
npm run vision:setup
npm run voice:setup --workspace classroom-compass
```

Confirm that the selected microphone has a live signal without saving audio:

```bash
npm run voice:meter
```

Start the projector in terminal 1:

```bash
npm run dev:excalidraw
```

Start camera preview, raised-hand gating, local Whisper, tutor reasoning, and
system speech in terminal 2:

```bash
npm run room:preview
```

The room preset looks for `Logitech Webcam C925e` and then `Audio Streaming` as
microphone aliases. Override the selection if necessary:

```bash
CC_WHISPER_CAPTURE_NAME="Exact microphone name" npm run room:preview
```

The camera preset uses OpenCV device index `1`. It requires shoulders, elbows,
wrists, and the raised palm to be visible. A raise must show an upward arm and an
open palm for several frames. The first usable transcript within the called-on
window is associated with the rough left/center/right seat region; this is
turn-taking association, not speaker or face recognition.

## Classroom Compass commands

Run these from the repository root:

```bash
npm run dev:classroom
npm run room:run
npm run room:preview
npm run voice:meter
npm run vision:setup
```

More granular commands can be delegated directly to the workspace:

```bash
npm run tutor:demo --workspace classroom-compass
npm run camera:preview --workspace classroom-compass
npm run voice:run --workspace classroom-compass
npm run test:e2e --workspace classroom-compass
```

The loopback control service listens on `127.0.0.1:4317`. Operational commands:

```bash
npm run tutor --workspace classroom-compass -- health
npm run tutor --workspace classroom-compass -- pause
npm run tutor --workspace classroom-compass -- resume
npm run tutor --workspace classroom-compass -- export
npm run tutor --workspace classroom-compass -- stop
```

Pause and stop terminate owned camera/microphone processes and cancel active
audio output.

## Tutor and visual behavior

Reviewed decimal and common arithmetic policies calculate arbitrary operands at
runtime before any language-model response. Open educational questions use the
configured tutor provider. Responses target the teacher-selected grade band and
explain the reasoning with a concrete representation before asking a short check.
Partly correct or off-track answers receive specific feedback, a clue, and one
retry; the runtime does not loop indefinitely or create a permanent mastery label.

Teacher Brain board plans and general tutor visual plans are both validated before
rendering. The default `/board` route uses a polished, low-latency animated SVG
Visual Stage. `/board/excalidraw` is the editable pen/touch fallback. Neither route
receives private student profiles, raw transcripts, confidence percentages, shell
access, or unrestricted browser control.

The default open-question provider is local Ollama:

```bash
ollama pull qwen3:4b
CC_TUTOR_MODEL=qwen3:4b npm run dev:classroom
```

Set `CC_TUTOR_PROVIDER=none` to disable open-ended model answers while keeping the
reviewed computation policies available.

## Evaluation and verification

```bash
npm run typecheck
npm test
npm run build
npm run verify:m0
npm run test:e2e --workspace classroom-compass
python -m pytest
```

ASSISTments and NCTE datasets are not committed. Their loaders expect authorized
copies under `data/`; see `docs/eval-methodology.md` and `docs/harness.md`.

## Privacy and safety posture

- Raw video and audio retention is zero by default.
- Camera processing is local and limited to pose/open-palm detection and fixed
  seat regions; no facial recognition, demographic inference, or emotion scoring.
- Local Whisper and the default Ollama provider keep classroom processing on the
  machine. Provider changes require explicit configuration.
- A hand raise gates the shared-room microphone, but one webcam microphone cannot
  acoustically isolate a speaker; directional or beamforming hardware is needed
  for reliable isolation in a noisy room.
- Student language and profile information must be declared enrollment data.
- Student records contain reviewable observations, not permanent diagnoses.
- Board actions, sensor events, and model responses are schema validated.
- The projector receives a separately generated classroom-safe payload.
- Secrets are supplied through environment variables and redacted from journals.

## Current limitations

- The live microphone path is a prototype and is not classroom-noise-qualified.
- General factual accuracy depends on the configured model; schema validation
  controls output shape and tool safety, not truthfulness.
- The Teacher Brain frontier-model provider requires API credentials. Reviewed
  arithmetic fixtures and the local Ollama tutor remain available without them.
- The local tutor cannot verify current events without a separately approved
  retrieval adapter.
- Seat zones associate turns spatially and do not prove speaker identity.
- Persistent collaborative drawing layers and production authentication are
  future work.
- External evaluation results must not be described as fairness or learning-impact
  claims without appropriate data and study design.

See `apps/classroom-compass/README.md`, `docs/classroom-agent.md`, and
`docs/demo-flow.md` for deeper implementation detail.
