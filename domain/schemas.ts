import { z } from "zod";

export const decimalValuesSchema = z.object({
  values: z.array(z.number().min(0).max(1)).length(2),
  interactive: z.boolean().optional().default(true),
});

export const numberLineSchema = z.object({
  min: z.number(),
  max: z.number(),
  points: z.array(z.number()),
}).refine((value) => value.max > value.min && value.points.every((point) => point >= value.min && point <= value.max), {
  message: "Points must fall within a valid number-line range",
});

export const fractionBarsSchema = z.object({
  values: z.array(z.number().positive().max(1)).min(1).max(6),
});

export const equationBalanceSchema = z.object({
  left: z.string().min(1).max(40),
  right: z.string().min(1).max(40),
});

export const reasoningProposalSchema = z.object({
  status: z.literal("possible"),
  concept: z.string().min(1),
  hypothesis: z.string().min(1),
  evidenceEventIds: z.array(z.string()).min(1),
  alternatives: z.array(z.string()),
  bridgeId: z.string().min(1),
  bridgeParams: z.object({ values: z.array(z.number()).length(2) }),
  objective: z.string().min(1),
  durationSeconds: z.number().int().min(30).max(90),
  teacherPrompt: z.string().min(1),
  confidenceBand: z.enum(["low", "medium", "high"]),
});

export function sanitizeTranscript(text: string) {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/\b(system|developer|assistant)\s*:/gi, "[role word removed]")
    .replace(/ignore (all|previous|prior) instructions/gi, "[instruction-shaped phrase removed]")
    .slice(0, 1200)
    .trim();
}
