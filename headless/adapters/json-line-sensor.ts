import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { HeadlessEvent, SensorAdapter } from "../core/types";

type CommandSpec = { executable: string; args?: string[] };

function normalizeEvent(value: unknown, sessionId: string, adapter: string): HeadlessEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<HeadlessEvent>;
  if (!candidate.kind || !["hand_raise", "voice_started", "voice_ended", "question_transcribed", "response_transcribed", "sensor_unavailable", "camera_connected", "microphone_connected"].includes(candidate.kind)) return null;
  return {
    id: candidate.id ?? crypto.randomUUID(),
    sessionId,
    kind: candidate.kind,
    source: candidate.source === "simulated" ? "simulated" : "live",
    occurredAt: candidate.occurredAt ?? new Date().toISOString(),
    studentRef: candidate.studentRef,
    payload: candidate.payload ?? {},
    provenance: candidate.provenance ?? { adapter, version: "1.0.0" },
  };
}

export class JsonLineSensorAdapter implements SensorAdapter {
  status: SensorAdapter["status"] = "ready";
  private child: ChildProcess | null = null;
  private lines: Interface | null = null;
  private emit: ((event: HeadlessEvent) => Promise<void>) | null = null;

  constructor(public id: string, private sessionId: string, private command?: CommandSpec) {}

  async start(emit: (event: HeadlessEvent) => Promise<void>, signal: AbortSignal) {
    this.emit = emit;
    this.status = "running";
    if (!this.command) {
      this.lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      this.lines.on("line", (line) => void this.acceptLine(line));
      signal.addEventListener("abort", () => this.lines?.close(), { once: true });
      await new Promise<void>((resolve) => { this.lines?.once("close", resolve); });
      return;
    }
    await this.spawnProcess(signal);
  }

  private async spawnProcess(signal: AbortSignal) {
    if (!this.command) return;
    await new Promise<void>((resolve) => {
      const pendingLines = new Set<Promise<void>>();
      let finished = false;
      const child = spawn(this.command!.executable, this.command!.args ?? [], { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[${this.id}] ${chunk.toString()}`));
      this.lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      this.lines.on("line", (line) => {
        const work = this.acceptLine(line).finally(() => pendingLines.delete(work));
        pendingLines.add(work);
      });
      const finish = async () => {
        if (finished) return;
        finished = true;
        await Promise.all([...pendingLines]);
        if (this.status !== "paused" && this.status !== "stopped") this.status = "unavailable";
        resolve();
      };
      child.once("error", () => void finish());
      child.once("close", () => void finish());
      signal.addEventListener("abort", () => this.child?.kill("SIGTERM"), { once: true });
    });
  }

  private async acceptLine(line: string) {
    try {
      const event = normalizeEvent(JSON.parse(line), this.sessionId, this.id);
      if (event && this.emit && this.status === "running") await this.emit(event);
    } catch {
      // Malformed sensor output is ignored and never interpreted as a command.
    }
  }

  async pause() {
    this.status = "paused";
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  async resume() {
    this.status = "running";
    if (this.command && this.emit) void this.spawnProcess(new AbortController().signal);
  }

  async stop() {
    this.status = "stopped";
    this.lines?.close();
    this.child?.kill("SIGTERM");
    this.child = null;
  }
}

export function parseCommandSpec(raw: string | undefined): CommandSpec | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) throw new Error("Sensor command must be a JSON string array.");
  return { executable: value[0], args: value.slice(1) };
}
