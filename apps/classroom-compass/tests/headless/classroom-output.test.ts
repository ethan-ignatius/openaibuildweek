import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  classroomOutputFromEnvironment,
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsClassroomOutput,
  FallbackClassroomOutput,
} from "../../headless/adapters/classroom-output";
import type { ClassroomOutputAdapter, TutorCommand } from "../../headless/core/types";

function speakCommand(language: "en" | "es" = "en"): TutorCommand {
  return {
    id: "speech-1",
    kind: "speak",
    text: language === "es" ? "Vamos a comparar las fracciones." : "Let's compare the fractions.",
    language,
    createdAt: "2026-07-21T12:00:00.000Z",
    provenance: { policy: "test", version: "1" },
  };
}

describe("ElevenLabsClassroomOutput", () => {
  it("uses the configured voice and multilingual language without retaining audio", async () => {
    const requests: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, request?: RequestInit) => {
      requests.push([input, request]);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    let temporaryPath = "";
    const playAudio = vi.fn(async (filePath: string) => {
      temporaryPath = filePath;
      expect(new Uint8Array(await readFile(filePath))).toEqual(new Uint8Array([1, 2, 3]));
    });
    const output = new ElevenLabsClassroomOutput({
      apiKey: "test-key",
      fetchImpl,
      playAudio,
    });

    await output.deliver(speakCommand("es"));

    const [url, request] = requests[0];
    expect(String(url)).toContain(`/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}/stream`);
    expect((request?.headers as Record<string, string>)["xi-api-key"]).toBe("test-key");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      language_code: "es",
      model_id: "eleven_flash_v2_5",
    });
    expect(playAudio).toHaveBeenCalledOnce();
    await expect(access(temporaryPath)).rejects.toThrow();
  });

  it("cancels an in-flight request without surfacing an interruption error", async () => {
    const fetchImpl = vi.fn((_url: URL | RequestInfo, request?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      request?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const playAudio = vi.fn(async () => {});
    const output = new ElevenLabsClassroomOutput({ apiKey: "test-key", fetchImpl, playAudio });

    const delivery = output.deliver(speakCommand());
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    await output.cancel();

    await expect(delivery).resolves.toBeUndefined();
    expect(playAudio).not.toHaveBeenCalled();
  });

  it("prefers ElevenLabs for --audio when either supported key name is present", () => {
    expect(classroomOutputFromEnvironment({ ELEVEN_LABS_API_KEY: "test-key" }, true).id)
      .toContain("elevenlabs-classroom-output@1.0.0");
    expect(classroomOutputFromEnvironment({ ELEVENLABS_API_KEY: "test-key" }, true).id)
      .toContain("elevenlabs-classroom-output@1.0.0");
  });

  it("selects ElevenLabs in live-room auto mode only when a key is available", () => {
    expect(classroomOutputFromEnvironment({ CC_AUDIO_OUTPUT: "auto", ELEVEN_LABS_API_KEY: "test-key" }).id)
      .toContain("elevenlabs-classroom-output@1.0.0");
    expect(classroomOutputFromEnvironment({ CC_AUDIO_OUTPUT: "auto" }).id)
      .toBe("system-speaker-output@1.0.0");
  });

  it("fails clearly when ElevenLabs is explicitly selected without a key", () => {
    expect(() => classroomOutputFromEnvironment({ CC_AUDIO_OUTPUT: "elevenlabs" }))
      .toThrow("ElevenLabs audio requires");
  });
});

describe("FallbackClassroomOutput", () => {
  it("latches to the system fallback after a provider failure", async () => {
    const primary: ClassroomOutputAdapter = {
      id: "primary",
      deliver: vi.fn(async () => { throw new Error("provider unavailable"); }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const fallback: ClassroomOutputAdapter = {
      id: "fallback",
      deliver: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const reportFallback = vi.fn();
    const output = new FallbackClassroomOutput(primary, fallback, reportFallback);

    await output.deliver(speakCommand());
    await output.deliver(speakCommand("es"));

    expect(primary.deliver).toHaveBeenCalledOnce();
    expect(fallback.deliver).toHaveBeenCalledTimes(2);
    expect(reportFallback).toHaveBeenCalledOnce();
  });
});
