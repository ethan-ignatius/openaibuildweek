import {
  AlertTriangle,
  Brain,
  Check,
  Database,
  ExternalLink,
  FileCheck2,
  History,
  Printer,
  ShieldCheck,
  X,
} from "lucide-react";
import classroomVisual from "../../classroom-compass/public/og.png";
import {
  evaluationSummary,
  memoryConditions,
  reportLinks,
} from "./results";

const numberFormatter = new Intl.NumberFormat("en-US");

function percentPoints(value: number) {
  return `${(value * 100).toFixed(2)} pts`;
}

function decimal(value: number) {
  return value.toFixed(4);
}

function tokens(value: number) {
  return numberFormatter.format(value);
}

function ConditionMark({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="condition-mark mark-on" aria-label="Included" title="Included">
      <Check aria-hidden="true" size={17} strokeWidth={2.4} />
    </span>
  ) : (
    <span
      className="condition-mark mark-off"
      aria-label="Not included"
      title="Not included"
    >
      <X aria-hidden="true" size={16} strokeWidth={2.2} />
    </span>
  );
}

function SourceLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="source-link" href={href} rel="noreferrer" target="_blank">
      {children}
      <ExternalLink aria-hidden="true" size={15} />
    </a>
  );
}

function AucChart() {
  return (
    <figure className="chart-block" aria-labelledby="auc-chart-title">
      <figcaption>
        <span className="section-index">01</span>
        <div>
          <p className="section-kicker">Primary externally anchored result</p>
          <h2 id="auc-chart-title">Future-answer discrimination</h2>
        </div>
      </figcaption>
      <p className="chart-intro">
        After each real chronological learner segment, the next response stayed hidden.
        Higher AUC means the system ranked likely success more accurately.
      </p>
      <div
        className="bar-chart auc-chart"
        role="img"
        aria-label="AUC: Stateless GPT-5.6 0.6357, GPT-5.6 full history 0.7000, Teacher Brain notes 0.7143"
      >
        {memoryConditions.map((condition) => (
          <div className="bar-row" key={condition.id}>
            <div className="bar-heading">
              <span>{condition.label}</span>
              <strong>{decimal(condition.auc)}</strong>
            </div>
            <div className="bar-track" aria-hidden="true">
              <span
                className={`bar-fill bar-${condition.id}`}
                style={{ width: `${condition.auc * 100}%` }}
              />
            </div>
          </div>
        ))}
        <div className="chart-scale" aria-hidden="true">
          <span>0</span>
          <span>0.5</span>
          <span>1.0</span>
        </div>
      </div>
      <div className="chart-callout">
        <Brain aria-hidden="true" size={22} />
        <p>
          <strong>
            +{percentPoints(evaluationSummary.notesVsStatelessAucLift)} over stateless
          </strong>
          <span>
            +{percentPoints(evaluationSummary.notesVsHistoryAucLift)} over the stronger
            full-history comparator.
          </span>
        </p>
      </div>
    </figure>
  );
}

function TokenChart() {
  const maxTokens = Math.max(
    ...memoryConditions.map((condition) => condition.inputTokens),
  );
  return (
    <figure className="chart-block token-block" aria-labelledby="token-chart-title">
      <figcaption>
        <span className="section-index">02</span>
        <div>
          <p className="section-kicker">Long-horizon context cost</p>
          <h2 id="token-chart-title">Input tokens processed</h2>
        </div>
      </figcaption>
      <p className="chart-intro">
        Full history repeatedly resends every observed interaction. Teacher Brain carries
        a bounded, human-readable learner note instead.
      </p>
      <div
        className="bar-chart token-chart"
        role="img"
        aria-label="Input tokens: Stateless 3,474, full history 72,510, Teacher Brain 46,807"
      >
        {memoryConditions.map((condition) => (
          <div className="bar-row" key={condition.id}>
            <div className="bar-heading">
              <span>{condition.shortLabel}</span>
              <strong>{tokens(condition.inputTokens)}</strong>
            </div>
            <div className="bar-track" aria-hidden="true">
              <span
                className={`bar-fill bar-${condition.id}`}
                style={{ width: `${(condition.inputTokens / maxTokens) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="chart-callout efficiency-callout">
        <History aria-hidden="true" size={22} />
        <p>
          <strong>
            {(evaluationSummary.inputTokenReductionVsHistory * 100).toFixed(1)}% fewer
            input tokens
          </strong>
          <span>
            Teacher Brain also used {(
              evaluationSummary.totalTokenReductionVsHistory * 100
            ).toFixed(1)}% fewer total tokens than full history.
          </span>
        </p>
      </div>
    </figure>
  );
}

function ConditionTable() {
  return (
    <div className="table-scroll">
      <table className="condition-table">
        <thead>
          <tr>
            <th scope="col">Condition</th>
            <th scope="col">Available evidence</th>
            <th scope="col">Persistent state</th>
            <th scope="col">Validated tool commit</th>
            <th scope="col">AUC</th>
            <th scope="col">Brier</th>
          </tr>
        </thead>
        <tbody>
          {memoryConditions.map((condition) => (
            <tr
              className={condition.id === "teacher-brain" ? "highlight-row" : undefined}
              key={condition.id}
            >
              <th scope="row">{condition.label}</th>
              <td data-label="Available evidence">{condition.context}</td>
              <td data-label="Persistent state">
                <ConditionMark enabled={condition.persistentState} />
              </td>
              <td data-label="Validated tool commit">
                <ConditionMark enabled={condition.toolCommit} />
              </td>
              <td data-label="AUC">{decimal(condition.auc)}</td>
              <td data-label="Brier">{decimal(condition.brier)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountingTable() {
  return (
    <div className="table-scroll">
      <table className="accounting-table">
        <thead>
          <tr>
            <th scope="col">Condition</th>
            <th scope="col">Input</th>
            <th scope="col">Output</th>
            <th scope="col">Total</th>
            <th scope="col">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {memoryConditions.map((condition) => (
            <tr key={condition.id}>
              <th scope="row">{condition.shortLabel}</th>
              <td data-label="Input">{tokens(condition.inputTokens)}</td>
              <td data-label="Output">{tokens(condition.outputTokens)}</td>
              <td data-label="Total">{tokens(condition.totalTokens)}</td>
              <td data-label="Est. cost">${condition.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceMetric({
  value,
  label,
  tone,
}: {
  value: string;
  label: string;
  tone: "lime" | "blue" | "coral";
}) {
  return (
    <div className={`headline-metric metric-${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function AppHeader() {
  return (
    <header className="site-header">
      <a className="wordmark" href="#top" aria-label="Teacher Brain evidence home">
        <span aria-hidden="true">TB</span>
        <strong>Teacher Brain</strong>
      </a>
      <nav aria-label="Evidence sections">
        <a href="#result">Result</a>
        <a href="#method">Method</a>
        <a href="#limits">Limits</a>
      </nav>
      <button
        className="print-button"
        onClick={() => window.print()}
        title="Print evidence brief"
        type="button"
      >
        <Printer aria-hidden="true" size={17} />
        <span>Print brief</span>
      </button>
    </header>
  );
}

export function App() {
  return (
    <>
      <AppHeader />
      <main id="top">
        <section className="intro-band" aria-labelledby="page-title">
          <div className="intro-copy">
            <div className="report-label">
              <span>Controlled evidence brief</span>
              <span>July 21, 2026</span>
            </div>
            <h1 id="page-title">Teacher Brain</h1>
            <p className="intro-thesis">
              The harness preserves more useful learner signal than stateless GPT-5.6,
              while using less input context than replaying a student&apos;s full history.
            </p>
            <div className="assurance-row" aria-label="Evaluation safeguards">
              <span>
                <Database aria-hidden="true" size={16} /> External outcomes
              </span>
              <span>
                <ShieldCheck aria-hidden="true" size={16} /> Same model
              </span>
              <span>
                <FileCheck2 aria-hidden="true" size={16} /> Targets withheld
              </span>
            </div>
          </div>
          <div className="headline-grid" aria-label="Headline evaluation findings">
            <EvidenceMetric
              label="AUC lift over stateless"
              tone="lime"
              value="+7.86 pts"
            />
            <EvidenceMetric
              label="AUC lift over full history"
              tone="blue"
              value="+1.43 pts"
            />
            <EvidenceMetric
              label="Fewer input tokens vs full history"
              tone="coral"
              value="35.4%"
            />
          </div>
          <p className="scope-note">
            Development-scale result: {evaluationSummary.predictions} predictions across{" "}
            {evaluationSummary.students} previously unused, pseudonymous learners.
          </p>
        </section>

        <section className="results-band" id="result" aria-label="Primary results">
          <div className="results-grid">
            <AucChart />
            <TokenChart />
          </div>
        </section>

        <section className="method-band" id="method" aria-labelledby="method-title">
          <div className="section-heading">
            <span className="section-index">03</span>
            <div>
              <p className="section-kicker">One model, three memory conditions</p>
              <h2 id="method-title">What the harness actually adds</h2>
              <p>
                Every condition predicted the same next answers from the same chronological
                points. Only the available memory machinery changed.
              </p>
            </div>
          </div>
          <ConditionTable />
          <div className="method-facts">
            <div>
              <strong>{evaluationSummary.chunkSize}</strong>
              <span>interactions per chronological chunk</span>
            </div>
            <div>
              <strong>{evaluationSummary.interactions.join(" / ")}</strong>
              <span>real interactions in the three trajectories</span>
            </div>
            <div>
              <strong>{evaluationSummary.developmentStudentsSkipped}</strong>
              <span>earlier development learners skipped</span>
            </div>
          </div>
        </section>

        <section className="tradeoff-band" aria-labelledby="tradeoff-title">
          <div className="section-heading compact-heading">
            <span className="section-index">04</span>
            <div>
              <p className="section-kicker">The complete accounting</p>
              <h2 id="tradeoff-title">Lift, with a real tradeoff</h2>
            </div>
          </div>
          <div className="tradeoff-layout">
            <div className="tradeoff-copy">
              <p>
                Teacher Brain&apos;s AUC was highest. Its Brier score, which measures
                probability calibration, was <strong>0.1723</strong>: better than stateless
                GPT-5.6 at <strong>0.1922</strong>, but behind full history at{" "}
                <strong>0.1662</strong>.
              </p>
              <p>
                The notes path reduced input and total tokens, but the extra tool-authored
                note output made this small run more expensive. The value is persistent,
                inspectable state, not a blanket cost reduction.
              </p>
            </div>
            <AccountingTable />
          </div>
        </section>

        <section className="limitation-band" id="limits" aria-labelledby="limits-title">
          <div className="limit-icon" aria-hidden="true">
            <AlertTriangle size={27} />
          </div>
          <div>
            <p className="section-kicker">Negative result retained</p>
            <h2 id="limits-title">NCTE did not show harness lift</h2>
            <p>
              Across {evaluationSummary.ncteDecisions} decisions in{" "}
              {evaluationSummary.ncteTranscripts} unseen transcripts, full Teacher Brain
              macro F1 was <strong>{decimal(evaluationSummary.ncteFullMacroF1)}</strong>
              {" "}versus <strong>{decimal(evaluationSummary.ncteBareMacroF1)}</strong> for
              bare GPT-5.6. The labels record what the human teacher did, not every valid
              teaching move, so this measures teacher-move matching rather than complete
              teaching quality.
            </p>
          </div>
          <SourceLink href={reportLinks.ncte}>Open NCTE report</SourceLink>
        </section>

        <section className="classroom-band" aria-labelledby="classroom-title">
          <div className="classroom-copy">
            <span className="section-index">05</span>
            <div>
              <p className="section-kicker">What the benchmark supports</p>
              <h2 id="classroom-title">Memory that can travel into the room</h2>
              <p>
                The evaluation isolates the persistent learner-state layer. In the live
                classroom, that same state informs interruption responses, assignment
                recommendations, participation choices, and explanations on the projected
                visual board.
              </p>
            </div>
          </div>
          <figure className="classroom-visual">
            <img
              alt="Classroom Compass visual bridge comparing decimal hundred grids and a number line"
              src={classroomVisual}
            />
            <figcaption>
              The projected visual layer is operational proof; the metrics above isolate
              learner-memory quality against external outcomes.
            </figcaption>
          </figure>
        </section>

        <section className="source-band" aria-labelledby="source-title">
          <div>
            <p className="section-kicker">Audit the claim</p>
            <h2 id="source-title">Reports, protocol, and replay</h2>
          </div>
          <div className="source-links">
            <SourceLink href={reportLinks.memory}>Learner-memory report</SourceLink>
            <SourceLink href={reportLinks.methodology}>Evaluation methodology</SourceLink>
          </div>
          <p>
            Full model requests, responses, tool calls, state mutations, latency, and token
            accounting are preserved in gitignored JSONL session journals. Licensed NCTE
            transcript text remains local and is not published by this page.
          </p>
        </section>
      </main>
      <footer>
        <span>Teacher Brain evidence brief</span>
        <span>The model reasons. The harness remembers and acts.</span>
      </footer>
    </>
  );
}
