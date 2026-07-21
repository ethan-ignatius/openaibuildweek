# ASSISTments Long-Horizon Calibration

**Status: PARTIAL**

The external dataset and pyBKT baseline are complete. A bounded live API smoke passed;
the five-student Teacher Brain condition is still pending, so M1 is not complete.

## Results

| System | Predictions | AUC | Brier | F1 @ 0.5 |
| --- | ---: | ---: | ---: | ---: |
| pyBKT | 159 | 0.7910 | 0.1911 | 0.7834 |

## Run Accounting

- Model: `gpt-5.6`
- Input tokens: **0**
- Output tokens: **0**
- Total tokens processed: **0**
- Estimated API cost: **$0.0000**
- pyBKT non-finite fallbacks: **0**
- pyBKT random initializations: **1**
- Eligible students: **815**
- Filtered interactions: **189,826**
- Source SHA-256: `162ef8d2d28bcbfea6591a282994062bd8d5eaa00636544292a0d268dca6e5da`
- Source encoding: `cp1252`

## Method

The loader uses the corrected/deduplicated ASSISTments 2009-10 skill-builder release, uses its `correct` first-attempt outcome on original problems, drops missing skill IDs, and selects students with at least 80 filtered interactions. Student IDs are converted to stable pseudonyms before any notes or journals are written. Held-out students are split deterministically.

After each chronological chunk, the notes condition updates a Markdown learner model without seeing the next item. The probability request receives only that note and the next skill tag. Full-context and no-memory conditions use the same prediction points.

The pyBKT adapter preserves chronological student-skill sequences and activates the package's serial E-step through a documented pyBKT 1.4.x import compatibility path. Non-finite outputs are counted and reported; they are never silently dropped.

## Contamination Note

This is row-level next-response prediction from chronological context for anonymized IDs. The target response is withheld, and memorized public text cannot reveal the outcome of a particular anonymized student-item row.
