import { describe, expect, it } from "vitest";
import { createInitialState } from "../../demo/fixtures";
import { appendReviewedEvidence, toPublicDisplayState } from "../../privacy/public-state";

describe("review and public-display boundaries", () => {
  it("does not persist unreviewed interpretations as student evidence", () => {
    const state = createInitialState();
    state.proposals.push({ id: "unreviewed", status: "possible", concept: "decimal comparison", hypothesis: "Possible only", evidenceEventIds: ["evt-unrelated"], alternatives: [], bridgeId: "decimal-hundred-grid", bridgeParams: { values: [0.35, 0.4] }, objective: "Compare decimals", durationSeconds: 60, teacherPrompt: "Review?", confidenceBand: "medium", reviewState: "unreviewed", model: "fixture", createdAt: new Date().toISOString() });
    state.activeBridge = { id: "run", bridgeId: "decimal-hundred-grid", params: { values: [0.35, 0.4] }, stage: 5, status: "complete", language: "en", launchedAt: new Date().toISOString(), result: { answer: "0.40", correct: true, attempts: 1, note: "Observed result" } };
    expect(appendReviewedEvidence(state, "unreviewed")).toBe(state);
    expect(state.students.every((student) => student.evidence.length === 0)).toBe(true);
  });

  it("persists only teacher-reviewed event-linked evidence", () => {
    const state = createInitialState();
    state.proposals[0].reviewState = "confirmed";
    state.activeBridge = { id: "run", bridgeId: "fraction-bars", params: { values: [0.25, 0.5] }, stage: 5, status: "complete", language: "en", launchedAt: new Date().toISOString(), result: { answer: "0.40", correct: true, attempts: 1, note: "Observed after representation" } };
    const next = appendReviewedEvidence(state, state.proposals[0].id);
    expect(next.students[0].evidence[0].reviewState).toBe("teacher_confirmed");
    expect(next.students[0].evidence[0].sourceEventIds).toEqual(["evt-unrelated"]);
  });

  it("removes private student fields and proposals from public display payloads", () => {
    const serialized = JSON.stringify(toPublicDisplayState(createInitialState()));
    for (const privateValue of ["Student A", "student-a", "confidenceBand", "proposals", "teacherNotes", "evidence"]) expect(serialized).not.toContain(privateValue);
  });
});
