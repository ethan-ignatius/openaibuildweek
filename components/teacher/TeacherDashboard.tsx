"use client";

import {
  Activity, Bell, Camera, Captions, ChevronRight, CircleStop, Clock3, Download,
  Eye, FileText, Hand, Languages, LayoutDashboard, LockKeyhole, Mic, MoreHorizontal,
  Pause, Play, Radio, Settings, ShieldCheck, Sparkles, SquareArrowOutUpRight,
  Trash2, UserRound, Users, Volume2, VolumeX, WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { decimalProposal, decimalQuestionEvent } from "../../demo/fixtures";
import type { AppState } from "../../domain/types";
import { appendReviewedEvidence } from "../../privacy/public-state";
import { requestEphemeralMedia, stopMediaStream } from "../../services/sensing/adapters";
import { Logo } from "../shared/Logo";
import { StatusPill } from "../shared/StatusPill";
import { useClassroomState } from "../shared/use-classroom-state";
import { ProposalCard } from "./ProposalCard";

type Tab = "live" | "evidence" | "summary";

function timeLabel(iso: string) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(iso));
}

export function TeacherDashboard() {
  const { state, update, reset, connection } = useClassroomState();
  const [tab, setTab] = useState<Tab>("live");
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => { stopMediaStream(streamRef.current); }, []);

  const runScriptedMoment = () => {
    update((current) => current.proposals.some((proposal) => proposal.id === decimalProposal.id) ? current : {
      ...current,
      events: current.events.some((event) => event.id === decimalQuestionEvent.id) ? current.events : [...current.events, { ...decimalQuestionEvent, occurredAt: new Date().toISOString() }],
      proposals: [{ ...decimalProposal, createdAt: new Date().toISOString() }, ...current.proposals],
      students: current.students.map((student) => student.id === "student-a" && !student.questions.includes(decimalQuestionEvent.payload.text!) ? { ...student, questions: [...student.questions, decimalQuestionEvent.payload.text!] } : student),
      demoStep: "proposal",
      audit: [...current.audit, { id: `audit-${Date.now()}`, action: "proposal_created", at: new Date().toISOString(), detail: "Deterministic rule produced an unreviewed possible misconception." }],
    });
  };

  const togglePause = () => update((current) => {
    const pausing = current.session.sensingMode !== "paused";
    if (pausing) { stopMediaStream(streamRef.current); streamRef.current = null; }
    return { ...current, session: { ...current.session, sensingMode: pausing ? "paused" : "simulated", mediaActive: false }, audit: [...current.audit, { id: `audit-${Date.now()}`, action: pausing ? "sensing_paused" : "sensing_resumed", at: new Date().toISOString(), detail: pausing ? "All ephemeral media tracks stopped." : "Simulated sensing resumed." }] };
  });

  const requestLive = async () => {
    setPermissionError("");
    try {
      streamRef.current = await requestEphemeralMedia();
      update((current) => ({ ...current, session: { ...current.session, sensingMode: "live", mediaActive: true }, audit: [...current.audit, { id: `audit-${Date.now()}`, action: "ephemeral_media_started", at: new Date().toISOString(), detail: "Browser camera and microphone active; raw media retention remains zero." }] }));
    } catch {
      setPermissionError("Camera or microphone permission was denied. Simulated controls remain available.");
      update((current) => ({ ...current, session: { ...current.session, sensingMode: "unavailable", mediaActive: false } }));
    }
  };

  const endSession = () => {
    stopMediaStream(streamRef.current); streamRef.current = null;
    update((current) => ({ ...current, session: { ...current.session, status: "ended", sensingMode: "paused", mediaActive: false }, activeBridge: current.activeBridge ? { ...current.activeBridge, status: "cancelled" } : null, audit: [...current.audit, { id: `audit-end-${Date.now()}`, action: "session_ended", at: new Date().toISOString(), detail: "Session ended; ephemeral media stopped." }] }));
  };

  const saveEvidence = () => update((current) => appendReviewedEvidence(current, "proposal-decimals"));
  const evidenceCount = state.students.find((student) => student.id === "student-a")?.evidence.length ?? 0;
  const activeProposal = state.proposals.find((proposal) => proposal.id === "proposal-decimals");

  return (
    <div className="teacher-app">
      <header className="teacher-topbar">
        <a href="/teacher" className="logo-link"><Logo /></a>
        <nav aria-label="Teacher navigation">
          <button className={tab === "live" ? "active" : ""} onClick={() => setTab("live")}><LayoutDashboard size={17} />Live lesson</button>
          <button className={tab === "evidence" ? "active" : ""} onClick={() => setTab("evidence")}><Users size={17} />Evidence</button>
          <button className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}><FileText size={17} />Summary</button>
        </nav>
        <div className="topbar-actions">
          <span className={`save-state ${connection === "saved" ? "saved" : ""}`}>{connection === "saved" ? "Saved locally" : connection === "loading" ? "Saving…" : "Offline fallback"}</span>
          <button aria-label="Notifications"><Bell size={19} /></button><button aria-label="Settings"><Settings size={19} /></button>
          <button className="teacher-avatar" aria-label="Teacher menu">TE</button>
        </div>
      </header>

      <div className="lesson-bar">
        <div><span className="live-dot" /><div><strong>{state.session.title}</strong><small>{state.session.topic}</small></div></div>
        <div className="lesson-meta"><span><Clock3 size={15} />14:03 elapsed</span><StatusPill tone={state.session.sensingMode === "paused" ? "warn" : state.session.sensingMode === "unavailable" ? "danger" : "good"}>{state.session.sensingMode} sensing</StatusPill><span className="mode-pill"><Eye size={14} />Preview mode</span></div>
        <div className="session-actions"><a href={`/display/${state.session.code}`} target="_blank" rel="noreferrer"><SquareArrowOutUpRight size={16} />Open display</a><button aria-label={state.session.audioMuted ? "Unmute classroom prompts" : "Mute classroom prompts"} onClick={() => update((current) => ({ ...current, session: { ...current.session, audioMuted: !current.session.audioMuted } }))}>{state.session.audioMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}{state.session.audioMuted ? "Muted" : "Audio on"}</button><button aria-label="Toggle classroom captions" aria-pressed={state.session.captions} onClick={() => update((current) => ({ ...current, session: { ...current.session, captions: !current.session.captions } }))}><Captions size={16} />Captions</button><button className="pause-button" onClick={togglePause}>{state.session.sensingMode === "paused" ? <Play size={16} /> : <Pause size={16} />}{state.session.sensingMode === "paused" ? "Resume" : "Pause sensing"}</button><button className="end-button" onClick={endSession}><CircleStop size={16} />End</button></div>
      </div>

      {tab === "live" && <main className="dashboard-layout">
        <section className="main-column">
          <div className="section-heading"><div><span className="attention-kicker"><Sparkles size={15} />Needs attention now</span><h1>One learning moment to review</h1></div><button className="more-button" aria-label="More options"><MoreHorizontal /></button></div>
          {!activeProposal && <div className="moment-card" data-testid="scripted-moment-card"><div className="moment-icon"><Mic /></div><div><span>Scripted demo moment</span><h2>Play the decimal question</h2><p>Adds a fictional hand-raise, transcript, and a deterministic, unreviewed suggestion.</p></div><button className="primary-button" data-testid="run-scripted-moment" disabled={connection === "loading"} onClick={runScriptedMoment}><Play size={16} fill="currentColor" />{connection === "loading" ? "Preparing…" : "Run moment"}</button></div>}
          {state.proposals.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} state={state} update={update} />)}

          {state.activeBridge?.result?.correct && <article className="result-card" data-testid="teacher-result-card"><div className="result-icon"><Activity /></div><div><span>Observed result</span><h3>Correct comparison selected after the Visual Bridge</h3><p>{state.activeBridge.result.note}</p><div className="result-actions"><button className="primary-button" onClick={() => update((current) => ({ ...current, activeBridge: null }))}>Continue lesson</button><button className="secondary-button" onClick={() => update((current) => ({ ...current, activeBridge: current.activeBridge ? { ...current.activeBridge, stage: 1, status: "active", result: undefined } : null }))}>Try another representation</button><button className="secondary-button" onClick={saveEvidence} disabled={evidenceCount > 0}>{evidenceCount > 0 ? "Evidence saved" : "Save reviewed evidence"}</button></div></div></article>}

          <section className="stream-section"><div className="subsection-heading"><div><h2>Classroom event stream</h2><span>Observed and simulated events stay distinct from interpretations.</span></div><StatusPill tone="neutral">{state.events.length} events</StatusPill></div>
            <div className="event-list">{[...state.events].reverse().map((event) => <article className="event-row" key={event.id}><span className={`event-icon event-${event.kind}`}>{event.kind === "hand_raise" ? <Hand /> : event.kind === "question_transcribed" ? <Mic /> : event.kind === "check_answered" ? <Activity /> : <Play />}</span><div><div><strong>{event.kind.replaceAll("_", " ")}</strong><StatusPill tone={event.source === "simulated" ? "neutral" : "good"}>{event.source}</StatusPill></div><p>{event.payload.text ?? event.payload.detail ?? (event.payload.answer ? `Answer: ${event.payload.answer}` : "Classroom event")}</p><small>{timeLabel(event.occurredAt)} · {event.provenance.adapter} · {event.provenance.confidenceBand ? `${event.provenance.confidenceBand} band` : "direct action"}</small></div></article>)}</div>
          </section>
        </section>

        <aside className="side-column">
          <section className="camera-card"><div className="camera-head"><div><span className={state.session.sensingMode === "live" ? "camera-live-dot" : "camera-sim-dot"} />{state.session.sensingMode === "live" ? "Live ephemeral preview" : "Simulated classroom view"}</div><button aria-label="Camera options"><MoreHorizontal /></button></div><div className={`classroom-sim ${state.session.sensingMode === "paused" ? "paused" : ""}`}><div className="board-sim">0.35 &nbsp; ? &nbsp; 0.40</div>{["A2", "B1", "C3"].map((seat, index) => <div className={`seat seat-${index + 1}`} key={seat}><span><UserRound /></span><b>{seat}</b>{index === 0 && <i><Hand /></i>}</div>)}{state.session.sensingMode === "paused" && <div className="paused-overlay"><Pause />Sensing paused</div>}</div><div className="camera-footer"><span><Camera size={15} />Raw video: not recorded</span><button onClick={requestLive}><Radio size={15} />Request live media</button></div>{permissionError && <p className="permission-error"><WifiOff size={15} />{permissionError}</p>}</section>

          <section className="participation-card"><div className="subsection-heading"><div><h2>Participation opportunities</h2><span>Counts, not an engagement score</span></div><Users /></div>{state.participation.map((item) => { const student = state.students.find((profile) => profile.id === item.studentRef); return <div className="participation-row" key={item.studentRef}><span className="student-initial">{student?.label.at(-1)}</span><div><strong>{student?.label}</strong><small>{student?.seat} · {item.voluntaryContributions} voluntary contribution{item.voluntaryContributions === 1 ? "" : "s"}</small></div><div className="opportunity-dots" role="img" aria-label={`${item.opportunities} participation opportunities`}>{Array.from({ length: item.opportunities }, (_, index) => <i key={index} />)}</div></div>; })}<a className="card-link" onClick={() => setTab("evidence")}>Review evidence profiles<ChevronRight size={16} /></a></section>

          <section className="privacy-card"><div><ShieldCheck /><span><strong>Privacy controls</strong><small>Ephemeral media · fictional demo data</small></span></div><button onClick={() => setPrivacyOpen(!privacyOpen)}>{privacyOpen ? "Hide" : "Manage"}</button>{privacyOpen && <div className="privacy-drawer"><label>Derived event retention<select value={state.session.retentionDays} onChange={(event) => update((current) => ({ ...current, session: { ...current.session, retentionDays: Number(event.target.value) as 0 | 7 | 30 } }))}><option value="0">Session only</option><option value="7">7 days</option><option value="30">30 days</option></select></label><a href="/api/export"><Download size={15} />Export session JSON</a><button className="text-danger" onClick={() => reset()}><Trash2 size={15} />Delete & reset demo data</button><a href="/privacy"><LockKeyhole size={15} />Teacher & family privacy guide</a></div>}</section>
        </aside>
      </main>}

      {tab === "evidence" && <EvidenceView state={state} update={update} />}
      {tab === "summary" && <SummaryView state={state} update={update} />}
    </div>
  );
}

function EvidenceView({ state, update }: { state: AppState; update: (recipe: (current: AppState) => AppState) => void }) {
  return <main className="wide-view"><div className="wide-view-head"><div><span className="attention-kicker"><Users size={15} />Teacher-reviewed evidence</span><h1>Evidence profiles</h1><p>Session observations are reviewable records, never fixed student labels.</p></div><StatusPill tone="info">Fictional demo profiles</StatusPill></div><div className="profile-grid">{state.students.map((student) => <article className="profile-card" key={student.id}><div className="profile-header"><span>{student.label.at(-1)}</span><div><h2>{student.label}</h2><p>{student.group} · Seat {student.seat}</p></div><button aria-label={`Options for ${student.label}`}><MoreHorizontal /></button></div><div className="profile-stats"><span><b>{student.opportunities}</b>opportunities</span><span><b>{student.contributions}</b>contributions</span><span><b>{student.evidence.length}</b>reviewed records</span></div><div className="profile-section"><h3>Questions asked</h3>{student.questions.length ? student.questions.map((question) => <p key={question}>“{question}”</p>) : <p className="empty-copy">No questions recorded this session.</p>}</div><div className="profile-section"><h3>Reviewed evidence</h3>{student.evidence.length ? student.evidence.map((item) => <div className="evidence-record" key={item.id}><StatusPill tone="good">teacher reviewed</StatusPill><p>{item.statement}</p><small>{item.concept} · linked to {item.sourceEventIds.length} event</small><button onClick={() => update((current) => ({ ...current, students: current.students.map((profile) => profile.id === student.id ? { ...profile, evidence: profile.evidence.filter((evidence) => evidence.id !== item.id) } : profile) }))}><Trash2 size={14} />Delete</button></div>) : <p className="empty-copy">No AI proposal has been saved as evidence.</p>}</div><footer><Languages size={15} />Preferred language: {student.preferredLanguage === "es" ? "Spanish" : "English"}<span>{student.retention}</span></footer></article>)}</div></main>;
}

function SummaryView({ state, update }: { state: AppState; update: (recipe: (current: AppState) => AppState) => void }) {
  const summary = state.summary;
  return <main className="wide-view summary-view"><div className="wide-view-head"><div><span className="attention-kicker"><FileText size={15} />Editable teacher coach</span><h1>Lesson summary</h1><p>Supportive reflection grounded in reviewed events — no teacher or student scores.</p></div><button className="secondary-button"><Download size={16} />Export summary</button></div><div className="summary-grid"><section className="summary-main"><div className="summary-title"><div><span>Lesson</span><h2>{summary.topic}</h2></div><div><span>Duration</span><h2>{summary.durationMinutes || 14} min</h2></div></div><SummaryBlock title="Concepts that produced questions" items={summary.conceptsWithQuestions} /><SummaryBlock title="Interventions and checks" items={[...summary.interventionNotes, ...summary.checkResults]} empty="No teacher-approved intervention completed yet." /><SummaryBlock title="Suggested check-ins" items={summary.followUpStudents} empty="No check-ins suggested yet." /><label className="notes-field">Teacher notes<textarea value={summary.teacherNotes} placeholder="Add context, corrections, or plans…" onChange={(event) => update((current) => ({ ...current, summary: { ...current.summary, teacherNotes: event.target.value } }))} /></label></section><aside className="coach-card"><span><Sparkles />Suggested next activity</span><h2>Independent number-line check</h2><p>{summary.suggestedNextActivity}</p><button className="primary-button" onClick={() => update((current) => ({ ...current, summary: { ...current.summary, teacherNotes: `${current.summary.teacherNotes}${current.summary.teacherNotes ? "\n" : ""}Follow-up saved: independent decimal number-line check.` } }))}>Save to next lesson</button><hr /><h3>Data quality note</h3><p>{summary.uncertainty}</p><h3>Participation pattern</h3><p>{summary.participationNote}</p></aside></div></main>;
}

function SummaryBlock({ title, items, empty }: { title: string; items: string[]; empty?: string }) {
  return <section className="summary-block"><h3>{title}</h3>{items.length ? items.map((item) => <p key={item}><span>•</span>{item}</p>) : <p className="empty-copy">{empty}</p>}</section>;
}
