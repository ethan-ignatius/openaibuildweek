import type { AppState, PublicDisplayState } from "../domain/types";

export function toPublicDisplayState(state: AppState): PublicDisplayState {
  return {
    schemaVersion: state.schemaVersion,
    session: {
      code: state.session.code,
      title: state.session.title,
      topic: state.session.topic,
      status: state.session.status,
      sensingMode: state.session.sensingMode,
      audioMuted: state.session.audioMuted,
      volume: state.session.volume,
      captions: state.session.captions,
    },
    activeBridge: state.activeBridge,
  };
}

export function appendReviewedEvidence(state: AppState, proposalId: string): AppState {
  const proposal = state.proposals.find((item) => item.id === proposalId);
  if (!proposal || !["confirmed", "corrected"].includes(proposal.reviewState) || !state.activeBridge?.result) return state;
  const student = state.students.find((item) => item.id === "student-a");
  if (!student || student.evidence.some((item) => item.interventionId === state.activeBridge?.id)) return state;

  const evidence = {
    id: `evidence-${state.activeBridge.id}`,
    studentRef: student.id,
    concept: proposal.concept,
    statement: state.activeBridge.result.note,
    observedAt: new Date().toISOString(),
    sourceEventIds: proposal.evidenceEventIds,
    interventionId: state.activeBridge.id,
    reviewState: proposal.reviewState === "corrected" ? "teacher_corrected" as const : "teacher_confirmed" as const,
    provenance: { source: "simulated" as const, adapter: proposal.model, version: "1.0.0" },
  };
  return {
    ...state,
    students: state.students.map((item) => item.id === student.id ? {
      ...item,
      evidence: [...item.evidence, evidence],
      interventions: [...item.interventions, { bridgeId: state.activeBridge!.bridgeId, outcome: state.activeBridge!.result!.note, at: evidence.observedAt }],
    } : item),
    audit: [...state.audit, { id: `audit-${Date.now()}`, action: "evidence_saved", at: evidence.observedAt, detail: "Teacher saved reviewed, event-linked evidence." }],
  };
}
