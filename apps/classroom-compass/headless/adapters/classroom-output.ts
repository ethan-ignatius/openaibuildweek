import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClassroomOutputAdapter, TutorCommand } from "../core/types";

export const DEFAULT_ELEVENLABS_VOICE_ID = "4O1sYUnmtThcBoSBrri7";
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

type AudioPlayer = (filePath: string, signal: AbortSignal) => Promise<void>;

async function playAudioFile(filePath: string, signal: AbortSignal) {
  if (signal.aborted) return;
  const player = process.platform === "darwin"
    ? { command: "/usr/bin/afplay", args: [filePath] }
    : { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", filePath] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(player.command, player.args, { stdio: "ignore" });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted || code === 0) resolve();
      else reject(new Error(`Audio player exited with code ${code ?? "unknown"}.`));
    });
  });
}

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

export class ElevenLabsClassroomOutput implements ClassroomOutputAdapter {
  id = "elevenlabs-classroom-output@1.0.0";
  private active = new Set<AbortController>();
  private cancelled = new WeakSet<AbortController>();

  constructor(private options: {
    apiKey: string;
    voiceId?: string;
    modelId?: string;
    outputFormat?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    playAudio?: AudioPlayer;
  }) {
    if (!options.apiKey.trim()) throw new Error("ElevenLabs audio requires ELEVENLABS_API_KEY or ELEVEN_LABS_API_KEY.");
  }

  async deliver(command: TutorCommand) {
    if (command.kind !== "speak" || !command.text) return;
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    this.active.add(controller);
    let directory: string | undefined;

    try {
      const voiceId = this.options.voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID;
      const outputFormat = this.options.outputFormat ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT;
      const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
      endpoint.searchParams.set("output_format", outputFormat);
      const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": this.options.apiKey,
        },
        body: JSON.stringify({
          text: command.text,
          model_id: this.options.modelId ?? DEFAULT_ELEVENLABS_MODEL_ID,
          language_code: command.language,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ElevenLabs speech request failed with status ${response.status}.`);

      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength === 0) throw new Error("ElevenLabs returned an empty audio response.");
      directory = await mkdtemp(path.join(tmpdir(), "teacher-brain-voice-"));
      const audioPath = path.join(directory, "speech.mp3");
      await writeFile(audioPath, audio);
      await (this.options.playAudio ?? playAudioFile)(audioPath, controller.signal);
    } catch (error) {
      if (this.cancelled.has(controller)) return;
      if (timedOut) throw new Error(`ElevenLabs speech request exceeded ${timeoutMs}ms.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      this.active.delete(controller);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async cancel() {
    for (const controller of this.active) {
      this.cancelled.add(controller);
      controller.abort();
    }
    this.active.clear();
  }

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

export function classroomOutputFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
  forceAudio = false,
): ClassroomOutputAdapter {
  const apiKey = environment.ELEVENLABS_API_KEY ?? environment.ELEVEN_LABS_API_KEY;
  const requested = environment.CC_AUDIO_OUTPUT?.toLowerCase()
    ?? (forceAudio ? (apiKey ? "elevenlabs" : "system") : "console");
  if (requested === "elevenlabs") {
    const configuredTimeout = Number(environment.CC_ELEVENLABS_TIMEOUT_MS ?? 30_000);
    return new ElevenLabsClassroomOutput({
      apiKey: apiKey ?? "",
      voiceId: environment.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID,
      modelId: environment.ELEVENLABS_MODEL_ID ?? DEFAULT_ELEVENLABS_MODEL_ID,
      outputFormat: environment.ELEVENLABS_OUTPUT_FORMAT ?? DEFAULT_ELEVENLABS_OUTPUT_FORMAT,
      timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000,
    });
  }
  if (requested === "system" || forceAudio) return systemSpeakerForPlatform();
  return new ConsoleClassroomOutput(false);
}
