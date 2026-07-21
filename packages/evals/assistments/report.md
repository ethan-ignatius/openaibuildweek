# ASSISTments Long-Horizon Calibration

**Status: COMPLETE**

Completed 159 held-out next-item predictions using external ASSISTments rows.

## Results

| System | Predictions | AUC | Brier | F1 @ 0.5 |
| --- | ---: | ---: | ---: | ---: |
| pyBKT | 159 | 0.7910 | 0.1911 | 0.7834 |
| Teacher Brain | 159 | 0.7417 | 0.1972 | 0.7633 |

## Run Accounting

- Model: `gpt-5.6`
- Input tokens: **568,144**
- Output tokens: **256,185**
- Total tokens processed: **824,329**
- Estimated API cost: **$10.5263**
- pyBKT non-finite fallbacks: **0**
- pyBKT random initializations: **1**
- Eligible students: **815**
- Filtered interactions: **189,826**
- Source SHA-256: `162ef8d2d28bcbfea6591a282994062bd8d5eaa00636544292a0d268dca6e5da`
- Source encoding: `cp1252`

## Method

The loader uses the corrected/deduplicated ASSISTments 2009-10 skill-builder release, uses its `correct` first-attempt outcome on original problems, drops missing skill IDs, and selects students with at least 80 filtered interactions. Student IDs are converted to stable pseudonyms before any notes or journals are written. Held-out students are split deterministically.

After each chronological chunk, the notes condition updates a Markdown learner model without seeing the next item. The probability request receives only that note and the next skill tag. Full-context and no-memory conditions use the same prediction points.

The notes condition enforces a 6,000-character replacement-note limit. The model must aggregate repeated evidence so persistent memory remains human-readable and bounded.

The pyBKT adapter preserves chronological student-skill sequences and activates the package's serial E-step through a documented pyBKT 1.4.x import compatibility path. Non-finite outputs are counted and reported; they are never silently dropped.

## M1 Protocol Note

This engineering run introduced the bounded-note policy after prediction 69 in response
to observed note growth. The run proves the five-student pipeline, retry, journal, and
resume paths end to end, but its metrics are preliminary. The controlled headline run
must restart all memory conditions from empty state under one fixed protocol.

## Contamination Note

This is row-level next-response prediction from chronological context for anonymized IDs. The target response is withheld, and memorized public text cannot reveal the outcome of a particular anonymized student-item row.
