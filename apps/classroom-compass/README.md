# Classroom Compass — headless classroom tutor with an Excalidraw projector

Classroom Compass is a background classroom service connected to local camera and microphone pipelines. It transcribes a question, asks a local reasoning model for a concise teaching response and visual plan, validates that plan, draws it on a local Excalidraw projector, and speaks the explanation.

It does **not** require a teacher dashboard. The only browser surface required for visual output is the full-screen `/board` canvas running on the projector or interactive whiteboard. The existing teacher-facing web prototype remains optional legacy/demo code.

## Primary flow

```text
camera / microphone processes
        ↓ JSON-line events
headless sensor adapters
        ↓ sanitized, untrusted transcript
reviewed computation tool, local Ollama model, or Teacher Brain
        ↓ schema-validated answer + visual plan
local Excalidraw projector + speaker
        ↓ optional follow-up question
microphone transcript
        ↓
short in-memory conversation context + local audit record
```

The live voice path is not limited to known question strings or decimal values. For example, it can respond to:

- “Why is the sky blue?”
- “How does photosynthesis work?”
- “What is the difference between area and perimeter?”
- “Why was the water cycle important to early settlements?”

For open-ended questions, the model creates the answer and a small concept/sequence/comparison plan. Classroom Compass—not the model—lays out the validated nodes and arrows in Excalidraw. Recognized decimal comparisons are routed through a reviewed computation tool before the language model, so arithmetic is calculated rather than guessed. That tool accepts arbitrary values from 0 to 1; it is not a table of question-and-answer strings. The showcase prompt is:

> “Why is 0.35 not bigger than 0.4? Thirty-five is bigger than four.”

It draws `0.4 = 0.40`, a place-value chart, two exact 10×10 hundred grids, and a number line. It compares the tenths, asks which value is greater, updates the canvas with one hint if needed, and ends with cautious follow-up language. It never claims that the student has permanently mastered—or is “bad at”—decimals.

## Run the Excalidraw demonstration

Start the projector-only canvas:

```bash
npm install
npm run board:dev
```

Open the URL printed by that command, normally `http://localhost:3000/board`, on the projector. In a second terminal run:

```bash
npm run tutor -- demo --board
```

The simulated microphone question triggers the reviewed decimal policy. The headless service publishes three Excalidraw scenes—explanation, retry hint, and completion—to the loopback-only control service. The demo remains available until `Ctrl-C`.

The Excalidraw toolbar remains available for touch, pen, or mouse additions. Tutor updates replace only the tutor scene; teacher/student drawing persistence and layer ownership are not yet implemented.

## Use the learner-aware Teacher Brain

From the repository root, start the Python API and Excalidraw projector in separate
terminals:

```bash
.venv/bin/python -m uvicorn server.app.main:app --host 127.0.0.1 --port 8000
npm run dev:excalidraw
```

Then map the perception pipeline's fixed seat references to teacher-provided names
or pseudonyms and start Classroom Compass:

```bash
export CC_TUTOR_PROVIDER=teacher-brain
export CC_TEACHER_BRAIN_API_URL=http://127.0.0.1:8000
export CC_TEACHER_BRAIN_ROSTER_JSON='[{"studentRef":"camera-left","name":"Jordan","language":"English"}]'
npm run dev:classroom
```

The provider creates a Teacher Brain session lazily, sends transcribed hand-raise
questions to its interruption endpoint, speaks the returned explanation, and turns
the validated private board plan into public Excalidraw elements. It never sends
learner memory, pedagogical rationale, or raw custom SVG to the projector. If no
provider is selected, the existing local Ollama path remains the default.

## Run the headless demo

Prerequisite: Node.js 22.13 or newer.

```bash
npm install
npm run tutor:demo
```

Expected output includes the Excalidraw scene commands, six short tutor messages, one retry hint, one observed-result record, and:

```text
Raw media retained: 0 bytes
```

No camera, microphone, or cloud credentials are needed for this deterministic demo. The `/board` canvas is optional when testing the background event loop alone.

## Trial with the MacBook microphone

The default voice path uses `whisper.cpp` locally on the Mac. It keeps the model loaded, groups overlapping recognition windows into one utterance, and sends only the completed transcript into the tutor. Raw microphone audio is never written by Classroom Compass or by the configured `whisper-stream` process.

One-time setup (about a 465 MB model download):

```bash
cd apps/classroom-compass
npm run voice:setup
```

The setup command installs the Homebrew `whisper-cpp` package when needed, downloads the official `small.en` model, and verifies its SHA-256 checksum.

In Terminal 1:

```bash
cd apps/classroom-compass
npm run board:dev
```

Open the printed `/board` URL. In Terminal 2:

```bash
cd apps/classroom-compass
npm run voice:run
```

On the first run, allow **Microphone** when macOS asks. Wait for `Classroom Compass local Whisper adapter ready`, then ask any educational question and pause briefly. Live mode defaults to an open-question context; `CC_LESSON_TITLE` may supply optional background without restricting questions to that subject. For example:

> Why is zero point three five not bigger than zero point four? Thirty-five is bigger than four.

Pause for about two seconds. The Excalidraw explanation should appear. After the comprehension prompt, say:

> Zero point four zero is greater.

You can instead ask a different educational question. The live service uses the local Ollama model rather than matching it against prewritten questions. The first model response may take roughly 5–20 seconds on a small laptop; the board displays a thinking state immediately.

Follow-up utterances retain the recent student/tutor conversation. If a student begins speaking while an answer is finishing, up to three turns are queued instead of discarded. Transcripts that closely match current speaker output are ignored as probable acoustic echo. Because speech recognition can still omit decimal points, medium- or low-confidence contradictory math transcripts now receive a clarification question; the tutor does not confidently solve the misheard expression. The macOS adapter also passes segment-level recognition alternatives to the tutor when Apple provides them.

The default trial prints tutor speech to Terminal to prevent the laptop speakers from feeding back into the microphone. If you use headphones, spoken output can be enabled with:

```bash
CC_AUDIO_OUTPUT=system npm run voice:run
```

If permission was previously denied, open **System Settings → Privacy & Security → Microphone**, enable Terminal, and restart `npm run voice:run`. That menu path is an instruction to follow in System Settings, not a Terminal command.

Useful local Whisper tuning:

```bash
CC_WHISPER_VAD_THRESHOLD=0.45 npm run voice:run  # more sensitive in a quiet room
CC_WHISPER_CAPTURE_ID=0 npm run voice:run       # choose a listed capture device
CC_WHISPER_UTTERANCE_GAP_MS=3000 npm run voice:run
```

The older Apple Speech adapter remains available as an explicit fallback:

```bash
npm run voice:build:apple
npm run voice:run:apple
```

Apple Speech requires both Microphone and Speech Recognition permission. Network-assisted Apple recognition remains disabled unless `CC_ALLOW_NETWORK_SPEECH=1` is explicitly set.

## Trial with a conference-room camera and microphone

The macOS camera adapter uses AVFoundation and Vision locally. It detects either a wrist held above its corresponding shoulder or a sustained open palm when the camera framing is too close to show a full torso. It emits only a debounced `hand_raise` event and a rough left/center/right camera zone. It does not identify faces, infer attention or emotion, save frames, or record video.

Build the adapter once:

```bash
npm run camera:build
```

Test only the configured `IC840 1080P HD` camera and hear the call-on prompt:

```bash
npm run camera:test
```

Keep both hands lowered for two seconds, then hold an open palm toward the camera for about one second. The system should say: “I see a raised hand … Go ahead with your question.” Lower the hand before testing again so the detector can reset.

Run the complete room camera + USB microphone + local tutor path:

```bash
npm run room:run
```

### Live RTMPose pose preview

For an operator-visible camera check, install the local Apache-2.0 RTMLib pipeline once. The setup downloads YOLOX-m for multi-person detection and RTMPose-m for 17-point body poses into the local model cache:

```bash
npm run vision:setup
```

Then open the small live diagnostic window:

```bash
npm run camera:preview
```

The preview draws every detected pose, fixed left/center/right seat regions, the current hand-raise state, pose count, and measured FPS. A raise is emitted only after a wrist remains above its matching shoulder across several frames; lowering the hand resets the detector. The current conference-room preset uses OpenCV camera index `1`. Press `Q` or `Esc` in the window to close the preview and service.

To run the same preview together with the local Whisper microphone and tutor, use:

```bash
npm run room:preview
```

The combined command keeps running until `Ctrl-C` so the microphone remains active if the preview window is closed. Custom fixed seat polygons can be based on `config/seat-regions.example.json` and passed to the adapter with `--regions`. All inference is local; frames remain in memory, no face identity is created, and raw media saved remains zero.

The current room preset selects camera `IC840 1080P HD` and Whisper capture device `0` (`Audio Streaming`). Device numbering can change after reconnecting hardware, so confirm the capture list printed at startup. The camera must be able to see either the raised hand or the student’s shoulders and wrist; a head-only crop cannot support a shoulder-relative hand raise.

### Local Ollama tutor model

Ollama must be running. The default model is `qwen3:4b`, selected after the smaller installed models failed factual smoke tests. It occupies about 2.5 GB. Check availability with:

```bash
ollama pull qwen3:4b
ollama list
curl http://127.0.0.1:11434/api/tags
```

Configuration:

```bash
CC_TUTOR_MODEL=qwen3:4b             # choose an installed Ollama model
CC_OLLAMA_URL=http://127.0.0.1:11434
CC_TUTOR_TIMEOUT_MS=35000
CC_TUTOR_PROVIDER=none              # disable open-ended model answers; reviewed tools still work
```

Set `CC_TUTOR_PROVIDER=teacher-brain` to use the learner-aware Python service
described above. `ollama` remains the implicit default for standalone use.

The model receives sanitized transcript text and recent text conversation context—not raw microphone audio, video, student profiles, shell access, browser access, or unrestricted Excalidraw control.

## Run as a background service

```bash
npm run dev
```

This starts the headless tutor and a loopback-only control API on `127.0.0.1:4317`. Without configured device adapters, the service accepts one event JSON object per line on standard input.

Useful controls from another terminal:

```bash
npm run tutor -- health
npm run tutor -- pause
npm run tutor -- resume
npm run tutor -- export
npm run tutor -- stop
npm run tutor -- delete --yes
```

`pause` and `stop` terminate every camera/microphone subprocess owned by the service and cancel active audio output.

## Connect local camera and microphone pipelines

The headless service deliberately does not give an AI agent unrestricted device or operating-system access. Local, institution-approved processes own camera capture, microphone capture, hand-raise detection, and transcription. They send only validated events to Classroom Compass.

Configure them as JSON command arrays—not shell strings:

```bash
export CC_CAMERA_COMMAND_JSON='["/opt/classroom-compass/bin/local-hand-raise-adapter","--device","0"]'
export CC_MICROPHONE_COMMAND_JSON='["/opt/classroom-compass/bin/local-transcriber","--device","default"]'
export CC_AUDIO_OUTPUT=system
npm start
```

`CC_AUDIO_OUTPUT=system` uses `/usr/bin/say` on macOS and `espeak` elsewhere. The default is stdout, which is safer during integration.

Each sensor process writes one JSON object per stdout line. Examples:

```json
{"kind":"camera_connected","source":"live","payload":{"device":"camera-0"}}
{"kind":"hand_raise","source":"live","studentRef":"seat-a2","payload":{"seat":"A2"},"provenance":{"adapter":"local-hand-raise","version":"1.2.0","confidenceBand":"medium"}}
{"kind":"microphone_connected","source":"live","payload":{"device":"default"}}
{"kind":"question_transcribed","source":"live","studentRef":"seat-a2","payload":{"text":"Why is 0.35 not bigger than 0.4?"},"provenance":{"adapter":"local-transcriber","version":"2.1.0","confidenceBand":"high"}}
{"kind":"response_transcribed","source":"live","studentRef":"seat-a2","payload":{"text":"0.40 is greater."},"provenance":{"adapter":"local-transcriber","version":"2.1.0","confidenceBand":"high"}}
```

Malformed events, unknown event kinds, and instruction-shaped classroom speech cannot unlock tools or change system policy.

## Architecture

- `headless/cli.ts` — primary command-line entry point
- `headless/core/tutor-runtime.ts` — autonomous event loop, pause/stop, output, and observed evidence
- `headless/policies/decimal-tutor-policy.ts` — reviewed decimal lesson and comprehension-check policy
- `headless/reasoning/tutor-provider.ts` — provider-neutral tutor interface and provider selection
- `headless/reasoning/teacher-brain-provider.ts` — learner-aware Python API adapter and strict response validation
- `headless/adapters/json-line-sensor.ts` — local camera/microphone subprocess bridge
- `headless/adapters/whisper-stream-adapter.ts` — default local Whisper microphone transcription with overlapping-window and utterance merging
- `headless/adapters/macos-speech-adapter.swift` — optional Apple Speech fallback
- `headless/adapters/classroom-output.ts` — stdout and operating-system speaker outputs
- `headless/whiteboard/excalidraw-tool.ts` — validated public scene schema, deterministic decimal scene, and bounded agent-drawing tool
- `headless/storage/local-event-store.ts` — atomic, permission-restricted local session records
- `headless/control/control-server.ts` — loopback-only operational control
- `app/board/page.tsx` and `components/board/` — projector-only local Excalidraw renderer
- `tests/headless/` — policy, integration, retention, and process-cleanup tests

## Autonomy boundaries

The independent tutor can respond to general educational questions through the configured reasoning provider. It is not allowed to browse the internet, run shell commands, control the operating system, generate executable board code, diagnose a disability, grade or rank students, identify faces, infer emotion or attention, or make disciplinary/high-stakes decisions.

Medical, legal, mental-health, personal-safety, disciplinary, and other high-stakes questions are instructed to defer to a trusted adult or qualified source. Questions requiring live/current information are also deferred because the local model has no browsing tool. Classroom speech remains untrusted data and cannot change the system prompt or unlock tools.

Every model response must match a strict answer/visual schema. Invalid responses are rejected. The model supplies bounded labels and relationships; deterministic code creates the actual Excalidraw elements. Reviewed computation tools run before the model for concepts they support. If Ollama is unavailable, those tools continue to work, while unsupported open-ended questions receive an availability notice rather than a fabricated answer.

The temporary instructional hypothesis used to choose a response is not saved as permanent evidence. The saved statement is limited to what was observed after the interaction.

## Privacy and storage

- Raw audio and video are never written by Classroom Compass.
- With the default Ollama provider, transcript reasoning remains on `127.0.0.1`; no cloud LLM credentials are required.
- Default raw-media retention is hard-coded and tested as `0` bytes.
- Sensor subprocesses are stopped on pause and stop.
- Local session JSON files are written atomically with owner-only permissions under `.classroom-compass/` by default.
- Device pipelines can use seats, badges, or opaque session references; facial recognition is not required or enabled.
- The local control API binds only to `127.0.0.1`.
- The projector receives a separately generated public payload containing only scene metadata, shapes, lines, and classroom-safe text.
- Export and deletion are available through CLI commands.

## Verification

```bash
npm run typecheck
npm run lint
npm run test:headless
npm run tutor:demo
npm run build
npm run board:build
```

The broader legacy test suite remains available with `npm run test:unit`. The optional retained UI harness uses `npm run ui:dev`, `npm run ui:build`, and `npm run test:e2e`; it is not required for the headless tutor.

## Current limitations

- A production speech-to-text model and hand-raise detector are not bundled. They connect through the local subprocess protocol.
- The macOS speech adapter is a single-device trial integration, not a classroom-noise-qualified transcription system. It segments an utterance after roughly 1.8 seconds of silence.
- General answers depend on the quality and knowledge of the installed local model. The configured default is a very small local model suitable for a prototype, not an authoritative source; a stronger institution-reviewed model should improve accuracy.
- The local model cannot verify current events or browse sources and may still make factual mistakes. Its structured response validation controls shape and tool safety, not truthfulness.
- Generated visuals are currently bounded concept maps made from model-supplied nodes and connections. Arbitrary freehand strokes and specialized diagrams require additional reviewed tool schemas.
- Tutor scene updates currently replace the scene. Persistent teacher/student canvas layers are a next step.
- `npm audit --omit=dev` currently reports transitive advisories in Excalidraw's bundled Mermaid parser chain (including one high-severity `lodash-es` advisory) plus the retained Next.js dependency. Classroom Compass does not invoke Mermaid parsing, but these advisories must be resolved or formally assessed before production deployment. The audit-recommended older Excalidraw release is incompatible with this project's React 19 dependency.
- The local JSON store is appropriate for a single-device prototype, not multi-classroom deployment.
- The control API is operational and loopback-only, not an authenticated remote administration plane.
- `espeak` must be installed separately on non-macOS systems when system audio is enabled.

See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) for the headless demo and [DECISIONS.md](DECISIONS.md) for the product pivot and tradeoffs.
