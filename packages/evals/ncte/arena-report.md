# Teacher Brain Long-Horizon Arena

**Status: COMPLETE**

Compared bare, scaffolded, full across 3 unseen NCTE classroom episodes and 6 sequential decision points per episode.

## Controlled Comparison

All conditions use the same model, reasoning effort, real transcript prefixes, decision points, and externally authored NCTE annotations.

| Condition | High-uptake F1 | Focusing-question F1 | Macro F1 | High-uptake Brier | Focusing-question Brier |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bare` | 0.5000 | 0.4211 | 0.4605 | 0.5821 | 0.5620 |
| `scaffolded` | 0.5000 | 0.4211 | 0.4605 | 0.6265 | 0.5395 |
| `full` | 0.5000 | 0.3810 | 0.4405 | 0.6050 | 0.6077 |

## Harness Lift

- `high_uptake` full-minus-bare F1: **+0.0000**; Brier improvement: **-0.0229**
- `focusing_question` full-minus-bare F1: **-0.0401**; Brier improvement: **-0.0458**
- Macro F1 full-minus-bare: **-0.0201**
- Persistent-state/tool lift over pedagogical scaffolding alone, macro F1: **-0.0201**

Positive F1 lift and positive Brier improvement favor Teacher Brain. Brier captures probability calibration; lower raw Brier is better.

## Run Accounting

| Condition | Decisions | Input tokens | Output tokens | Total tokens | Estimated cost | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `bare` | 18 | 74,149 | 4,631 | 78,780 | $0.5097 | 5714.4 ms |
| `scaffolded` | 18 | 75,607 | 4,401 | 80,008 | $0.5101 | 5600.8 ms |
| `full` | 18 | 84,957 | 9,882 | 94,839 | $0.7212 | 10144.0 ms |

Total tokens processed: **253,627**

Estimated total API cost: **$1.7410**

## Protocol

- Model: `gpt-5.6-sol`
- Fresh observations: `4426, 4156, 2461`
- Decision points per observation: **6**
- `bare`: transcript prefix plus a structured next-move response; no pedagogy definitions, tools, or persistent harness state.
- `scaffolded`: same prefix and output contract with NCTE discourse definitions; no tools or persistent state.
- `full`: same prefix with pedagogy context plus a strict commit tool that atomically updates bounded learner, lesson, and participation state.
- Episodes are serialized within each observation. Independent observations may run concurrently.
- The real teacher response and human labels are hidden until after the model commits its move. Selection uses annotation density and transcript length, never label values.

The annotation target is the discourse-move choice at the same real classroom decision point. The generated response and state diffs are retained for qualitative inspection, but no model judge contributes to headline scores.

## Replay

The JSONL journal, checkpoint, and licensed-text replay are under `state/evals/ncte-arena/ncte-arena-20260721T210006Z`. The directory is gitignored.

## Interpretation Caveats

This is a controlled development-scale comparison, not a population estimate. NCTE speakers are anonymized, so the harness maintains classroom-level learner evidence and does not invent individual identities. The transcript follows the recorded human teacher path after each decision, not the counterfactual path the agent's response might have caused; persistent-agent results are therefore off-policy and should be interpreted as next-move quality with carried state.

A generated response can also fail to realize its declared move probability. The replay is required for that qualitative audit. Larger confirmatory runs must freeze this protocol and use a new held-out observation set.
