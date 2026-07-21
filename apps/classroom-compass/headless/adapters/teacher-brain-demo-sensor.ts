import type { HeadlessEvent, SensorAdapter } from "../core/types";

export class TeacherBrainDemoSensorAdapter implements SensorAdapter {
  readonly id = "teacher-brain-demo-classroom@1.0.0";
  status: SensorAdapter["status"] = "ready";
  private paused = false;
  private stopped = false;

  constructor(
    private sessionId: string,
    private englishStudentRef: string,
    private spanishStudentRef: string,
    private delayMs = 900,
  ) {}

  async start(emit: (event: HeadlessEvent) => Promise<void>, signal: AbortSignal) {
    this.status = "running";
    const events: Omit<HeadlessEvent, "id" | "occurredAt">[] = [
      {
        sessionId: this.sessionId,
        kind: "camera_connected",
        source: "simulated",
        payload: { device: "demo-camera" },
        provenance: { adapter: this.id, version: "1.0.0" },
      },
      {
        sessionId: this.sessionId,
        kind: "microphone_connected",
        source: "simulated",
        payload: { device: "demo-microphone" },
        provenance: { adapter: this.id, version: "1.0.0" },
      },
      {
        sessionId: this.sessionId,
        kind: "hand_raise",
        source: "simulated",
        studentRef: this.englishStudentRef,
        payload: { seat: "camera-left" },
        provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" },
      },
      {
        sessionId: this.sessionId,
        kind: "question_transcribed",
        source: "simulated",
        studentRef: this.englishStudentRef,
        payload: { text: "Why can one half and two fourths look different but still be equal?" },
        provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" },
      },
      {
        sessionId: this.sessionId,
        kind: "hand_raise",
        source: "simulated",
        studentRef: this.spanishStudentRef,
        payload: { seat: "camera-right" },
        provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" },
      },
      {
        sessionId: this.sessionId,
        kind: "question_transcribed",
        source: "simulated",
        studentRef: this.spanishStudentRef,
        payload: { text: "¿Por qué un medio es igual a dos cuartos?" },
        provenance: { adapter: this.id, version: "1.0.0", confidenceBand: "high" },
      },
    ];

    for (const event of events) {
      if (signal.aborted || this.stopped) break;
      while (this.paused && !signal.aborted && !this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      await emit({
        ...event,
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
      });
    }
    if (!this.stopped) this.status = "stopped";
  }

  async pause() { this.paused = true; this.status = "paused"; }
  async resume() { this.paused = false; this.status = "running"; }
  async stop() { this.stopped = true; this.status = "stopped"; }
}
