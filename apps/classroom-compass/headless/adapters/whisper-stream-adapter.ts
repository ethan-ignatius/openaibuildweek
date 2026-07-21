#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const adapterID = "local-whisper-stream@1.0.0";
const transcriptionStart = /^### Transcription \d+ START\b/;
const transcriptionEnd = /^### Transcription \d+ END\b/;
const timestampPrefix = /^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/;
const ignoredTranscript = /^(?:\[blank_audio\]|\[silence\]|\(silence\)|\[music\]|\(music\))$/i;

type AdapterEvent = {
  kind: "microphone_connected" | "question_transcribed" | "response_transcribed" | "sensor_unavailable";
  source: "live";
  payload: { device?: string; detail?: string; text?: string };
  provenance: { adapter: string; version: string; confidenceBand?: "medium" };
};

export type WhisperCaptureDevice = { id: string; name: string };

export function parseWhisperCaptureDevice(line: string): WhisperCaptureDevice | null {
  const whisperMatch = line.match(/Capture device #(\d+):\s*'([^']+)'/i);
  if (whisperMatch) return { id: whisperMatch[1], name: whisperMatch[2] };
  const meterMatch = line.match(/^Capture #(\d+):\s*(.+?)\s*$/i);
  return meterMatch ? { id: meterMatch[1], name: meterMatch[2] } : null;
}

export function selectWhisperCaptureDevice(devices: WhisperCaptureDevice[], requestedName: string) {
  const requestedNames = requestedName
    .split("|")
    .map((name) => name.trim().toLocaleLowerCase())
    .filter(Boolean);
  for (const requested of requestedNames) {
    const exact = devices.find((device) => device.name.toLocaleLowerCase() === requested);
    if (exact) return exact;
  }
  for (const requested of requestedNames) {
    const partial = devices.find((device) => device.name.toLocaleLowerCase().includes(requested));
    if (partial) return partial;
  }
  return null;
}

function probeCaptureDevice(
  executable: string,
  args: string[],
  requestedName: string,
  timeoutMs: number,
) {
  return new Promise<WhisperCaptureDevice>((resolve, reject) => {
    const devices: WhisperCaptureDevice[] = [];
    const probe = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;

    const finish = (error?: Error, device?: WhisperCaptureDevice) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.kill("SIGTERM");
      if (error) reject(error);
      else resolve(device!);
    };
    const inspect = (line: string) => {
      const device = parseWhisperCaptureDevice(line);
      if (!device) return;
      devices.push(device);
      const selected = selectWhisperCaptureDevice(devices, requestedName);
      if (selected) finish(undefined, selected);
    };
    createInterface({ input: probe.stdout, crlfDelay: Infinity }).on("line", inspect);
    createInterface({ input: probe.stderr, crlfDelay: Infinity }).on("line", inspect);
    probe.once("error", (error) => finish(new Error(`Unable to inspect microphones: ${error.message}`)));
    probe.once("close", () => {
      const available = devices.map((device) => device.name).join(", ") || "none reported";
      finish(new Error(`None of the requested microphones (${requestedName.replaceAll("|", ", ")}) were found. Available devices: ${available}.`));
    });
    const timer = setTimeout(() => {
      const available = devices.map((device) => device.name).join(", ") || "none reported";
      finish(new Error(`Timed out finding requested microphones (${requestedName.replaceAll("|", ", ")}). Available devices: ${available}.`));
    }, timeoutMs);
  });
}

async function resolveCaptureDeviceByName(executable: string, model: string, requestedName: string) {
  const meter = path.resolve(process.env.CC_AUDIO_METER_BINARY ?? ".classroom-compass/bin/cc-audio-meter");
  try {
    await access(meter);
    return await probeCaptureDevice(meter, ["--list"], requestedName, 4_000);
  } catch {
    return probeCaptureDevice(executable, [
      "--model", model,
      "--capture", "9999",
      "--step", "0",
      "--length", "1000",
      "--vad-thold", "0.50",
      "--freq-thold", "100",
    ], requestedName, 90_000);
  }
}

function writeEvent(kind: AdapterEvent["kind"], payload: AdapterEvent["payload"], confidenceBand?: "medium") {
  const event: AdapterEvent = {
    kind,
    source: "live",
    payload,
    provenance: { adapter: adapterID, version: "1.0.0", ...(confidenceBand ? { confidenceBand } : {}) },
  };
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function cleanWhisperSegment(line: string) {
  const cleaned = line
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(timestampPrefix, "")
    .replace(/\s+\[SPEAKER_TURN\]\s*$/, "")
    .trim();
  return !cleaned || ignoredTranscript.test(cleaned) ? "" : cleaned;
}

function comparableWords(text: string) {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Merge overlapping Whisper windows without turning repeated partials into repeated tutor turns. */
export function mergeOverlappingTranscript(existing: string, incoming: string) {
  if (!existing) return incoming.trim();
  if (!incoming) return existing.trim();
  const leftWords = comparableWords(existing);
  const rightWords = comparableWords(incoming);
  const left = leftWords.join(" ");
  const right = rightWords.join(" ");
  if (right.includes(left)) return incoming.trim();
  if (left.includes(right)) return existing.trim();

  const possibleOverlap = Math.min(leftWords.length, rightWords.length, 24);
  for (let size = possibleOverlap; size > 0; size -= 1) {
    if (leftWords.slice(-size).join(" ") === rightWords.slice(0, size).join(" ")) {
      const incomingTokens = incoming.trim().split(/\s+/);
      return `${existing.trim()} ${incomingTokens.slice(size).join(" ")}`.trim();
    }
  }
  return `${existing.trim()} ${incoming.trim()}`;
}

export class WhisperStreamParser {
  private segments: string[] | null = null;
  private ready = false;

  accept(line: string): { ready?: true; transcript?: string } {
    const cleanedLine = line.replace(/\r$/, "");
    if (cleanedLine.includes("[Start speaking]")) {
      this.ready = true;
      return { ready: true };
    }
    if (transcriptionStart.test(cleanedLine)) {
      this.segments = [];
      return {};
    }
    if (transcriptionEnd.test(cleanedLine)) {
      const transcript = this.segments?.join(" ").replace(/\s+/g, " ").trim() ?? "";
      this.segments = null;
      return transcript ? { transcript } : {};
    }
    if (this.segments) {
      const segment = cleanWhisperSegment(cleanedLine);
      if (segment) this.segments.push(segment);
      return {};
    }
    // With --step > 0, current whisper-stream releases render each rolling
    // transcription directly on a terminal line instead of wrapping it in
    // ### Transcription START/END markers. Only accept such lines after the
    // explicit ready marker so model/device diagnostics cannot become speech.
    if (this.ready) {
      const transcript = cleanWhisperSegment(cleanedLine);
      if (transcript) return { transcript };
    }
    return {};
  }
}

class LocalWhisperMicrophone {
  private child: ChildProcess | null = null;
  private pendingTranscript = "";
  private flushTimer: NodeJS.Timeout | null = null;
  private emittedCount = 0;
  private connected = false;
  private stopping = false;
  private readonly parser = new WhisperStreamParser();
  private readonly debounceMs = Number(process.env.CC_WHISPER_UTTERANCE_GAP_MS ?? 2_600);

  async start() {
    const executable = process.env.CC_WHISPER_BINARY ?? "whisper-stream";
    const model = path.resolve(process.env.CC_WHISPER_MODEL ?? ".classroom-compass/models/ggml-small.en.bin");
    try {
      await access(model);
    } catch {
      this.fail(`Whisper model not found at ${model}. Run npm run voice:setup.`);
      return;
    }

    let captureID = process.env.CC_WHISPER_CAPTURE_ID;
    let captureName = captureID ? `capture device #${captureID}` : "default microphone";
    const requestedCaptureName = process.env.CC_WHISPER_CAPTURE_NAME?.trim();
    if (!captureID && requestedCaptureName) {
      try {
        const resolved = await resolveCaptureDeviceByName(executable, model, requestedCaptureName);
        captureID = resolved.id;
        captureName = resolved.name;
        process.stderr.write(`Resolved microphone \"${resolved.name}\" as capture device #${resolved.id}.\n`);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    const stepMs = process.env.CC_WHISPER_STEP_MS ?? "0";
    const args = [
      "--model", model,
      "--language", process.env.CC_WHISPER_LANGUAGE ?? "en",
      "--step", stepMs,
      "--length", process.env.CC_WHISPER_WINDOW_MS ?? "10000",
      "--vad-thold", process.env.CC_WHISPER_VAD_THRESHOLD ?? "0.50",
      "--freq-thold", process.env.CC_WHISPER_FREQUENCY_THRESHOLD ?? "100",
    ];
    if (captureID) args.push("--capture", captureID);

    this.child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => this.acceptLine(line, captureName));
    const diagnostics = createInterface({ input: this.child.stderr!, crlfDelay: Infinity });
    diagnostics.on("line", (line) => {
      if (/capture device|audio\.init|permission|\berror\b|\bwarning\b/i.test(line)) {
        process.stderr.write(`[whisper] ${line}\n`);
      }
    });
    this.child.once("error", (error) => this.fail(`Unable to start ${executable}: ${error.message}`));
    this.child.once("close", (code, signal) => {
      if (!this.stopping) this.fail(`Whisper microphone stopped (${signal ?? `exit ${code}`}).`);
    });
  }

  stop() {
    this.stopping = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.child?.kill("SIGTERM");
  }

  private acceptLine(line: string, captureName: string) {
    const result = this.parser.accept(line);
    if (result.ready && !this.connected) {
      this.connected = true;
      writeEvent("microphone_connected", { device: `${captureName} (local Whisper)` });
      const stepMs = Number(process.env.CC_WHISPER_STEP_MS ?? 0);
      process.stderr.write(stepMs > 0
        ? `Classroom Compass local Whisper adapter ready in ${stepMs} ms rolling-window mode for a noisy room.\n`
        : "Classroom Compass local Whisper adapter ready in voice-activity mode.\n");
      process.stderr.write("Classroom Compass local Whisper adapter ready. Ask any educational question, then pause briefly.\n");
    }
    if (!result.transcript) return;
    this.pendingTranscript = mergeOverlappingTranscript(this.pendingTranscript, result.transcript);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush() {
    const text = this.pendingTranscript.replace(/\s+/g, " ").trim();
    this.pendingTranscript = "";
    this.flushTimer = null;
    if (!text) return;
    const kind = this.emittedCount === 0 ? "question_transcribed" : "response_transcribed";
    this.emittedCount += 1;
    writeEvent(kind, { text }, "medium");
    process.stderr.write(`Recognized ${kind === "question_transcribed" ? "question" : "follow-up"}: ${text}\n`);
  }

  private fail(detail: string) {
    if (this.stopping) return;
    this.stopping = true;
    writeEvent("sensor_unavailable", { detail });
    process.stderr.write(`Classroom Compass voice adapter: ${detail}\n`);
    process.exitCode = 2;
    this.child?.kill("SIGTERM");
  }
}

async function main() {
  if (process.argv.includes("--self-test")) {
    writeEvent("microphone_connected", { device: "self-test" });
    writeEvent("question_transcribed", { text: "How does evaporation work?" }, "medium");
    return;
  }
  const microphone = new LocalWhisperMicrophone();
  process.once("SIGINT", () => microphone.stop());
  process.once("SIGTERM", () => microphone.stop());
  await microphone.start();
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) await main();
