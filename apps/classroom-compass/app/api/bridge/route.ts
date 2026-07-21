import { readState, writeState } from "../../../db/state-store";

type BridgeAction =
  | { action: "next_stage" }
  | { action: "answer"; answer: string }
  | { action: "cancel" }
  | { action: "interaction"; detail: string };

export async function POST(request: Request) {
  const payload = await request.json() as BridgeAction;
  const state = await readState();
  const bridge = state.activeBridge;
  if (!bridge) return Response.json({ error: "No active bridge" }, { status: 409 });

  const at = new Date().toISOString();
  if (payload.action === "cancel") {
    state.activeBridge = { ...bridge, status: "cancelled" };
    state.audit.push({ id: `audit-${Date.now()}`, action: "bridge_cancelled", at, detail: "Public activity exit used; teacher control restored." });
  } else if (payload.action === "next_stage") {
    state.activeBridge = { ...bridge, stage: Math.min(5, bridge.stage + 1) as 1 | 2 | 3 | 4 | 5 };
  } else if (payload.action === "interaction") {
    state.events.push({
      id: `evt-${Date.now()}`,
      sessionId: state.session.id,
      kind: "bridge_interaction",
      source: "simulated",
      occurredAt: at,
      payload: { detail: payload.detail.slice(0, 120) },
      provenance: { adapter: "trusted-whiteboard-tool", version: "1.0.0" },
    });
  } else if (payload.action === "answer") {
    const attempts = (bridge.result?.attempts ?? 0) + 1;
    const correct = payload.answer === "0.40";
    const note = correct
      ? "The student selected the correct comparison after this representation; consider checking independently later."
      : "The student chose another response and received a place-value hint; no conclusion was saved.";
    state.activeBridge = {
      ...bridge,
      stage: correct ? 5 : 4,
      status: correct ? "complete" : "active",
      result: { answer: payload.answer, correct, attempts, note },
    };
    state.events.push({
      id: `evt-check-${Date.now()}`,
      sessionId: state.session.id,
      kind: "check_answered",
      source: "simulated",
      studentRef: "student-a",
      occurredAt: at,
      payload: { answer: payload.answer, correct },
      provenance: { adapter: "decimal-hundred-grid@1.0.0", version: "1.0.0" },
    });
    if (correct) {
      state.demoStep = "complete";
      state.summary.checkResults = [note];
      state.summary.followUpStudents = ["Student A — optional independent check next lesson"];
      state.summary.interventionNotes = ["Teacher launched the reviewed decimal hundred-grid bridge."];
      state.summary.conceptsWithQuestions = ["Decimal magnitude", "Reading decimal notation"];
    }
  }
  return Response.json(await writeState(state));
}
