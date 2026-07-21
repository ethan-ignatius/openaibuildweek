# NCTE Transcript Evaluation

**Status: UNAVAILABLE**

Missing authorized NCTE input: data/ncte/paired_annotations.csv or data/ncte/paired_annotations_release.csv. Each user must request transcript access at https://forms.gle/1yWybvsjciqL8Y9p8.

## Turn-Level Discourse Moves

| Label | Predictions | Teacher Brain F1 | Published RoBERTa F1 |
| --- | ---: | ---: | ---: |
| `high_uptake` | 0 | N/A | 0.688 |
| `focusing_question` | 0 | N/A | 0.501 |

The RoBERTa references are the five-fold cross-validation values reported by the NCTE dataset authors. They are contextual bars, not results produced by this run.

## Observation Scoring

| Dimension | Teacher Brain N | Teacher Brain Spearman | Published ChatGPT N | Published ChatGPT Spearman |
| --- | ---: | ---: | ---: | ---: |
| `CLPC` | 0 | N/A | 100 | 0.0036 |
| `CLBM` | 0 | N/A | 100 | 0.3546 |
| `CLINSTD` | 0 | N/A | 100 | -0.0090 |
| `EXPL` | 0 | N/A | 203 | 0.0209 |
| `REMED` | 0 | N/A | 203 | 0.0479 |
| `LANGIMP` | 0 | N/A | 203 | -0.0010 |
| `SMQR` | 0 | N/A | 203 | 0.1741 |

The published ChatGPT references are recomputed from the authors' released GPT-3.5 direct-assessment outputs after applying their non-null prompt filter. They are not rerun or counted in this run's token accounting.

## Run Accounting

- Condition: `full`
- Model: `gpt-5.6`
- Input tokens: **0**
- Output tokens: **0**
- Total tokens processed: **0**
- Estimated API cost: **$0.0000**

## Method

Turn-level predictions receive only the student utterance and subsequent teacher utterance. F1 is measured against majority-rater high-uptake and focusing-question labels. Observation predictions receive anonymized transcript text without any human score columns. Duplicate human raters are mean-aggregated within OBSID before Spearman correlation.

The full condition includes the exact NCTE discourse vocabulary in the pedagogical context; `pedagogy-off` removes those definitions. Journals retain model requests, responses, predictions, latency, and token usage for replay.

## Interpretation Caveat

The published reference samples and this run may differ in size and rating aggregation. Compare dimension-level correlations as reference bars, not as a controlled model-only experiment. Controlled harness lift requires running the same selected observations through both local conditions.

Sources: [NCTE dataset paper](https://aclanthology.org/2023.bea-1.44/), [published ChatGPT baseline artifacts](https://github.com/rosewang2008/zero-shot-teacher-feedback).
