import { describe, expect, it, vi } from "vitest";
import {
  classroomOutputForEnvironment,
  ElevenLabsClassroomOutput,
  elevenLabsSpeechRequest,
} from "../../headless/adapters/classroom-output";
import type { ClassroomOutputAdapter, TutorCommand } from "../../headless/core/types";

function speechCommand(): TutorCommand {
  return {
    id: "speech-test",
    kind: "speak",
    text: "Explain the water cycle.",
    language: "en",
    createdAt: new Date().toISOString(),
    provenance: { policy: "test", version: "1" },
  };
}

describe("ElevenLabs classroom output", () => {
  it("builds a multilingual low-latency streaming request", () => {
    expect(elevenLabsSpeechRequest(
      "¿Cómo se forman las nubes?",
      "es",
      "voice/with unsafe characters",
    )).toEqual({
      url: "https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20unsafe%20characters/stream?output_format=pcm_24000",
      body: {
        text: "¿Cómo se forman las nubes?",
        model_id: "eleven_flash_v2_5",
        language_code: "es",
      },
    });
  });

  it("selects ElevenLabs only when its server-side credentials are configured", () => {
    const output = classroomOutputForEnvironment({
      CC_AUDIO_OUTPUT: "elevenlabs",
      ELEVENLABS_API_KEY: "test-secret",
      ELEVENLABS_VOICE_ID: "test-voice",
    });
    expect(output).toBeInstanceOf(ElevenLabsClassroomOutput);
    expect(output.id).toBe("elevenlabs-streaming-output@1.0.0");
  });

  it("falls back safely when ElevenLabs rejects synthesis", async () => {
    const fallback: ClassroomOutputAdapter = {
      id: "fallback",
      deliver: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const output = new ElevenLabsClassroomOutput({
      apiKey: "test-secret",
      voiceId: "test-voice",
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        detail: { message: "A paid plan is required." },
      }), { status: 402, headers: { "Content-Type": "application/json" } })) as typeof fetch,
      fallback,
    });

    await output.deliver(speechCommand());

    expect(fallback.deliver).toHaveBeenCalledOnce();
  });

  it("aborts an in-flight generation when a hand raise cancels speech", async () => {
    let requestSignal: AbortSignal | undefined;
    const output = new ElevenLabsClassroomOutput({
      apiKey: "test-secret",
      voiceId: "test-voice",
      fetcher: vi.fn(async (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        await new Promise<void>((resolve) => requestSignal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new DOMException("Aborted", "AbortError");
      }) as typeof fetch,
    });
    const delivery = output.deliver(speechCommand());
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    await output.cancel();
    await delivery;

    expect(requestSignal?.aborted).toBe(true);
  });
});
