# Classroom Compass — headless architecture decisions

## Product pivot

The primary product is an independent background tutor/teaching assistant connected to camera, microphone, and speaker pipelines. A teacher-facing dashboard is not required. The existing frontend is preserved only as optional legacy demo code and is not started by `npm run dev` or `npm start`.

## Model-generated teaching instead of hard-coded questions

The live service routes each sanitized question through registered, reviewed tools and then a provider-neutral tutor interface. The default provider is local Ollama, so open-ended answers are generated at runtime instead of selected from prewritten question/value pairs. The decimal comparison tool computes arbitrary supported values deterministically and takes precedence over the model; this prevents a small model from improvising arithmetic.

This is bounded agency rather than unrestricted agency: the model returns a strict answer and visual-plan schema and receives no shell, browser, filesystem, sensing, or arbitrary canvas tools. High-stakes and current-information questions are instructed to defer.

## Local subprocess adapters

Camera capture, microphone capture, transcription, and hand-raise detection vary by hardware and institution. The runtime accepts JSON events from local subprocesses configured as executable/argument arrays. It does not execute shell strings, retain frames/audio, or send raw media to an external provider.

For the MacBook trial, a small signed Swift adapter uses Speech and AVFoundation. It requires on-device recognition unless the operator explicitly sets `CC_ALLOW_NETWORK_SPEECH=1`; the latter may send audio to Apple's recognition service and is therefore not the default privacy posture.

## Projector output without a teacher frontend

The service now combines speech with a local projector canvas. `/board` is deliberately only a public classroom surface, not a dashboard. The headless runtime publishes validated scene JSON over its loopback service. A dependency-light SVG Visual Stage is the default because it renders immediately, scales cleanly on a projector, and supports restrained one-shot animation without another model call. Excalidraw remains at `/board/excalidraw` when pen/touch editing, pan, and zoom are more important than presentation polish.

## Generated concepts plus deterministic drawing primitives

For open-ended questions, the local model generates the explanation, concept labels, and relationships. Deterministic code lays them out as safe text, boxes, ellipses, and arrows. Both projector renderers consume this same bounded scene contract. Accuracy-sensitive math representations use deterministic registered tools. This prevents model output from becoming runtime web code or unrestricted canvas operations.

The default Visual Stage is designed for grades 4–8. It shows a big idea, a concrete example, a short connected reasoning path, familiar reviewed icons, and one application question. The icon and layout choices are part of the validated scene schema, so this added visual appeal does not add another model request or permit arbitrary drawing code.

Basic operations, decimal comparison, and the negative-times-negative sign pattern bypass the general model and use reviewed deterministic explanations. A live smoke test showed that the small local model could produce a mathematically invalid debt analogy; the reviewed layer prevents that class of foundational arithmetic error while leaving open-ended subjects extensible.

Each generated answer can now carry a bounded comprehension contract: one prompt, expected ideas, acceptable short answers, a hint, and a corrective explanation. Exact reviewed answers are checked deterministically; open-ended replies use a separate schema-constrained local assessment. Feedback uses four temporary interaction states—correct, partly correct, off track, or unclear—but none becomes a grade or permanent profile label. The student gets at most one retry before a supportive re-teach, preventing an autonomous dialogue loop.

## Evidence, not labels

The tutoring policy may hold a temporary hypothesis while choosing a response, but that hypothesis never becomes a permanent profile claim. The persisted record states only what the student selected after the representation and recommends an independent follow-up.

## Local operational control

Health, pause, resume, stop, export, and delete are CLI operations backed by a loopback-only service. Pause and stop terminate owned sensor subprocesses and cancel audio. A future deployment would add authenticated device management rather than a teacher dashboard.

## Retained legacy UI

The prior web prototype has not been deleted because removing working user-owned files would be destructive. It is isolated behind `ui:*` scripts. Once the headless direction is confirmed, it can be removed in a separate cleanup pass along with frontend-only dependencies and tests.

## Highest-value next steps

1. Evaluate and select a stronger institution-approved local model for factual accuracy, latency, age appropriateness, and multilingual performance.
2. Add reviewed specialized visual tools for equations, geometry, science diagrams, maps, and timelines, plus a scene feedback loop.
3. Add persistent, separately owned tutor/teacher/student canvas layers and formal red-team/evaluation fixtures for general answers.
