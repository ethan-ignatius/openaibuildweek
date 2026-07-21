import type { AppState, ClassroomEvent, InterpretationProposal } from "../domain/types";

const now = "2026-07-20T14:00:00.000Z";

export const decimalQuestionEvent: ClassroomEvent = {
  id: "evt-decimal-question",
  sessionId: "session-demo",
  kind: "question_transcribed",
  source: "simulated",
  studentRef: "student-a",
  occurredAt: "2026-07-20T14:03:12.000Z",
  payload: { text: "Why is 0.35 not bigger than 0.4? Thirty-five is bigger than four." },
  provenance: { adapter: "fixture-transcript", version: "1.0.0", confidenceBand: "high" },
};

export const decimalProposal: InterpretationProposal = {
  id: "proposal-decimals",
  status: "possible",
  concept: "decimal comparison",
  hypothesis: "The student may be comparing decimal digits as whole numbers.",
  evidenceEventIds: [decimalQuestionEvent.id],
  alternatives: ["The student may be asking about notation rather than magnitude."],
  bridgeId: "decimal-hundred-grid",
  bridgeParams: { values: [0.35, 0.4] },
  objective: "Compare 35 hundredths with 40 hundredths.",
  durationSeconds: 60,
  teacherPrompt: "Would you like to display a hundred-grid comparison?",
  confidenceBand: "medium",
  reviewState: "unreviewed",
  model: "deterministic-decimal-rule@1.0.0",
  createdAt: "2026-07-20T14:03:13.000Z",
};

export const lowConfidenceProposal: InterpretationProposal = {
  id: "proposal-low-confidence",
  status: "possible",
  concept: "fraction notation",
  hypothesis: "Student B may be connecting the slash to division.",
  evidenceEventIds: ["evt-unrelated"],
  alternatives: ["The question may only be about reading the symbol aloud."],
  bridgeId: "fraction-bars",
  bridgeParams: { values: [0.25, 0.5] },
  objective: "Connect fraction notation to equal parts.",
  durationSeconds: 45,
  teacherPrompt: "Review this lower-confidence suggestion?",
  confidenceBand: "low",
  reviewState: "unreviewed",
  model: "deterministic-demo-rule@1.0.0",
  createdAt: "2026-07-20T14:02:01.000Z",
};

export function createInitialState(): AppState {
  return {
    schemaVersion: 1,
    classroom: { id: "class-demo", name: "Demo Classroom · Fictional data", fictional: true },
    session: {
      id: "session-demo",
      code: "CC-2048",
      title: "Comparing Decimals",
      topic: "Decimal magnitude & place value",
      status: "active",
      startedAt: now,
      sensingMode: "simulated",
      mediaActive: false,
      audioMuted: true,
      volume: 65,
      captions: true,
      operatingMode: "preview",
      language: "en",
      retentionDays: 7,
    },
    events: [
      {
        id: "evt-opportunity-a",
        sessionId: "session-demo",
        kind: "hand_raise",
        source: "simulated",
        studentRef: "student-a",
        occurredAt: "2026-07-20T14:01:20.000Z",
        payload: { detail: "Hand raise at seat A2" },
        provenance: { adapter: "fixture-hand-raise", version: "1.0.0", confidenceBand: "high" },
      },
      {
        id: "evt-unrelated",
        sessionId: "session-demo",
        kind: "question_transcribed",
        source: "simulated",
        studentRef: "student-b",
        occurredAt: "2026-07-20T14:02:00.000Z",
        payload: { text: "Do we say the zero at the end out loud?" },
        provenance: { adapter: "fixture-transcript", version: "1.0.0", confidenceBand: "medium" },
      },
    ],
    proposals: [lowConfidenceProposal],
    students: [
      { id: "student-a", label: "Student A", group: "Grade 5", seat: "A2", preferredLanguage: "en", consent: "demo-fictional", retention: "30-days", contributions: 1, opportunities: 2, questions: [], evidence: [], interventions: [] },
      { id: "student-b", label: "Student B", group: "Grade 5", seat: "B1", preferredLanguage: "es", consent: "demo-fictional", retention: "30-days", contributions: 1, opportunities: 1, questions: ["Do we say the zero at the end out loud?"], evidence: [], interventions: [] },
      { id: "student-c", label: "Student C", group: "Grade 5", seat: "C3", preferredLanguage: "en", consent: "demo-fictional", retention: "30-days", contributions: 0, opportunities: 1, questions: [], evidence: [], interventions: [] },
    ],
    participation: [
      { studentRef: "student-a", opportunities: 2, voluntaryContributions: 1 },
      { studentRef: "student-b", opportunities: 1, voluntaryContributions: 1 },
      { studentRef: "student-c", opportunities: 1, voluntaryContributions: 0 },
    ],
    activeBridge: null,
    summary: {
      topic: "Comparing Decimals",
      durationMinutes: 0,
      conceptsWithQuestions: ["Reading decimal notation"],
      interventionNotes: [],
      checkResults: [],
      followUpStudents: [],
      participationNote: "Four participation opportunities were offered across three fictional students.",
      suggestedNextActivity: "Open with a two-minute independent decimal number-line placement.",
      uncertainty: "Simulated transcript and hand-raise events; no raw media retained.",
      teacherNotes: "",
    },
    audit: [{ id: "audit-reset", action: "demo_reset", at: now, detail: "Deterministic fictional demo state loaded." }],
    demoStep: "reset",
  };
}
