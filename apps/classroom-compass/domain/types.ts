export type ConfidenceBand = "low" | "medium" | "high";
export type EventSource = "live" | "simulated" | "teacher";
export type SensingMode = "live" | "simulated" | "paused" | "unavailable";
export type ReviewState = "unreviewed" | "confirmed" | "corrected" | "dismissed" | "deleted";

export type ClassroomEvent = {
  id: string;
  sessionId: string;
  kind:
    | "hand_raise"
    | "speech_started"
    | "question_transcribed"
    | "teacher_note"
    | "bridge_launched"
    | "bridge_interaction"
    | "check_answered";
  source: EventSource;
  studentRef?: string;
  occurredAt: string;
  payload: { text?: string; answer?: string; correct?: boolean; detail?: string };
  provenance: {
    adapter: string;
    version: string;
    confidenceBand?: ConfidenceBand;
  };
};

export type InterpretationProposal = {
  id: string;
  status: "possible";
  concept: string;
  hypothesis: string;
  evidenceEventIds: string[];
  alternatives: string[];
  bridgeId: string;
  bridgeParams: { values: number[] };
  objective: string;
  durationSeconds: number;
  teacherPrompt: string;
  confidenceBand: ConfidenceBand;
  reviewState: ReviewState;
  model: string;
  createdAt: string;
  teacherCorrection?: string;
};

export type EvidenceRecord = {
  id: string;
  studentRef: string;
  concept: string;
  statement: string;
  observedAt: string;
  sourceEventIds: string[];
  interventionId?: string;
  reviewState: "teacher_confirmed" | "teacher_corrected";
  provenance: { source: EventSource; adapter: string; version: string };
};

export type StudentProfile = {
  id: string;
  label: string;
  group?: string;
  seat?: string;
  preferredLanguage?: "en" | "es";
  consent: "demo-fictional" | "granted" | "not-collected";
  retention: "session" | "30-days" | "teacher-managed";
  contributions: number;
  opportunities: number;
  questions: string[];
  evidence: EvidenceRecord[];
  interventions: { bridgeId: string; outcome: string; at: string }[];
};

export type BridgeRun = {
  id: string;
  bridgeId: string;
  params: { values: number[] };
  stage: 1 | 2 | 3 | 4 | 5;
  status: "active" | "complete" | "cancelled";
  language: "en" | "es";
  launchedAt: string;
  result?: {
    answer: string;
    correct: boolean;
    attempts: number;
    note: string;
  };
};

export type LessonSummary = {
  topic: string;
  durationMinutes: number;
  conceptsWithQuestions: string[];
  interventionNotes: string[];
  checkResults: string[];
  followUpStudents: string[];
  participationNote: string;
  suggestedNextActivity: string;
  uncertainty: string;
  teacherNotes: string;
};

export type AppState = {
  schemaVersion: 1;
  classroom: { id: string; name: string; fictional: true };
  session: {
    id: string;
    code: string;
    title: string;
    topic: string;
    status: "ready" | "active" | "ended";
    startedAt: string;
    sensingMode: SensingMode;
    mediaActive: boolean;
    audioMuted: boolean;
    volume: number;
    captions: boolean;
    operatingMode: "preview" | "quick-launch" | "student-station";
    language: "en" | "es";
    retentionDays: 0 | 7 | 30;
  };
  events: ClassroomEvent[];
  proposals: InterpretationProposal[];
  students: StudentProfile[];
  participation: { studentRef: string; opportunities: number; voluntaryContributions: number }[];
  activeBridge: BridgeRun | null;
  summary: LessonSummary;
  audit: { id: string; action: string; at: string; detail: string }[];
  demoStep: "reset" | "question" | "proposal" | "bridge" | "complete";
};

export type PublicDisplayState = Pick<AppState, "schemaVersion" | "activeBridge"> & {
  session: Pick<AppState["session"], "code" | "title" | "topic" | "status" | "sensingMode" | "audioMuted" | "volume" | "captions">;
};
