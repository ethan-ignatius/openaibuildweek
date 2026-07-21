# ASSISTments Long-Horizon Calibration

**Status: UNAVAILABLE**

ASSISTments file not found: data/assistments/skill_builder_data_corrected.csv

## Results

| System | Predictions | AUC | Brier | F1 @ 0.5 |
| --- | ---: | ---: | ---: | ---: |
| Not run | 0 | N/A | N/A | N/A |

## Run Accounting

- Model: `gpt-5.6`
- Input tokens: **0**
- Output tokens: **0**
- Total tokens processed: **0**
- Estimated API cost: **$0.0000**
- pyBKT non-finite fallbacks: **0**
- Eligible students: **N/A**
- Filtered interactions: **N/A**
- Source SHA-256: `N/A`

## Method

The loader uses the corrected/deduplicated ASSISTments 2009-10 skill-builder release, retains first attempts on original problems, drops missing skill IDs, and selects students with at least 80 filtered interactions. Student IDs are converted to stable pseudonyms before any notes or journals are written. Held-out students are split deterministically.

After each chronological chunk, the notes condition updates a Markdown learner model without seeing the next item. The probability request receives only that note and the next skill tag. Full-context and no-memory conditions use the same prediction points.

## Contamination Note

This is row-level next-response prediction from chronological context for anonymized IDs. The target response is withheld, and memorized public text cannot reveal the outcome of a particular anonymized student-item row.
