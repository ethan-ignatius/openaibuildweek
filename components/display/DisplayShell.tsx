"use client";

import { Captions, Maximize, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useState } from "react";
import { DecimalBridge } from "../bridges/DecimalBridge";
import { Logo } from "../shared/Logo";
import { usePublicDisplayState } from "../shared/use-classroom-state";

export function DisplayShell() {
  const { state, connection } = usePublicDisplayState();
  const [muted, setMuted] = useState(true);
  const [captions, setCaptions] = useState(true);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(65);

  if (!state) return <main className="display-loading" role="status"><Logo /><div className="pulse-dot" />Connecting to teacher controls…</main>;
  const bridge = state.activeBridge;
  return (
    <div className="display-shell">
      <header className="display-header">
        <Logo />
        <div className="display-session"><strong>{state.session.title}</strong><span>{state.session.topic}</span></div>
        <div className="display-controls" aria-label="Classroom display controls">
          <span className={`display-status ${connection !== "saved" ? "is-warn" : ""}`}><i />{connection === "saved" ? "Connected" : connection}</span>
          <button aria-label={paused ? "Resume activity" : "Pause activity"} onClick={() => setPaused(!paused)}>{paused ? <Play /> : <Pause />}</button>
          <button aria-label={muted ? "Unmute prompts" : "Mute prompts"} onClick={() => setMuted(!muted)}>{muted ? <VolumeX /> : <Volume2 />}</button>
          <label className="display-volume"><span>Volume</span><input aria-label="Prompt volume" type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
          <button aria-label="Toggle captions" aria-pressed={captions} onClick={() => setCaptions(!captions)} className={captions ? "active" : ""}><Captions /></button>
          <button aria-label="Enter full screen" onClick={() => document.documentElement.requestFullscreen?.()}><Maximize /></button>
          {bridge && <button aria-label="Exit activity" onClick={() => fetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) })}><X /></button>}
        </div>
      </header>
      {paused ? <main className="display-idle"><span className="pause-orb"><Pause /></span><p>Activity paused</p><small>Your teacher can resume when everyone is ready.</small></main>
        : bridge?.status === "cancelled" ? <main className="display-idle"><span className="pause-orb"><X /></span><p>Activity closed</p><small>Returning control to your teacher.</small></main>
        : bridge ? <DecimalBridge bridge={bridge} />
        : <main className="display-idle welcome-display"><div className="display-orbit"><span>0.35</span><span>0.40</span></div><p>Comparing Decimals</p><small>Ready for a teacher-approved Visual Bridge</small></main>}
      {captions && bridge && <div className="caption-bar">Visual instructions are shown on screen. Audio prompts are {muted ? "muted" : "on"}.</div>}
    </div>
  );
}
