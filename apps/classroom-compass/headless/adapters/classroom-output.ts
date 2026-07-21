import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { ClassroomOutputAdapter, TutorCommand } from "../core/types";

export class ConsoleClassroomOutput implements ClassroomOutputAdapter {
  id = "console-classroom-output@1.0.0";
  constructor(private quiet = false, public delivered: TutorCommand[] = []) {}
  async deliver(command: TutorCommand) {
    this.delivered.push(command);
    if (!this.quiet) {
      const prefix = command.kind === "speak" ? "TUTOR" : command.kind.toUpperCase();
      process.stdout.write(`[${prefix}] ${command.text ?? command.toolId ?? ""}\n`);
    }
  }
  async cancel() {}
  async close() {}
}

export class SystemSpeakerOutput implements ClassroomOutputAdapter {
  id = "system-speaker-output@1.0.0";
  private active = new Set<ReturnType<typeof spawn>>();

  constructor(
    private command: string,
    private baseArgs: string[] = [],
    private languageArgs: Partial<Record<TutorCommand["language"], string[]>> = {},
  ) {}

  async deliver(command: TutorCommand) {
    if (command.kind !== "speak" || !command.text) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.command,
        [...this.baseArgs, ...(this.languageArgs[command.language] ?? []), command.text!],
        { stdio: "ignore" },
      );
      this.active.add(child);
      child.once("error", reject);
      child.once("exit", () => { this.active.delete(child); resolve(); });
    });
  }

  async cancel() { for (const child of this.active) child.kill("SIGTERM"); this.active.clear(); }
  async close() { await this.cancel(); }
}

export function systemSpeakerForPlatform() {
  if (process.platform === "darwin") {
    return new SystemSpeakerOutput("/usr/bin/say", [], {
      es: ["-v", process.env.CC_SPANISH_VOICE ?? "Mónica"],
    });
  }
  return new SystemSpeakerOutput("espeak", [], { es: ["-v", "es"] });
}

type ElevenLabsOutputOptions = {
  apiKey: string;
  voiceId: string;
  modelId?: string;
  playerPath?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  fallback?: ClassroomOutputAdapter;
};

export function elevenLabsSpeechRequest(
  text: string,
  language: TutorCommand["language"],
  voiceId: string,
  modelId = "eleven_flash_v2_5",
) {
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_24000`,
    body: { text, model_id: modelId, language_code: language },
  };
}

export class ElevenLabsClassroomOutput implements ClassroomOutputAdapter {
  id = "elevenlabs-streaming-output@1.0.0";
  private controllers = new Set<AbortController>();
  private players = new Set<ReturnType<typeof spawn>>();
  private fallback: ClassroomOutputAdapter;

  constructor(private options: ElevenLabsOutputOptions) {
    this.fallback = options.fallback ?? systemSpeakerForPlatform();
  }

  async deliver(command: TutorCommand) {
    if (command.kind !== "speak" || !command.text) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    let player: ReturnType<typeof spawn> | null = null;
    try {
      const request = elevenLabsSpeechRequest(command.text, command.language, this.options.voiceId, this.options.modelId);
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 45_000);
      const response = await (this.options.fetcher ?? fetch)(request.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "audio/pcm",
          "xi-api-key": this.options.apiKey,
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([controller.signal, timeout]),
      });
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null);
        const detail = payload && typeof payload === "object" && "detail" in payload
          ? (payload as { detail?: unknown }).detail
          : null;
        const message = detail && typeof detail === "object" && "message" in detail
          && typeof (detail as { message?: unknown }).message === "string"
          ? (detail as { message: string }).message.slice(0, 300)
          : "Speech generation request failed.";
        throw new Error(`ElevenLabs returned HTTP ${response.status}: ${message}`);
      }
      if (!response.body) throw new Error("ElevenLabs returned no audio stream");

      player = spawn(
        this.options.playerPath ?? path.resolve("../../.classroom-compass/bin/cc-pcm-player"),
        [],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      this.players.add(player);
      const playerInput = player.stdin;
      if (!playerInput) throw new Error("ElevenLabs audio player has no input stream");
      playerInput.on("error", () => {});
      const playerExit = new Promise<number | null>((resolve, reject) => {
        player!.once("error", reject);
        player!.once("exit", (code) => resolve(code));
      });
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!playerInput.write(Buffer.from(chunk.value))) {
          await Promise.race([
            once(playerInput, "drain"),
            new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true })),
          ]);
          if (controller.signal.aborted) return;
        }
      }
      playerInput.end();
      const exitCode = await playerExit;
      if (exitCode !== 0 && !controller.signal.aborted) {
        throw new Error(`ElevenLabs audio player exited with code ${exitCode ?? "unknown"}`);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      process.stderr.write(`ElevenLabs speech unavailable (${error instanceof Error ? error.message : String(error)}); using the local voice fallback.\n`);
      await this.fallback.deliver(command);
    } finally {
      this.controllers.delete(controller);
      if (player) this.players.delete(player);
    }
  }

  async cancel() {
    for (const controller of this.controllers) controller.abort();
    for (const player of this.players) player.kill("SIGTERM");
    this.controllers.clear();
    this.players.clear();
    await this.fallback.cancel();
  }

  async close() {
    await this.cancel();
    await this.fallback.close();
  }
}

export function classroomOutputForEnvironment(
  environment: Record<string, string | undefined> = process.env,
): ClassroomOutputAdapter {
  if (environment.CC_AUDIO_OUTPUT !== "elevenlabs") return systemSpeakerForPlatform();
  const apiKey = environment.ELEVENLABS_API_KEY?.trim();
  const voiceId = environment.ELEVENLABS_VOICE_ID?.trim();
  if (!apiKey || !voiceId) {
    process.stderr.write("ElevenLabs output requested without ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID; using the local voice fallback.\n");
    return systemSpeakerForPlatform();
  }
  return new ElevenLabsClassroomOutput({
    apiKey,
    voiceId,
    modelId: environment.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5",
    playerPath: environment.ELEVENLABS_PLAYER_PATH?.trim()
      ? path.resolve(environment.ELEVENLABS_PLAYER_PATH)
      : undefined,
    timeoutMs: environment.ELEVENLABS_TIMEOUT_MS ? Number(environment.ELEVENLABS_TIMEOUT_MS) : undefined,
  });
}
