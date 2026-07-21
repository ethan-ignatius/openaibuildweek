"use client";

import { useState } from "react";
import { Check, ChevronDown, Edit3, Eye, Play, RotateCcw, Trash2, X } from "lucide-react";
import type { AppState, InterpretationProposal } from "../../domain/types";
import { validateBridgeParams } from "../bridges/registry";
import { StatusPill } from "../shared/StatusPill";

export function ProposalCard({ proposal, state, update }: { proposal: InterpretationProposal; state: AppState; update: (recipe: (current: AppState) => AppState) => void }) {
  const [editing, setEditing] = useState(false);
  const [correction, setCorrection] = useState(proposal.teacherCorrection ?? proposal.hypothesis);
  const event = state.events.find((item) => proposal.evidenceEventIds.includes(item.id));
  const primary = proposal.id === "proposal-decimals";

  const review = (reviewState: InterpretationProposal["reviewState"]) => update((current) => ({
    ...current,
    proposals: current.proposals.map((item) => item.id === proposal.id ? { ...item, reviewState } : item),
    audit: [...current.audit, { id: `audit-${Date.now()}`, action: `proposal_${reviewState}`, at: new Date().toISOString(), detail: `${proposal.concept} proposal reviewed by teacher.` }],
  }));

  const launch = () => {
    const validation = validateBridgeParams(proposal.bridgeId, { ...proposal.bridgeParams, interactive: true });
    if (!validation.success) return;
    update((current) => ({
      ...current,
      proposals: current.proposals.map((item) => item.id === proposal.id ? { ...item, reviewState: "confirmed" } : item),
      activeBridge: {
        id: `bridge-run-${Date.now()}`,
        bridgeId: proposal.bridgeId,
        params: proposal.bridgeParams,
        stage: 1,
        status: "active",
        language: current.session.language,
        launchedAt: new Date().toISOString(),
      },
      events: [...current.events, { id: `evt-launch-${Date.now()}`, sessionId: current.session.id, kind: "bridge_launched", source: "teacher", occurredAt: new Date().toISOString(), payload: { detail: proposal.bridgeId }, provenance: { adapter: "teacher-preview-control", version: "1.0.0" } }],
      audit: [...current.audit, { id: `audit-launch-${Date.now()}`, action: "bridge_launched", at: new Date().toISOString(), detail: `Teacher approved ${proposal.bridgeId}.` }],
      demoStep: "bridge",
    }));
  };

  const chooseAnother = () => update((current) => ({
    ...current,
    proposals: current.proposals.map((item) => item.id === proposal.id ? {
      ...item,
      bridgeId: item.bridgeId === "decimal-hundred-grid" ? "decimal-number-line" : "decimal-hundred-grid",
      teacherPrompt: item.bridgeId === "decimal-hundred-grid" ? "Display a number-line-first version?" : "Display the hundred-grid comparison?",
      objective: item.bridgeId === "decimal-hundred-grid" ? "Compare the positions of 0.35 and 0.40 between zero and one." : "Compare 35 hundredths with 40 hundredths.",
    } : item),
  }));

  if (proposal.reviewState === "deleted") return null;
  if (proposal.reviewState === "dismissed") return <div className="dismissed-card"><span><X size={18} /> Suggestion dismissed — not added to student evidence.</span><button onClick={() => review("unreviewed")}><RotateCcw size={15} />Undo</button></div>;

  return (
    <article className={`proposal-card ${primary ? "proposal-primary" : ""}`} data-testid={`proposal-${proposal.id}`}>
      <div className="proposal-topline"><div><span className="proposal-label">{primary ? "Suggested next move" : "Lower-confidence review"}</span><h3>{proposal.concept}</h3></div><StatusPill tone={proposal.confidenceBand === "low" ? "warn" : "info"}>{proposal.confidenceBand} confidence</StatusPill></div>
      <p className="hypothesis"><span>Possible interpretation</span>{proposal.hypothesis}</p>
      <div className="evidence-block"><span><Eye size={16} /> Evidence from the classroom</span><blockquote>“{event?.payload.text ?? "Linked classroom event"}”</blockquote><small>{event?.source === "simulated" ? "Simulated transcript fixture" : event?.source} · {event?.provenance.adapter}</small></div>
      <div className="bridge-recommendation"><div className="bridge-thumb" aria-hidden="true"><i /><i /><i /><i /></div><div><span>Proposed visual</span><strong>{proposal.bridgeId === "decimal-number-line" ? "Decimal number line" : proposal.bridgeId === "fraction-bars" ? "Fraction bars" : "Hundred grids + place value"}</strong><small>{proposal.objective}</small></div><b>~{proposal.durationSeconds}s</b></div>
      {editing && <div className="edit-box"><label htmlFor={`edit-${proposal.id}`}>Teacher correction</label><textarea id={`edit-${proposal.id}`} value={correction} onChange={(event) => setCorrection(event.target.value)} /><button onClick={() => { update((current) => ({ ...current, proposals: current.proposals.map((item) => item.id === proposal.id ? { ...item, hypothesis: correction, teacherCorrection: correction, reviewState: "corrected" } : item) })); setEditing(false); }}><Check size={16} />Save correction</button></div>}
      <details className="why-details"><summary>Why am I seeing this?<ChevronDown size={16} /></summary><p>The rule matched decimal notation plus whole-number comparison language. An alternative is that the student is asking only about notation. Classroom speech cannot issue commands or unlock display tools.</p><button className="text-danger" onClick={() => review("deleted")}><Trash2 size={15} />Delete interpretation</button></details>
      <div className="proposal-actions">
        <button className="primary-button" onClick={launch} data-testid={`launch-${proposal.id}`}><Play size={17} fill="currentColor" />Launch</button>
        <button className="secondary-button" onClick={chooseAnother}>Choose another</button>
        <button className="icon-text-button" onClick={() => setEditing(!editing)}><Edit3 size={16} />Edit</button>
        <button className="icon-text-button" onClick={() => review("dismissed")}><X size={16} />Dismiss</button>
      </div>
    </article>
  );
}
