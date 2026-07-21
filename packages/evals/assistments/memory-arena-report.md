# Teacher Brain Learner-Memory Arena

**Status: COMPLETE**

The same GPT-5.6 model predicted identical, externally observed next answers under three memory conditions.

## Controlled Comparison

| Condition | Predictions | AUC | Brier | F1 @ 0.5 |
| --- | ---: | ---: | ---: | ---: |
| Stateless GPT-5.6 | 19 | 0.6357 | 0.1922 | 0.8485 |
| GPT-5.6 full history | 19 | 0.7000 | 0.1662 | 0.8571 |
| Teacher Brain notes | 19 | 0.7143 | 0.1723 | 0.8571 |

## Harness Lift

- Notes-minus-stateless AUC: **+0.0786**
- Notes-over-stateless Brier improvement: **+0.0199**
- Notes-minus-full-history AUC: **+0.0143**
- Notes-over-full-history Brier improvement: **-0.0061**
- Notes input-token reduction versus full history: **35.4%**
- Notes total-token reduction versus full history: **16.0%**

Positive AUC lift and positive Brier improvement favor Teacher Brain.

## Run Accounting

| Condition | Input tokens | Output tokens | Total tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: |
| `none` | 3,474 | 1,996 | 5,470 | $0.0772 |
| `full_context` | 72,510 | 2,670 | 75,180 | $0.4427 |
| `notes` | 46,807 | 16,337 | 63,144 | $0.7241 |

Total tokens processed: **143,794**

Estimated total API cost: **$1.2440**

## Protocol

- Model: `gpt-5.6-sol`
- Held-out students: **3**
- Chronological chunk size: **20 interactions**
- Previously used development students skipped: **5**
- Maximum selected trajectory length: **200**
- `none`: next skill tag only; no prior learner evidence.
- `full_context`: all observed rows are resent on every prediction; no persistent notes or memory tool.
- `notes`: the model must update a bounded Markdown learner file through a validated tool, then predict using only that file and the next skill tag.
- The next response is withheld in every condition. A comparison is refused unless student, sequence, skill, and outcome targets match exactly.

## Sessions

- `none`: `assistments-20260721T210932Z`
- `full_context`: `assistments-20260721T211235Z`
- `notes`: `assistments-20260721T211342Z`

## Interpretation

This directly tests learner-state utility against future student outcomes, not similarity to a teacher's wording. The sample is intentionally small and development-scale. Any confirmatory claim requires freezing this protocol and running new held-out students. Full history is a strong information-rich comparator; notes are useful when they preserve calibration while reducing context growth and remaining human-readable.
