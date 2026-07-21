import { Activity, CheckCircle2, FlaskConical, Info, ShieldCheck } from "lucide-react";
import { bridgeRegistry } from "../../components/bridges/registry";
import { Logo } from "../../components/shared/Logo";

const metrics = [
  ["Transcript fixtures", "2 / 2", "Synthetic English and Spanish decimal questions"],
  ["Bridge selection", "4 / 4", "Deterministic concept-to-tool fixtures"],
  ["Raw media retained", "0 bytes", "Expected default; checked by design contract"],
  ["False-positive review", "Tracked", "Dismissal remains separate from evidence"],
  ["Question → suggestion", "< 1 sec", "Local fixture target, not a field benchmark"],
  ["Hand-raise adapter", "Simulated", "Licensed parity dataset not bundled"],
];

export default function EvaluationPage() {
  return <main className="info-page eval-page"><nav><Logo /><a href="/teacher">Open teacher dashboard</a></nav><header><span className="hero-kicker"><FlaskConical size={15} />Prototype evaluation harness</span><h1>Metrics with honest boundaries.</h1><p>These checks validate software behavior and deterministic fixtures. They do not demonstrate learning improvement, detector fairness, or classroom effectiveness.</p></header><div className="warning-banner"><Info /><p><strong>Prototype metrics only.</strong> Parity testing across lighting, seating position, skin tone, accent, and language requires appropriately licensed or synthetic datasets and community review. This repository defines the harness fields but makes no fairness claim.</p></div><section className="metric-grid">{metrics.map(([label, value, detail]) => <article key={label}><span>{label}</span><h2>{value}</h2><p>{detail}</p></article>)}</section><section className="registry-table"><div className="registry-head"><div><span className="hero-kicker"><Activity size={15} />Trusted component registry</span><h2>Schema-validated whiteboard tools</h2></div><ShieldCheck /></div><div className="table-wrap"><table><thead><tr><th>Bridge</th><th>Concept</th><th>Grade</th><th>Duration</th><th>Review</th></tr></thead><tbody>{Object.values(bridgeRegistry).map((bridge) => <tr key={bridge.id}><td><strong>{bridge.id}</strong><small>v{bridge.version}</small></td><td>{bridge.concept}</td><td>{bridge.gradeBand}</td><td>{bridge.durationSeconds}s</td><td><span className={bridge.reviewStatus === "reviewed" ? "reviewed" : "prototype"}><CheckCircle2 />{bridge.reviewStatus}</span></td></tr>)}</tbody></table></div></section></main>;
}
