export type HeadlessEventKind =
  | "camera_connected"
  | "microphone_connected"
  | "hand_raise"
  | "voice_started"
  | "voice_ended"
  | "question_transcribed"
  | "response_transcribed"
  | "sensor_unavailable"
  | "control";

export type HeadlessEvent = {
  id: string;
  sessionId: string;
  kind: HeadlessEventKind;
  source: "live" | "simulated" | "operator";
  occurredAt: string;
  studentRef?: string;
  payload: {
    text?: string;
    seat?: string;
    device?: string;
    detail?: string;
    transcriptionSegments?: Array<{ text: string; alternatives: string[] }>;
  };
  provenance: {
    adapter: string;
    version: string;
    confidenceBand?: "low" | "medium" | "high";
  };
};

export type TutorCommand = {
  id: string;
  kind: "speak" | "sound_cue" | "hardware_visual" | "cancel";
  text?: string;
  toolId?: string;
  params?: Record<string, unknown>;
  language: "en" | "es";
  createdAt: string;
  provenance: { policy: string; version: string };
};

export type InteractionState = {
  id: string;
  studentRef?: string;
  concept: "decimal comparison";
  status: "explaining" | "awaiting_check" | "retrying" | "complete" | "escalated";
  evidenceEventIds: string[];
  attempts: number;
  startedAt: string;
  hypothesis: string;
  values: [number, number];
};

export type ObservedEvidence = {
  id: string;
  sessionId: string;
  studentRef?: string;
  concept: string;
  statement: string;
  sourceEventIds: string[];
  interactionId: string;
  observedAt: string;
  provenance: { source: "live" | "simulated"; policy: string; version: string };
};

export type SessionRecord = {
  schemaVersion: 1;
  sessionId: string;
  lessonTitle: string;
  startedAt: string;
  endedAt?: string;
  mode: "live" | "demo";
  status: "starting" | "running" | "paused" | "stopped";
  rawMediaRetainedBytes: 0;
  events: HeadlessEvent[];
  commands: TutorCommand[];
  evidence: ObservedEvidence[];
  audit: { id: string; action: string; at: string; detail: string }[];
};

export type RuntimeHealth = {
  service: "classroom-compass-headless";
  status: SessionRecord["status"];
  sessionId: string;
  mode: SessionRecord["mode"];
  sensors: { id: string; status: "ready" | "running" | "paused" | "stopped" | "unavailable" }[];
  activeInteraction: InteractionState | null;
  rawMediaRetainedBytes: 0;
  lastEventAt?: string;
};

export interface SensorAdapter {
  id: string;
  status: RuntimeHealth["sensors"][number]["status"];
  start(emit: (event: HeadlessEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export interface ClassroomOutputAdapter {
  id: string;
  deliver(command: TutorCommand): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
