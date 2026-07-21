import { describe, expect, it } from "vitest";
import { cleanWhisperSegment, mergeOverlappingTranscript, WhisperStreamParser } from "../../headless/adapters/whisper-stream-adapter";

describe("local Whisper stream adapter", () => {
  it("extracts a complete timestamped transcription block", () => {
    const parser = new WhisperStreamParser();
    expect(parser.accept("[Start speaking]")).toEqual({ ready: true });
    parser.accept("### Transcription 0 START | t0 = 0 ms | t1 = 2000 ms");
    parser.accept("[00:00:00.000 --> 00:00:01.000]  Why is the sky blue?");
    expect(parser.accept("### Transcription 0 END")).toEqual({ transcript: "Why is the sky blue?" });
  });

  it("merges overlapping partial windows without duplicating words", () => {
    expect(mergeOverlappingTranscript(
      "Why is zero point three five",
      "three five not bigger than zero point four?",
    )).toBe("Why is zero point three five not bigger than zero point four?");
    expect(mergeOverlappingTranscript("What is evaporation?", "What is evaporation?")).toBe("What is evaporation?");
  });

  it("drops silence markers and strips display metadata", () => {
    expect(cleanWhisperSegment("[00:00:00.000 --> 00:00:01.000]  [BLANK_AUDIO]")).toBe("");
    expect(cleanWhisperSegment("[00:00:00.000 --> 00:00:01.000]  Water evaporates. [SPEAKER_TURN]")).toBe("Water evaporates.");
  });
});
