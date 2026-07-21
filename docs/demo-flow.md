# Teacher Brain Classroom Demo

This rehearsal exercises the intended classroom state machine with the real
Teacher Brain API and the current Excalidraw projector:

1. Teacher Brain opens an equivalent-fractions lesson.
2. An English-speaking student raises a hand and asks why one half and two
   fourths can be equal.
3. Teacher Brain records that student's exact question, wipes the tutor board,
   rebuilds a focused explanation, checks understanding, and resumes the lesson.
4. A Spanish-speaking student raises a hand and asks the related question in
   Spanish.
5. Teacher Brain records that student's question, wipes the board, answers in
   Spanish, gives a brief English recap, projects both languages, and resumes.

The sensor events are scripted, but the teaching plans, learner-note updates,
board actions, and resume turns use the real API and configured model.

## Run it

Prerequisites are the normal repository install, a valid `OPENAI_API_KEY`, and
Node.js 22.13 or newer.

Terminal 1 — start Teacher Brain:

```bash
.venv/bin/python -m uvicorn server.app.main:app --host 127.0.0.1 --port 8000
```

Terminal 2 — start the projector:

```bash
npm run dev:excalidraw
```

Open `http://localhost:3000/board`.

Terminal 3 — run the rehearsal:

```bash
export CC_LESSON_TITLE="Equivalent Fractions"
export CC_TEACHER_BRAIN_OBJECTIVE="Explain equivalent fractions using equal-sized parts."
export CC_TEACHER_BRAIN_SOURCE_MATERIAL="Use fraction bars before symbolic multiplication."
npm run demo:teacher-brain -- --board --audio
```

The command supplies this safe demo roster when no roster is configured:

- `seat-english` → Jordan, English
- `seat-spanish` → Sofia, Spanish
- `seat-quiet` → Riley, English

Remove `--audio` to print speech without playing it. Add `--fast` to remove the
short pauses between simulated camera/microphone events. `--board` keeps the
projector and control service alive until `Ctrl-C`.

## What to verify

The terminal summary should report two student interruptions, one opening lesson,
two resumes, zero retained raw-media bytes, and the Teacher Brain session ID. On
the projector, each interruption must replace the prior scene. The Spanish scene
must contain panels labeled `Español` and `English recap`.

The summary prints learner-memory URLs. They should show each student's exact
question under evidence-based participation notes without inferred emotion,
disability, demographics, or diagnosis.

It also prints the participation-suggestion endpoint. To ask for general equitable
participation:

```bash
curl http://127.0.0.1:8000/api/teacher/sessions/<session_id>/participation-recommendation
```

With the default roster it should prefer Riley because Riley has not spoken. To
request a low-stakes check based on documented topic evidence:

```bash
curl 'http://127.0.0.1:8000/api/teacher/sessions/<session_id>/participation-recommendation?concept=equal%20parts'
```

The recommendation remains private backend state. Its evidence explicitly tells
the caller not to publicly label the learner and to invite rather than require a
response.
