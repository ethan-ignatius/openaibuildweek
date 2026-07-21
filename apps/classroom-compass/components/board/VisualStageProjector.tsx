"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Atom, BookOpen, Calculator, CircleHelp, Clock3, Cloud, Divide, Droplets, Globe2, Leaf,
  Lightbulb, Map, MessageCircle, PawPrint, Plus, Scale, Shapes, Sun, Users,
  type LucideIcon,
} from "lucide-react";
import type { BoardElement, VisualStageScene } from "../../headless/whiteboard/excalidraw-tool";

const controlUrl = process.env.NEXT_PUBLIC_CC_CONTROL_URL ?? "http://127.0.0.1:4317";
const stageWidth = 1440;
const stageHeight = 810;

type DelayedStyle = CSSProperties & { "--stage-delay": string };
type ShapeElement = Extract<BoardElement, { type: "rectangle" | "ellipse" | "diamond" }>;
type VisualSymbol = NonNullable<ShapeElement["symbol"]>;

const symbolIcons: Record<VisualSymbol, LucideIcon> = {
  idea: Lightbulb,
  number: Calculator,
  groups: Users,
  plus: Plus,
  divide: Divide,
  sun: Sun,
  earth: Globe2,
  cloud: Cloud,
  water: Droplets,
  plant: Leaf,
  animal: PawPrint,
  atom: Atom,
  book: BookOpen,
  clock: Clock3,
  people: Users,
  scale: Scale,
  shapes: Shapes,
  map: Map,
  speech: MessageCircle,
  question: CircleHelp,
};

function delayedStyle(index: number): DelayedStyle {
  return { "--stage-delay": `${Math.min(index * 22, 900)}ms` };
}

function linePath(element: Extract<BoardElement, { type: "line" | "arrow" }>) {
  return element.points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${element.x + x} ${element.y + y}`).join(" ");
}

function midpoint(element: Extract<BoardElement, { type: "line" | "arrow" }>) {
  const first = element.points[0];
  const last = element.points.at(-1) ?? first;
  return { x: element.x + (first[0] + last[0]) / 2, y: element.y + (first[1] + last[1]) / 2 };
}

function SvgText({ element, index }: { element: Extract<BoardElement, { type: "text" }>; index: number }) {
  const lines = element.text.split("\n");
  const size = element.fontSize ?? 28;
  const isEyebrow = /(?:kicker|label|path-label)$/.test(element.id);
  const isCardTitle = /concept-\d+-label/.test(element.id);
  return (
    <text
      className={`visual-stage-text ${size >= 34 ? "visual-stage-display-text" : ""} ${isEyebrow ? "visual-stage-eyebrow" : ""} ${isCardTitle ? "visual-stage-card-title" : ""}`}
      x={element.x}
      y={element.y}
      fill={element.strokeColor ?? "#17211b"}
      fontSize={size}
      textAnchor={element.textAlign === "center" ? "middle" : element.textAlign === "right" ? "end" : "start"}
      dominantBaseline="hanging"
      style={delayedStyle(index)}
    >
      {lines.map((line, lineIndex) => <tspan key={`${element.id}-${lineIndex}`} x={element.x} dy={lineIndex === 0 ? 0 : size * 1.28}>{line}</tspan>)}
    </text>
  );
}

function ShapeLabel({ element }: { element: ShapeElement }) {
  if (!element.label) return null;
  return <text className="visual-stage-shape-label" x={element.x + element.width / 2} y={element.y + element.height / 2} textAnchor="middle" dominantBaseline="middle">{element.label}</text>;
}

function ShapeSymbol({ element }: { element: ShapeElement }) {
  if (!element.symbol) return null;
  const Icon = symbolIcons[element.symbol];
  const size = Math.min(40, element.width * 0.72, element.height * 0.72);
  return (
    <foreignObject x={element.x} y={element.y} width={element.width} height={element.height} pointerEvents="none">
      <span className="visual-stage-symbol" style={{ color: element.strokeColor ?? "#1d2b53" }} aria-hidden="true">
        <Icon size={size} strokeWidth={2.4} />
      </span>
    </foreignObject>
  );
}

function SvgShape({ element, index }: { element: ShapeElement; index: number }) {
  const compact = element.width < 45 || element.height < 45;
  const common = {
    className: `visual-stage-shape ${compact ? "is-compact" : ""}`,
    stroke: element.strokeColor ?? "#17211b",
    strokeWidth: element.strokeWidth ?? 2,
    opacity: (element.opacity ?? 100) / 100,
    fill: element.fillStyle === "hachure"
      ? "url(#stage-hachure)"
      : element.fillStyle === "cross-hatch"
        ? "url(#stage-cross-hatch)"
        : element.backgroundColor === "#e8f1ff"
          ? "url(#stage-card-blue)"
          : element.backgroundColor === "#efe9ff"
            ? "url(#stage-card-purple)"
            : element.backgroundColor === "#ffe9e4"
              ? "url(#stage-card-coral)"
              : element.backgroundColor === "#def6f2"
                ? "url(#stage-card-teal)"
                : element.backgroundColor ?? "#fffdf7",
    style: delayedStyle(index),
  };
  let shape: ReactNode;
  if (element.type === "rectangle") {
    const isTeachingCard = /(?:panel|concept-\d)$/.test(element.id);
    shape = <rect {...common} data-stage-id={element.id} x={element.x} y={element.y} width={element.width} height={element.height} rx={compact ? 2 : isTeachingCard ? 28 : Math.min(18, element.height / 5)} />;
  } else if (element.type === "ellipse") {
    shape = <ellipse {...common} data-stage-id={element.id} cx={element.x + element.width / 2} cy={element.y + element.height / 2} rx={element.width / 2} ry={element.height / 2} />;
  } else {
    shape = <polygon {...common} data-stage-id={element.id} points={`${element.x + element.width / 2},${element.y} ${element.x + element.width},${element.y + element.height / 2} ${element.x + element.width / 2},${element.y + element.height} ${element.x},${element.y + element.height / 2}`} />;
  }
  return <g className="visual-stage-shape-group" style={delayedStyle(index)}>{shape}<ShapeLabel element={element} /><ShapeSymbol element={element} /></g>;
}

function SvgLine({ element, index }: { element: Extract<BoardElement, { type: "line" | "arrow" }>; index: number }) {
  const center = midpoint(element);
  return (
    <g className="visual-stage-connector" style={delayedStyle(index)}>
      <path
        d={linePath(element)}
        fill="none"
        stroke={element.strokeColor ?? "#17211b"}
        strokeWidth={element.strokeWidth ?? 2}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={element.type === "arrow" ? "url(#stage-arrow)" : undefined}
      />
      {element.label ? <text className="visual-stage-line-label" x={center.x} y={center.y - 10} textAnchor="middle" paintOrder="stroke" stroke="#fffdf7" strokeWidth="9">{element.label}</text> : null}
    </g>
  );
}

export function VisualScene({ scene }: { scene: VisualStageScene }) {
  const description = useMemo(() => scene.elements
    .filter((element): element is Extract<BoardElement, { type: "text" }> => element.type === "text")
    .map((element) => element.text.replace(/\n/g, " "))
    .slice(0, 12)
    .join(". "), [scene]);

  return (
    <svg className="visual-stage-svg" viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="visual-stage-title" aria-describedby="visual-stage-description">
      <title id="visual-stage-title">{scene.title}</title>
      <desc id="visual-stage-description">{description || "Classroom Compass instructional visual"}</desc>
      <defs>
        <pattern id="stage-dots" width="72" height="72" patternUnits="userSpaceOnUse"><circle cx="8" cy="9" r="2" fill="#2f5fb3" opacity=".08" /><path d="M54 55h10M59 50v10" stroke="#6f4cc3" strokeWidth="1.5" opacity=".06" /></pattern>
        <pattern id="stage-hachure" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="10" height="10" fill="#e5f1eb" /><line x1="0" y1="0" x2="0" y2="10" stroke="#78a18d" strokeWidth="2" opacity=".5" /></pattern>
        <pattern id="stage-cross-hatch" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="#edf3e3" /><path d="M0 0L12 12M12 0L0 12" stroke="#7e9461" strokeWidth="1.4" opacity=".45" /></pattern>
        <linearGradient id="stage-background" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fffaf0" /><stop offset=".48" stopColor="#f7fbff" /><stop offset="1" stopColor="#f3efff" /></linearGradient>
        <linearGradient id="stage-card-blue" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f4f9ff" /><stop offset="1" stopColor="#dceaff" /></linearGradient>
        <linearGradient id="stage-card-purple" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#faf7ff" /><stop offset="1" stopColor="#e8deff" /></linearGradient>
        <linearGradient id="stage-card-coral" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fff8f5" /><stop offset="1" stopColor="#ffdcd3" /></linearGradient>
        <linearGradient id="stage-card-teal" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f4fffd" /><stop offset="1" stopColor="#d2f3ed" /></linearGradient>
        <filter id="stage-shadow" x="-20%" y="-20%" width="140%" height="170%"><feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="#24355f" floodOpacity=".13" /></filter>
        <marker id="stage-arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M1 1L10 6L1 11" fill="none" stroke="#9a5b16" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></marker>
      </defs>
      <rect width={stageWidth} height={stageHeight} fill="url(#stage-background)" />
      <rect width={stageWidth} height={stageHeight} fill="url(#stage-dots)" />
      <circle cx="1370" cy="38" r="120" fill="#ffd95c" opacity=".12" aria-hidden="true" />
      <circle cx="35" cy="785" r="150" fill="#6f4cc3" opacity=".08" aria-hidden="true" />
      <g key={`${scene.sceneId}-${scene.revision}`} className="visual-stage-scene">
        {scene.elements.map((element, index) => {
          if (element.type === "text") return <SvgText key={element.id} element={element} index={index} />;
          if ("points" in element) return <SvgLine key={element.id} element={element} index={index} />;
          return <SvgShape key={element.id} element={element} index={index} />;
        })}
      </g>
    </svg>
  );
}

export function VisualStageProjector() {
  const [scene, setScene] = useState<VisualStageScene | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">("connecting");
  const lastRevision = useRef(-1);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${controlUrl}/board`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Board service returned ${response.status}`);
        const candidate = await response.json() as VisualStageScene;
        if (!disposed && candidate.revision !== lastRevision.current) {
          lastRevision.current = candidate.revision;
          setScene(candidate);
        }
        if (!disposed) setConnection("connected");
      } catch {
        if (!disposed) setConnection("offline");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 350);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  const unavailable = !scene || connection !== "connected" || scene.status === "paused" || scene.status === "closed";
  return (
    <main className="visual-stage-projector">
      {scene ? <VisualScene scene={scene} /> : null}
      {unavailable ? (
        <section className="projector-status" role="status">
          <span className={`projector-dot ${connection}`} />
          <strong>{scene?.status === "paused" ? "Activity paused" : scene?.status === "closed" ? "Session ended" : connection === "offline" ? "Waiting for the local tutor service" : "Connecting to Classroom Compass"}</strong>
          <small>No camera, microphone, transcript, or student profile data is shown here.</small>
        </section>
      ) : null}
      <aside className="projector-badge" aria-label={`Visual stage ${connection}`}>
        <span className={`projector-dot ${connection}`} />
        Local Visual Stage · {scene?.source === "agent-drawing" ? "validated diagram" : "reviewed visual"}
      </aside>
    </main>
  );
}
