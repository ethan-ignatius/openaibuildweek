import { describe, expect, it } from "vitest";
import {
  cleanWhisperSegment,
  mergeOverlappingTranscript,
  parseWhisperCaptureDevice,
  selectWhisperCaptureDevice,
  WhisperStreamParser,
} from "../../headless/adapters/whisper-stream-adapter";

describe("local Whisper stream adapter", () => {
  it("selects a microphone by name even when device indexes change", () => {
    const devices = [
      parseWhisperCaptureDevice("init: - Capture device #0: 'MacBook Pro Microphone'"),
      parseWhisperCaptureDevice("init: - Capture device #1: 'Logitech Webcam C925e'"),
      parseWhisperCaptureDevice("init: - Capture device #2: 'Eman’s Airpods'"),
    ].filter((device) => device !== null);

    expect(selectWhisperCaptureDevice(devices, "Logitech Webcam C925e")).toEqual({
      id: "1",
      name: "Logitech Webcam C925e",
    });
    expect(selectWhisperCaptureDevice(devices, "logitech")).toEqual({
      id: "1",
      name: "Logitech Webcam C925e",
    });
    expect(selectWhisperCaptureDevice([
      { id: "0", name: "Audio Streaming" },
      { id: "1", name: "MacBook Pro Microphone" },
    ], "Logitech Webcam C925e|Audio Streaming")).toEqual({
      id: "0",
      name: "Audio Streaming",
    });
    expect(parseWhisperCaptureDevice("Capture #1: MacBook Air Microphone")).toEqual({
      id: "1",
      name: "MacBook Air Microphone",
    });
  });

  it("extracts a complete timestamped transcription block", () => {
    const parser = new WhisperStreamParser();
    expect(parser.accept("[Start speaking]")).toEqual({ ready: true });
    parser.accept("### Transcription 0 START | t0 = 0 ms | t1 = 2000 ms");
    parser.accept("[00:00:00.000 --> 00:00:01.000]  Why is the sky blue?");
    expect(parser.accept("### Transcription 0 END")).toEqual({ transcript: "Why is the sky blue?" });
  });

  it("extracts plain terminal lines produced by rolling-window mode", () => {
    const parser = new WhisperStreamParser();
    expect(parser.accept("model initialization detail")).toEqual({});
    expect(parser.accept("[Start speaking]")).toEqual({ ready: true });
    expect(parser.accept("\u001b[2K\r [BLANK_AUDIO]\u001b[2K\r")).toEqual({});
    expect(parser.accept("\u001b[2K\r Why does a negative times a negative become positive?\u001b[2K\r")).toEqual({
      transcript: "Why does a negative times a negative become positive?",
    });
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
