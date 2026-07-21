# Classroom Agent

The classroom agent is the live Teacher Brain control loop. It combines persistent
learner notes, a strict smartboard action surface, short teaching turns, and a
student-interruption path. Camera and hand-raise code does not need to know about
the model API; it posts a detected student's transcribed question to one endpoint.

## Runtime Flow

1. Start a classroom with a topic, learning objective, optional teacher source, and
   a roster of first names or pseudonyms.
2. Ask for a teaching turn. The model returns validated board actions, the words to
   narrate, a check for understanding, operator-only pedagogical rationale, and
   explicit resume guidance.
3. The harness validates and journals every board action. Its legacy WebSocket hub
   remains available for the M0 board; the live Classroom Compass path translates
   the same private plan into a bounded public Excalidraw scene.
4. On a student interruption, Classroom Compass stops or ducks current TTS and
   posts the mapped student's question. The harness updates only that learner's
   persistent note, creates a response in the student's declared language, and
   returns where the lesson should resume.
5. End the session. Learner notes remain available to future sessions under
   `state/learners/`; the session journal remains under `state/journals/classrooms/`.

Each classroom serializes its turns, so two model responses cannot race to replace
the board. Classroom Compass also queues up to three speech turns while an answer
is active. Different classrooms remain independent. The current local deployment
does not include authentication, and API session state is in process; persistent
learner notes and journals survive a restart, but active session IDs do not.

## API

Start a classroom:

```bash
curl -X POST http://127.0.0.1:8000/api/teacher/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "topic": "Equivalent fractions",
    "objective": "Explain a fraction as equal parts of one whole.",
    "source_ref": "fractions-deck.pdf#page=3",
    "source_material": "Use area models before the number line.",
    "students": [
      {"name": "Jordan", "language": "Spanish"},
      {"name": "Riley", "language": "English"}
    ]
  }'
```

Use the returned `session_id` for a normal teaching turn:

```bash
curl -X POST \
  http://127.0.0.1:8000/api/teacher/sessions/<session_id>/teach \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"Introduce three-fourths with one visual."}'
```

Send a hand-raise interruption after speech-to-text resolves the question:

```bash
curl -X POST \
  http://127.0.0.1:8000/api/teacher/sessions/<session_id>/interruptions \
  -H 'Content-Type: application/json' \
  -d '{
    "student":"Jordan",
    "question":"Why does the bottom number mean equal parts?"
  }'
```

The response's `plan.narration_segments` are the explanation for TTS; speak
`check_for_understanding` immediately afterward. A segment's
`highlight_element_id` identifies the rendered element to emphasize. Board actions
have already been schema-validated. Classroom Compass validates them again, creates
the Excalidraw scene deterministically, and then replaces the tutor-owned scene. An
interruption plan can include `board.clear` for one region or the whole board,
followed by a rebuilt explanation.

Inspect memory or close the classroom:

```bash
curl http://127.0.0.1:8000/api/teacher/students/Jordan/memory
curl -X POST http://127.0.0.1:8000/api/teacher/sessions/<session_id>/end
```

## Pedagogy and Memory Boundaries

- The model must preserve the teacher's objective and supplied source material.
- Every turn includes a check for understanding and operator-visible rationale.
- Interruption prompts require a direct answer, evidence-based misconception
  repair, a focusing or Socratic move where useful, and an explicit return path.
- Learner notes may record observed work, exact questions, declared language,
  participation, and strategies that worked. They may not infer demographic
  attributes, emotion, confusion, disability, age, or background.
- Student identifiers are restricted to a first name or safe pseudonym. Notes are
  atomically replaced and retain the five human-readable sections enforced by the
  harness.
- All model and board actions use the existing bounded retry, redaction, token
  accounting, and JSONL journal path.

Structural validation and prompting reduce failure modes; they do not prove that a
generated explanation is factually or pedagogically correct. A production rollout
should add subject-specific content checks, operator controls, authentication, and
an emergency no-model fallback.

## Video and Hand-Raise Integration

The perception teammate only needs to supply a roster pseudonym and a transcript.
On a confirmed hand raise:

1. stop or duck current TTS;
2. collect the student's push-to-talk utterance;
3. POST it to `/interruptions`;
4. speak returned narration segments in order, using highlight IDs for timing; and
5. use `resume_guidance` to request the next `/teach` turn.

Presence or hand-raise detection must not infer identity from a face. Map fixed seat
regions to teacher-provided roster pseudonyms instead.

## Classroom Compass and Excalidraw

The current camera, microphone, interruption queue, speaker, and Excalidraw tooling
lives in `apps/classroom-compass/`. Start its headless runtime with the Teacher Brain
provider:

```bash
export CC_TUTOR_PROVIDER=teacher-brain
export CC_TEACHER_BRAIN_API_URL=http://127.0.0.1:8000
export CC_TEACHER_BRAIN_ROSTER_JSON='[{"studentRef":"camera-left","name":"Jordan","language":"English"}]'
npm run dev:classroom
```

`studentRef` is the opaque seat or sensor reference emitted by the perception
pipeline. `name` must be a teacher-authored first name or pseudonym; Classroom
Compass does not resolve faces. Optional settings include
`CC_TEACHER_BRAIN_OBJECTIVE`, `CC_TEACHER_BRAIN_SOURCE_MATERIAL`,
`CC_TEACHER_BRAIN_SOURCE_REF`, and `CC_TEACHER_BRAIN_TIMEOUT_MS`.

The adapter sends only the transcript and mapped student to the interruption API.
It excludes learner notes, operator rationale, resume guidance, and other private
fields from the public scene. Agent-supplied SVG is never projected: custom SVG
actions become a safe placeholder, while text, equations, axes, number lines,
fraction bars, highlights, and clears are rendered by deterministic code. Scene
replacement currently clears the tutor-owned canvas; persistent teacher/student
drawing layers are future work.

Classroom Compass performs the opening `/teach` call before sensor processing and
an explicit follow-on `/teach` call after each successful interruption. Every
interruption plan must begin with a full-board clear. A Spanish interruption must
contain Spanish narration followed by a brief English recap; the runtime speaks
each segment with its language tag, and deterministic projector code adds both
texts to the public scene.

For private, evidence-based participation support, call:

```bash
curl 'http://127.0.0.1:8000/api/teacher/sessions/<session_id>/participation-recommendation?concept=fractions'
```

The selector prioritizes an enrolled student with no current-session
participation, or—when a concept is supplied—a student whose private note contains
documented evidence for that concept. It does not infer attention, emotion, or a
diagnosis, and its recommendation tells the caller to offer a low-stakes invitation
rather than compel or publicly label the student.
