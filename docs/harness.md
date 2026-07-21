# Harness

The model provides the reasoning; the harness provides the classroom. The harness
owns the contracts around model calls so live teaching and evaluations use the same
retry, validation, memory, accounting, and journal paths.

## Layer Switches

`HarnessConfig` exposes the evaluation ablations as runtime configuration:

| Layer | Setting | Purpose |
| --- | --- | --- |
| Tool surface | `true` / `false` | Enables validated classroom and memory tools. |
| Learner memory | `notes` / `full_context` / `none` | Selects persistent notes, raw history, or no history. |
| Pedagogical context | `on` / `off` | Includes or removes NCTE-aligned discourse guidance. |
| Orchestration | `true` / `false` | Enables the classroom execution loop. |
| Journaling | `true` / `false` | Enables append-only session recording. |

The notes condition requires the tool surface. Invalid flag combinations fail at
configuration load rather than silently changing the ablation.

## Model Boundary

All Responses API traffic goes through `OpenAIModelClient`. It provides:

- structured Pydantic outputs;
- strict required-tool schemas and one structured repair attempt;
- bounded retries under a shared timeout budget;
- per-attempt request and response journals;
- latency and input/output/total token accounting; and
- no response storage at the API boundary (`store=False`).

Secrets come from environment variables. The journal recursively redacts credential
keys and token patterns before schema validation and serialization.

## Learner Notes

Each learner has one Markdown file under the active state's `learners/` directory.
Identifiers must be a first name or safe pseudonym. Writes are atomic and must retain
the following sections:

- Mastery estimates
- Observed misconceptions
- Language
- Participation notes
- Strategies that worked

The model reads and replaces the note through `learner_read` and `learner_write`
function tools. Evaluation pseudonyms are derived before raw student IDs enter notes
or journals.

## Journals and Replay

Every event is a schema-validated JSONL record with a session ID, UTC timestamp, and
contiguous sequence number. `model.response` events are the accounting source so tool
continuations cannot double-count tokens.

Replay a journal immediately:

```bash
.venv/bin/python scripts/replay.py state/evals/<suite>/<session>.jsonl --quiet
```

To preserve recorded timing and re-dispatch board calls to the local server:

```bash
.venv/bin/python scripts/replay.py session.jsonl \
  --speed 1 \
  --board-url http://127.0.0.1:8000
```

Replay validates the entire journal before emitting events. Mixed sessions, broken
sequence values, invalid events, and malformed board actions fail closed.
