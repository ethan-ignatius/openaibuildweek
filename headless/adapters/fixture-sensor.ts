import type { HeadlessEvent, SensorAdapter } from "../core/types";

export class FixtureSensorAdapter implements SensorAdapter {
  id = "fixture-camera-microphone@1.0.0";
  status: SensorAdapter["status"] = "ready";
  private paused = false;
  private stopped = false;

  constructor(private sessionId: string, private delayMs = 80, private includeRetry = true) {}

  async start(emit: (event: HeadlessEvent) => Promise<void>, signal: AbortSignal) {
    this.status = "running";
    const events: Omit<HeadlessEvent, "id" | "occurredAt">[] = [
      { sessionId: this.sessionId, kind: "camera_connected", source: "simulated", payload: { device: "fictional-camera-0" }, provenance: { adapter: this.id, version: "1.0.0" } },
      { sessionId: this.sessionId, kind: "microphone_connected", source: "simulated", payload: { device: "fictional-microphone-0" }, provenance: { adapter: this.id, version: "1.0.0" } },
      { sessionId: this.sessionId, kind: "hand_raise", source: "simulated", studentRef: "seat-a2", payload: { seat: "A2" }, provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" } },
      { sessionId: this.sessionId, kind: "question_transcribed", source: "simulated", studentRef: "seat-a2", payload: { text: "Why is 0.35 not bigger than 0.4? Thirty-five is bigger than four." }, provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" } },
      ...(this.includeRetry ? [{ sessionId: this.sessionId, kind: "response_transcribed" as const, source: "simulated" as const, studentRef: "seat-a2", payload: { text: "I think 0.35." }, provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" as const } }] : []),
      { sessionId: this.sessionId, kind: "response_transcribed", source: "simulated", studentRef: "seat-a2", payload: { text: "0.40 is greater." }, provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" } },
    ];
    for (const event of events) {
      if (signal.aborted || this.stopped) break;
      while (this.paused && !signal.aborted && !this.stopped) await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      await emit({ ...event, id: crypto.randomUUID(), occurredAt: new Date().toISOString() });
    }
    if (!this.stopped) this.status = "stopped";
  }

  async pause() { this.paused = true; this.status = "paused"; }
  async resume() { this.paused = false; this.status = "running"; }
  async stop() { this.stopped = true; this.status = "stopped"; }
}
