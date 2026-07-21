import { describe, expect, it } from "vitest";
import { ArithmeticTutorPolicy } from "../../headless/policies/arithmetic-tutor-policy";
import type { HeadlessEvent } from "../../headless/core/types";

function question(text: string): HeadlessEvent {
  return {
    id: crypto.randomUUID(),
    sessionId: "arithmetic-policy-test",
    kind: "question_transcribed",
    source: "live",
    occurredAt: new Date().toISOString(),
    payload: { text },
    provenance: { adapter: "test", version: "1", confidenceBand: "high" },
  };
}

describe("reviewed arithmetic tutor policy", () => {
  const policy = new ArithmeticTutorPolicy();

  it("explains negative multiplication with a valid continuing pattern", () => {
    const turn = policy.evaluate(question("Why does multiplying two negative numbers make a positive?"));
    expect(turn?.spokenAnswer).toContain("answer rises by three");
    expect(turn?.spokenAnswer).toContain("negative one times negative three equals positive three");
    expect(turn?.spokenAnswer).not.toMatch(/owe|debt|moving left twice/i);
    expect(turn?.visual.nodes).toHaveLength(4);
    expect(turn?.provider).toContain("reviewed-arithmetic-tool");
  });

  it("turns spoken whole-number multiplication into equal groups", () => {
    const turn = policy.evaluate(question("What is three times three?"));
    expect(turn?.answer).toContain("3 equal groups of 3");
    expect(turn?.answer).toContain("3 + 3 + 3");
    expect(turn?.answer).toContain("3 × 3 = 9");
  });

  it("computes new numeric operands rather than matching fixed questions", () => {
    const turn = policy.evaluate(question("What is 12.5 plus 3?"));
    expect(turn?.answer).toContain("12.5 + 3 = 15.5");
  });

  it("leaves unrelated questions for the general tutor", () => {
    expect(policy.evaluate(question("Why do leaves change color?"))).toBeNull();
  });
});
