import { describe, expect, it } from "vitest";
import { stripKnownTutorSpeech, transcriptSimilarity } from "../../headless/core/turn-filter";

describe("voice turn filtering", () => {
  it("removes several tutor phrases while retaining a student's question", () => {
    const result = stripKnownTutorSpeech(
      "Go ahead with your question. What is three times three? Let me think about that.",
      ["Go ahead with your question.", "Let me think about that."],
    );
    expect(result.text).toBe("What is three times three");
    expect(result.removedWordCount).toBeGreaterThan(0);
  });

  it("recognizes repeated rolling-window transcripts", () => {
    expect(transcriptSimilarity("What is three times three?", "what is three times three")).toBe(1);
    expect(transcriptSimilarity("What is three times three?", "How does rain form?")).toBeLessThan(0.5);
  });
});
