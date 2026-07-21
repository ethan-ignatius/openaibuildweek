# Evaluation Methodology

Teacher Brain is evaluated only against external observations. Fixture tests verify
code paths and metric calculations, but fixture numbers are never reported as agent
results.

## ASSISTments

Place the corrected and deduplicated ASSISTments 2009-10 skill-builder file at:

```text
data/assistments/skill_builder_data_corrected.csv
# or the official download name:
data/assistments/skill_builder_data_corrected_collapsed.csv
```

Record its explicit provenance acknowledgement and checksum:

```bash
.venv/bin/python scripts/prepare_assistments.py \
  data/assistments/skill_builder_data_corrected_collapsed.csv \
  --confirm-corrected-deduplicated
```

The loader verifies that manifest on every run. It retains original problems and uses
the corrected release's `correct` field as the first-attempt outcome. It does not
filter on `attempt_count`, which is the total number of attempts and would introduce
outcome bias. It drops missing skills, deduplicates student/problem rows
chronologically, and keeps students with at least 80 interactions. Raw student IDs
are replaced with stable pseudonyms.

Run the five-student M1 subset:

```bash
.venv/bin/python scripts/run_assistments_eval.py \
  --max-students 5 \
  --memory-mode notes \
  --pybkt-fits 1 \
  --workers 5
```

The hackathon M1 path uses one deterministic pyBKT initialization. Use
`--pybkt-fits 5` for the scaled run, preferably with pyBKT's compiled backend.

Before a scaled run, exercise one complete note-update/prediction cycle without
refitting the baseline:

```bash
.venv/bin/python scripts/run_assistments_eval.py \
  --max-students 1 \
  --max-predictions 1 \
  --skip-pybkt
```

After each chunk, the note update call cannot see the next item. The probability call
receives the saved note and only the next skill tag. AUC and Brier score use the held-
out real response. pyBKT is trained on training students and evaluated at the same
prediction points.

The memory conditions separate three claims:

- `notes` is the Teacher Brain harness condition. GPT-5.6 maintains a compressed,
  persistent learner model and predicts from that note.
- `full_context` is the fair raw-model comparator. The same GPT-5.6 receives the same
  observed history directly, without learner-memory tools or a note-update call.
- `none` is the no-memory ablation. It receives neither history nor notes and is not
  used as the headline "bare model" comparison.

All conditions receive the same next-item skill tag and never receive the held-out
response. Report harness lift as `notes` versus `full_context`; report `none`
separately as the memory-ablation endpoint.

## NCTE Tier 1

Each dataset user must request transcript access through the
[NCTE form](https://forms.gle/1yWybvsjciqL8Y9p8). Place these files under `data/ncte/`:

```text
single_utterances.csv (the downloaded file may be named ncte_single_utterances.csv)
paired_annotations.csv
class_data.csv
mqi_data.csv
```

The first two files come from the authorized transcript release. The observation
score files use the NCTE `OBSID` and the CLASS/MQI fields described by the published
baseline artifacts. Dataset files remain gitignored.

Run the ten-transcript M1 subset:

```bash
.venv/bin/python scripts/run_ncte_eval.py \
  --max-transcripts 10 \
  --condition full \
  --workers 5
```

`--workers` parallelizes independent students, exchanges, or transcripts. Outcomes
within a single learner remain chronological, and output rows retain source order.

Turn-level F1 is measured against majority-rater `high_uptake` and
`focusing_question` labels. Observation-level Spearman correlation is measured after
mean-aggregating duplicate human raters by `OBSID`. Human labels and scores are never
included in model prompts.

The report includes published reference bars from the
[NCTE dataset paper](https://aclanthology.org/2023.bea-1.44/) and the
[ChatGPT baseline artifacts](https://github.com/rosewang2008/zero-shot-teacher-feedback).
Those references are labeled separately and are excluded from local token totals.

## Failure Semantics

Missing files, unverified ASSISTments provenance, insufficient observations, or a
missing `OPENAI_API_KEY` produce a nonzero exit and an `UNAVAILABLE` or `PARTIAL`
report. The runners never replace absent external data with fixtures or synthetic
scores. Every attempted run still writes a replayable journal explaining why it did
not execute.

API pricing is an estimate tied to the configured model alias; input, output, and
total tokens in the journal remain the authoritative accounting values.
