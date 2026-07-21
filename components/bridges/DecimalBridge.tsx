"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Check, Lightbulb, RotateCcw } from "lucide-react";
import type { BridgeRun } from "../../domain/types";

const copy = {
  en: {
    eyebrow: "Visual Bridge · Decimal comparison",
    reframe: "Same value, clearer places",
    reframeBody: "Adding a zero to the right does not change the value. It helps us compare the same places.",
    interact: "Build each amount",
    interactBody: "Each grid is one whole. Every small square is one hundredth.",
    connect: "Connect it to the number line",
    connectBody: "Move each marker, then check where it belongs between 0 and 1.",
    check: "Which value is greater?",
    next: "Next",
    reveal35: "Reveal 35 hundredths",
    reveal40: "Reveal 40 hundredths",
    snap: "Snap to value",
    retry: "Try again",
    hint: "Hint: compare tenths first. 0.35 has 3 tenths; 0.40 has 4 tenths.",
    complete: "Nice comparison",
    completeBody: "0.40 is 40 hundredths. That is 5 hundredths more than 0.35.",
    return: "Return control to your teacher",
  },
  es: {
    eyebrow: "Puente visual · Comparación decimal",
    reframe: "El mismo valor, lugares más claros",
    reframeBody: "Agregar un cero a la derecha no cambia el valor. Nos ayuda a comparar los mismos lugares.",
    interact: "Construye cada cantidad",
    interactBody: "Cada cuadrícula es un entero. Cada cuadrito es un centésimo.",
    connect: "Conéctalo con la recta numérica",
    connectBody: "Mueve cada marcador y comprueba dónde va entre 0 y 1.",
    check: "¿Qué valor es mayor?",
    next: "Siguiente",
    reveal35: "Muestra 35 centésimos",
    reveal40: "Muestra 40 centésimos",
    snap: "Ajustar al valor",
    retry: "Inténtalo de nuevo",
    hint: "Pista: compara primero los décimos. 0.35 tiene 3 décimos; 0.40 tiene 4.",
    complete: "Buena comparación",
    completeBody: "0.40 son 40 centésimos. Son 5 centésimos más que 0.35.",
    return: "Devuelve el control a tu docente",
  },
};

async function bridgeAction(payload: object) {
  await fetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  new BroadcastChannel("classroom-compass-session").postMessage("updated");
}

function HundredGrid({ value, label }: { value: number; label: string }) {
  const target = Math.round(value * 100);
  const [shaded, setShaded] = useState<Set<number>>(new Set());
  const reveal = () => {
    setShaded(new Set(Array.from({ length: target }, (_, index) => index)));
    void bridgeAction({ action: "interaction", detail: `Revealed ${target} hundredths` });
  };
  return (
    <div className="grid-card">
      <div className="grid-heading"><strong>{label}</strong><span>{shaded.size} / 100</span></div>
      <div className="hundred-grid" role="grid" aria-label={`${label}, ${shaded.size} hundredths shaded`}>
        {Array.from({ length: 100 }, (_, index) => (
          <button
            key={index}
            type="button"
            role="gridcell"
            aria-label={`Hundredth ${index + 1}`}
            aria-selected={shaded.has(index)}
            className={shaded.has(index) ? "grid-cell shaded" : "grid-cell"}
            onClick={() => setShaded((current) => {
              const next = new Set(current);
              if (next.has(index)) next.delete(index); else next.add(index);
              return next;
            })}
          />
        ))}
      </div>
      <button className="secondary-button wide" type="button" onClick={reveal}>{target === 35 ? copy.en.reveal35 : copy.en.reveal40}</button>
    </div>
  );
}

function PlaceValueChart() {
  return (
    <div className="place-chart" role="table" aria-label="Place value comparison">
      <div className="place-row place-head" role="row"><span>ones</span><span>·</span><span>tenths</span><span>hundredths</span></div>
      <div className="place-row" role="row"><span>0</span><b>.</b><span>3</span><span>5</span><em>35 hundredths</em></div>
      <div className="place-row emphasis" role="row"><span>0</span><b>.</b><span>4</span><span>0</span><em>40 hundredths</em></div>
    </div>
  );
}

function NumberLine() {
  const [a, setA] = useState(18);
  const [b, setB] = useState(72);
  const ticks = useMemo(() => Array.from({ length: 11 }, (_, i) => i / 10), []);
  return (
    <div className="number-line-card">
      <div className="line-ticks">{ticks.map((tick) => <span key={tick}>{tick === 0 || tick === 0.5 || tick === 1 ? tick.toFixed(tick === 0 || tick === 1 ? 0 : 1) : ""}</span>)}</div>
      <label className="range-label"><b>0.35</b><input aria-label="Position 0.35" type="range" min="0" max="100" value={a} onChange={(e) => setA(Number(e.target.value))} /><output>{(a / 100).toFixed(2)}</output><button onClick={() => setA(35)}>{copy.en.snap}</button></label>
      <label className="range-label accent"><b>0.40</b><input aria-label="Position 0.40" type="range" min="0" max="100" value={b} onChange={(e) => setB(Number(e.target.value))} /><output>{(b / 100).toFixed(2)}</output><button onClick={() => setB(40)}>{copy.en.snap}</button></label>
      {a === 35 && b === 40 && <p className="line-insight"><Check size={18} /> 0.40 sits farther to the right, so it is greater.</p>}
    </div>
  );
}

export function DecimalBridge({ bridge }: { bridge: BridgeRun }) {
  const t = copy[bridge.language];
  const [answering, setAnswering] = useState(false);
  const hasHint = bridge.stage === 4 && bridge.result && !bridge.result.correct;

  const answer = async (value: string) => {
    setAnswering(true);
    await bridgeAction({ action: "answer", answer: value });
    setAnswering(false);
  };

  return (
    <main className="bridge-stage" data-testid={`bridge-stage-${bridge.stage}`}>
      <p className="bridge-eyebrow">{t.eyebrow}</p>
      {bridge.stage === 1 && <section className="bridge-panel centered">
        <span className="stage-chip">1 · Reframe</span>
        <h1>{t.reframe}</h1><p className="bridge-lede">{t.reframeBody}</p>
        <div className="equivalence"><span>0.4</span><span>=</span><strong>0.40</strong></div>
        <PlaceValueChart />
        <button className="display-primary" onClick={() => bridgeAction({ action: "next_stage" })}>{t.next}<ArrowRight /></button>
      </section>}

      {bridge.stage === 2 && <section className="bridge-panel">
        <span className="stage-chip">2 · Interact</span><h1>{t.interact}</h1><p className="bridge-lede">{t.interactBody}</p>
        <div className="grids"><HundredGrid value={0.35} label="0.35" /><div className="comparison-mark" aria-hidden="true">&lt;</div><HundredGrid value={0.4} label="0.40" /></div>
        <button className="display-primary center-button" onClick={() => bridgeAction({ action: "next_stage" })}>{t.next}<ArrowRight /></button>
      </section>}

      {bridge.stage === 3 && <section className="bridge-panel centered">
        <span className="stage-chip">3 · Connect</span><h1>{t.connect}</h1><p className="bridge-lede">{t.connectBody}</p>
        <NumberLine />
        <button className="display-primary" onClick={() => bridgeAction({ action: "next_stage" })}>{t.next}<ArrowRight /></button>
      </section>}

      {bridge.stage === 4 && <section className="bridge-panel centered check-panel">
        <span className="stage-chip">4 · Check</span><h1>{t.check}</h1>
        <div className="check-expression"><span>0.35</span><span>?</span><span>0.40</span></div>
        <div className="answer-options">
          {["0.35", "0.40", "They are equal"].map((option) => <button disabled={answering} data-testid={`answer-${option}`} key={option} onClick={() => answer(option)}>{option}</button>)}
        </div>
        {hasHint && <div className="hint" role="status"><Lightbulb /> <span><strong>{t.retry}</strong>{t.hint}</span><RotateCcw /></div>}
      </section>}

      {bridge.stage === 5 && <section className="bridge-panel centered completion-panel">
        <span className="completion-check"><Check size={38} /></span>
        <span className="stage-chip">5 · Return</span><h1>{t.complete}</h1><p className="bridge-lede">{t.completeBody}</p>
        <div className="completion-equation"><b>0.40</b><span>&gt;</span><b>0.35</b><small>by 0.05</small></div>
        <p className="teacher-return">{t.return}</p>
      </section>}
    </main>
  );
}
