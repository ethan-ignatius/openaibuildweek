import type { ZodType } from "zod";
import { decimalValuesSchema, equationBalanceSchema, fractionBarsSchema, numberLineSchema } from "../../domain/schemas";

export type BridgeDefinition = {
  id: string;
  concept: string;
  schema: ZodType;
  gradeBand: string;
  objective: string;
  instructions: { en: string; es?: string };
  durationSeconds: number;
  allowedInteractions: string[];
  check: (params: unknown) => { prompt: string; options: string[]; answer: string };
  version: string;
  reviewStatus: "reviewed" | "prototype";
};

export const bridgeRegistry: Record<string, BridgeDefinition> = {
  "decimal-hundred-grid": {
    id: "decimal-hundred-grid",
    concept: "decimal comparison",
    schema: decimalValuesSchema,
    gradeBand: "4–6",
    objective: "Compare decimal magnitude using hundredths and place value.",
    instructions: {
      en: "Compare equal-sized wholes. Reveal the hundredths, then place both values on the line.",
      es: "Compara enteros del mismo tamaño. Revela los centésimos y coloca ambos valores en la recta.",
    },
    durationSeconds: 60,
    allowedInteractions: ["reveal cells", "drag markers", "select answer", "retry with hint"],
    check: () => ({ prompt: "Which value is greater?", options: ["0.35", "0.40", "They are equal"], answer: "0.40" }),
    version: "1.0.0",
    reviewStatus: "reviewed",
  },
  "decimal-number-line": {
    id: "decimal-number-line",
    concept: "decimal comparison",
    schema: decimalValuesSchema,
    gradeBand: "4–6",
    objective: "Compare decimals by horizontal position on a 0–1 number line.",
    instructions: { en: "Place each decimal between zero and one." },
    durationSeconds: 45,
    allowedInteractions: ["drag markers", "select answer"],
    check: () => ({ prompt: "Which point is farther right?", options: ["0.35", "0.40"], answer: "0.40" }),
    version: "0.4.0",
    reviewStatus: "prototype",
  },
  "place-value-chart": {
    id: "place-value-chart",
    concept: "place value",
    schema: decimalValuesSchema,
    gradeBand: "3–6",
    objective: "Align decimal values by place.",
    instructions: { en: "Read each digit by its place." },
    durationSeconds: 30,
    allowedInteractions: ["highlight columns"],
    check: () => ({ prompt: "How many hundredths are in 0.40?", options: ["4", "40"], answer: "40" }),
    version: "1.0.0",
    reviewStatus: "reviewed",
  },
  "number-line": {
    id: "number-line",
    concept: "magnitude",
    schema: numberLineSchema,
    gradeBand: "2–8",
    objective: "Locate values within a bounded interval.",
    instructions: { en: "Move each point to its estimated position." },
    durationSeconds: 45,
    allowedInteractions: ["drag markers"],
    check: () => ({ prompt: "Which point is farther right?", options: ["First", "Second"], answer: "Second" }),
    version: "0.8.0",
    reviewStatus: "prototype",
  },
  "fraction-bars": {
    id: "fraction-bars",
    concept: "fraction equivalence",
    schema: fractionBarsSchema,
    gradeBand: "3–6",
    objective: "Compare fractions as equal-sized wholes.",
    instructions: { en: "Compare the shaded length of each equal-sized bar." },
    durationSeconds: 45,
    allowedInteractions: ["select bar", "reveal labels"],
    check: () => ({ prompt: "Which bar shows one half?", options: ["0.25", "0.5", "0.75"], answer: "0.5" }),
    version: "0.5.0",
    reviewStatus: "prototype",
  },
  "equation-balance": {
    id: "equation-balance",
    concept: "equation equivalence",
    schema: equationBalanceSchema,
    gradeBand: "6–8",
    objective: "Maintain equality while isolating a variable.",
    instructions: { en: "Apply the same operation to both sides." },
    durationSeconds: 60,
    allowedInteractions: ["choose operation", "step backward"],
    check: () => ({ prompt: "What keeps the scale balanced?", options: ["Same operation on both sides", "Change one side"], answer: "Same operation on both sides" }),
    version: "0.3.0",
    reviewStatus: "prototype",
  },
};

export function validateBridgeParams(id: string, params: unknown) {
  const bridge = bridgeRegistry[id];
  if (!bridge) return { success: false as const, error: "Unknown bridge tool" };
  const result = bridge.schema.safeParse(params);
  return result.success ? { success: true as const, data: result.data } : { success: false as const, error: result.error.issues[0]?.message ?? "Invalid parameters" };
}

export const whiteboardTools = {
  renderHundredGrid: (params: unknown) => validateBridgeParams("decimal-hundred-grid", params),
  renderPlaceValueChart: (params: unknown) => validateBridgeParams("place-value-chart", params),
  renderNumberLine: (params: unknown) => validateBridgeParams("number-line", params),
  renderFractionBars: (params: unknown) => validateBridgeParams("fraction-bars", params),
  renderEquationBalance: (params: unknown) => validateBridgeParams("equation-balance", params),
};
