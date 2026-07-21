import { describe, expect, it } from "vitest";
import { screenCalledOnUtterance, stripKnownTutorSpeech, transcriptSimilarity } from "../../headless/core/turn-filter";

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

  it("keeps listening through room noise, garbled IDs, and tutor prompt echoes", () => {
    expect(screenCalledOnUtterance("Allāh Whew! [door opens]").usable).toBe(false);
    expect(screenCalledOnUtterance("Student DC 9C7 79 E72F7").usable).toBe(false);
    expect(screenCalledOnUtterance("Ethan, go ahead with your question.").usable).toBe(false);
    expect(screenCalledOnUtterance("Welcome, I heard the door open, but I did not hear a thing.").usable).toBe(false);
    expect(screenCalledOnUtterance("ahead with your question").usable).toBe(false);
    expect(screenCalledOnUtterance("Where do clouds come from?").usable).toBe(true);
    expect(screenCalledOnUtterance("¿Cómo usan la luz las plantas?").usable).toBe(true);
    expect(screenCalledOnUtterance("I don't understand equivalent fractions").usable).toBe(true);
  });
});
