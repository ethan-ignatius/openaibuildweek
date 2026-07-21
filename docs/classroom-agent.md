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
3. The harness applies every board action through the existing WebSocket hub and
   records it as a replayable tool call.
4. On a student interruption, stop current TTS and post the named student's
   question. The harness updates only that learner's persistent note, creates a
   response in the student's declared language, and returns where the lesson should
   resume.
5. End the session. Learner notes remain available to future sessions under
   `state/learners/`; the session journal remains under `state/journals/classrooms/`.

Each classroom serializes its turns, so two model responses cannot race to replace
the board. Different classrooms remain independent. The current M2 server is a
single-board, local deployment and does not include authentication.

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
`highlight_element_id` tells the voice adapter which rendered element to emphasize
while speaking. Board actions have already been schema-validated and sent to the
live projector. An interruption plan can include `board.clear` for one region or
the whole board, followed by a rebuilt explanation.

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
