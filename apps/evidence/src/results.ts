export type MemoryCondition = {
  id: "stateless" | "full-history" | "teacher-brain";
  label: string;
  shortLabel: string;
  auc: number;
  brier: number;
  f1: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  context: string;
  persistentState: boolean;
  toolCommit: boolean;
};

export const memoryConditions: MemoryCondition[] = [
  {
    id: "stateless",
    label: "Stateless GPT-5.6",
    shortLabel: "Stateless",
    auc: 0.6357,
    brier: 0.1922,
    f1: 0.8485,
    inputTokens: 3474,
    outputTokens: 1996,
    totalTokens: 5470,
    costUsd: 0.0772,
    context: "Next skill tag only",
    persistentState: false,
    toolCommit: false,
  },
  {
    id: "full-history",
    label: "GPT-5.6 full history",
    shortLabel: "Full history",
    auc: 0.7,
    brier: 0.1662,
    f1: 0.8571,
    inputTokens: 72510,
    outputTokens: 2670,
    totalTokens: 75180,
    costUsd: 0.4427,
    context: "Every observed interaction",
    persistentState: false,
    toolCommit: false,
  },
  {
    id: "teacher-brain",
    label: "Teacher Brain notes",
    shortLabel: "Teacher Brain",
    auc: 0.7143,
    brier: 0.1723,
    f1: 0.8571,
    inputTokens: 46807,
    outputTokens: 16337,
    totalTokens: 63144,
    costUsd: 0.7241,
    context: "Bounded learner note",
    persistentState: true,
    toolCommit: true,
  },
];

export const evaluationSummary = {
  predictions: 19,
  students: 3,
  chunkSize: 20,
  interactions: [115, 162, 138],
  developmentStudentsSkipped: 5,
  notesVsStatelessAucLift: 0.0786,
  notesVsHistoryAucLift: 0.0143,
  inputTokenReductionVsHistory: 0.354,
  totalTokenReductionVsHistory: 0.16,
  ncteBareMacroF1: 0.4605,
  ncteFullMacroF1: 0.4405,
  ncteDecisions: 18,
  ncteTranscripts: 3,
} as const;

export const reportLinks = {
  memory:
    "https://github.com/ethan-ignatius/openaibuildweek/blob/agent-harness/packages/evals/assistments/memory-arena-report.md",
  ncte:
    "https://github.com/ethan-ignatius/openaibuildweek/blob/agent-harness/packages/evals/ncte/arena-report.md",
  methodology:
    "https://github.com/ethan-ignatius/openaibuildweek/blob/agent-harness/docs/eval-methodology.md",
} as const;
