import { z } from "zod";
import type { TutorTurn } from "../reasoning/tutor-provider";
import {
  teacherBrainPlanSchema,
  type TeacherBrainBoardAction,
} from "../reasoning/teacher-brain-provider";

const coordinate = z.number().finite().min(-4_000).max(4_000);
const dimension = z.number().finite().positive().max(4_000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = z.tuple([coordinate, coordinate]);

const sharedShape = {
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  x: coordinate,
  y: coordinate,
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  strokeWidth: z.number().int().min(1).max(4).optional(),
  opacity: z.number().int().min(20).max(100).optional(),
};

const boxElementSchema = z.object({
  ...sharedShape,
  type: z.enum(["rectangle", "ellipse", "diamond"]),
  width: dimension,
  height: dimension,
  fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional(),
  label: z.string().max(120).optional(),
});

const textElementSchema = z.object({
  id: sharedShape.id,
  type: z.literal("text"),
  x: coordinate,
  y: coordinate,
  text: z.string().min(1).max(500),
  fontSize: z.number().int().min(12).max(72).optional(),
  strokeColor: color.optional(),
  textAlign: z.enum(["left", "center", "right"]).optional(),
});

const linearElementSchema = z.object({
  ...sharedShape,
  type: z.enum(["line", "arrow"]),
  points: z.array(point).min(2).max(80),
  label: z.string().max(120).optional(),
});

export const boardElementSchema = z.discriminatedUnion("type", [
  boxElementSchema,
  textElementSchema,
  linearElementSchema,
]);

export const excalidrawSceneSchema = z.object({
  schemaVersion: z.literal(1),
  sceneId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  revision: z.number().int().nonnegative(),
  title: z.string().min(1).max(120),
  language: z.enum(["en", "es"]),
  status: z.enum(["idle", "active", "paused", "complete", "closed"]),
  source: z.enum(["reviewed-component", "agent-drawing"]),
  elements: z.array(boardElementSchema).max(320),
});

export type BoardElement = z.infer<typeof boardElementSchema>;
export type ExcalidrawScene = z.infer<typeof excalidrawSceneSchema>;

/**
 * Tool boundary for either reviewed components or an LLM diagram planner.
 * Only the returned public scene is available to the projector process.
 */
export class ExcalidrawBoardController {
  readonly id = "local-excalidraw-board@1.0.0";
  private scene: ExcalidrawScene = {
    schemaVersion: 1,
    sceneId: "classroom-compass-idle",
    revision: 0,
    title: "Classroom Compass",
    language: "en",
    status: "idle",
    source: "reviewed-component",
    elements: [],
  };

  render(candidate: unknown) {
    const validated = excalidrawSceneSchema.parse(candidate);
    const ids = new Set<string>();
    for (const element of validated.elements) {
      if (ids.has(element.id)) throw new Error(`Duplicate board element id: ${element.id}`);
      ids.add(element.id);
    }
    this.scene = structuredClone(validated);
    return this.snapshot();
  }

  setStatus(status: ExcalidrawScene["status"]) {
    this.scene = { ...this.scene, status, revision: this.scene.revision + 1 };
  }

  snapshot() {
    return structuredClone(this.scene);
  }
}

const palette = {
  ink: "#17211b",
  green: "#155f47",
  greenSoft: "#dcebe3",
  lime: "#d8ea83",
  paper: "#fffdf7",
  muted: "#647067",
  amber: "#9a5b16",
};

function text(id: string, value: string, x: number, y: number, fontSize = 28, strokeColor = palette.ink): BoardElement {
  return { id, type: "text", text: value, x, y, fontSize, strokeColor };
}

function wrapText(value: string, lineLength = 58, maxLines = 12) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > lineLength) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
    if (lines.length > maxLines) break;
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1].slice(0, Math.max(0, lineLength - 1))}…`].join("\n");
  return lines.join("\n");
}

export function tutorThinkingScene(revision: number): ExcalidrawScene {
  return {
    schemaVersion: 1,
    sceneId: "tutor-thinking",
    revision,
    title: "Thinking about the question",
    language: "en",
    status: "active",
    source: "agent-drawing",
    elements: [
      text("thinking-title", "Let’s think about that…", 420, 260, 48, palette.green),
      text("thinking-detail", "I’m preparing a short explanation and a visual.", 430, 350, 28, palette.muted),
      { id: "thinking-arrow", type: "arrow", x: 500, y: 440, points: [[0, 0], [360, 0]], strokeColor: palette.amber, strokeWidth: 3 },
    ],
  };
}

const regionOrigins = {
  top: { x: 80, y: 45 },
  left: { x: 70, y: 185 },
  center: { x: 470, y: 185 },
  right: { x: 990, y: 185 },
  scratch: { x: 70, y: 590 },
  bottom: { x: 470, y: 700 },
} as const;

/** Translate Teacher Brain's validated board actions into a bounded public scene. */
export function teacherBrainPlanScene(
  candidate: unknown,
  title: string,
  language: "en" | "es",
  revision: number,
): ExcalidrawScene {
  const plan = teacherBrainPlanSchema.parse(candidate);
  const elements: BoardElement[] = [];
  const usedIds = new Set<string>();
  const actionIds = new Map<string, string>();
  const regionOffsets: Record<keyof typeof regionOrigins, number> = {
    top: 0,
    left: 0,
    center: 0,
    right: 0,
    scratch: 0,
    bottom: 0,
  };
  let truncated = false;

  const uniqueId = (candidateId: string) => {
    const root = (candidateId.replace(/[^a-zA-Z0-9_-]/g, "-") || "element").slice(0, 72);
    let resolved = root;
    let suffix = 1;
    while (usedIds.has(resolved)) {
      resolved = `${root.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(resolved);
    return resolved;
  };
  const actionId = (raw: string) => {
    const existing = actionIds.get(raw);
    if (existing) return existing;
    const resolved = uniqueId(raw);
    actionIds.set(raw, resolved);
    return resolved;
  };
  const add = (...candidates: BoardElement[]) => {
    for (const element of candidates) {
      if (elements.length >= 318) {
        truncated = true;
        return;
      }
      elements.push(element);
    }
  };
  const place = (region: keyof typeof regionOrigins, height: number) => {
    const origin = regionOrigins[region];
    const placed = { x: origin.x, y: origin.y + regionOffsets[region] };
    regionOffsets[region] += height;
    return placed;
  };

  for (const action of plan.board_actions) {
    if (action.type === "board.clear" || action.type === "board.unhighlight") continue;
    if (action.type === "board.highlight") {
      applyHighlight(elements, actionIds.get(action.element_id), action.style);
      continue;
    }
    renderTeacherBrainAction(action, {
      add,
      actionId,
      uniqueId,
      place,
    });
  }
  if (truncated) {
    add(text(uniqueId("scene-truncated"), "Additional visual detail was omitted for projector safety.", 780, 760, 18, palette.amber));
  }

  return excalidrawSceneSchema.parse({
    schemaVersion: 1,
    sceneId: `teacher-brain-${revision}`,
    revision,
    title: title.slice(0, 120) || "Teacher Brain explanation",
    language,
    status: "active",
    source: "agent-drawing",
    elements,
  });
}

type TeacherBrainDrawingContext = {
  add: (...elements: BoardElement[]) => void;
  actionId: (raw: string) => string;
  uniqueId: (candidate: string) => string;
  place: (
    region: keyof typeof regionOrigins,
    height: number,
  ) => { x: number; y: number };
};

function renderTeacherBrainAction(
  action: Exclude<TeacherBrainBoardAction, { type: "board.clear" | "board.highlight" | "board.unhighlight" }>,
  context: TeacherBrainDrawingContext,
) {
  if (action.type === "board.write_text") {
    const at = context.place(action.region, 100);
    context.add(text(
      context.actionId(action.element_id),
      wrapText(action.text, action.region === "top" ? 90 : 44, 4).slice(0, 500),
      at.x,
      at.y,
      action.region === "top" ? 38 : 25,
      action.region === "top" ? palette.green : palette.ink,
    ));
    return;
  }
  if (action.type === "board.write_math") {
    const at = context.place(action.region, 100);
    context.add(text(
      context.actionId(action.element_id),
      plainMath(action.latex).slice(0, 500),
      at.x,
      at.y,
      38,
      palette.green,
    ));
    return;
  }
  if (action.type === "board.plot_function") {
    const id = context.actionId(action.element_id);
    const at = context.place("center", 230);
    context.add(
      text(context.uniqueId(`${id}-formula`), `f(x) = ${plainMath(action.expr)}`.slice(0, 500), at.x, at.y, 30, palette.green),
      { id: context.uniqueId(`${id}-x-axis`), type: "line", x: at.x, y: at.y + 130, points: [[0, 0], [430, 0]], strokeColor: palette.ink, strokeWidth: 2 },
      { id: context.uniqueId(`${id}-y-axis`), type: "line", x: at.x + 215, y: at.y + 45, points: [[0, 0], [0, 170]], strokeColor: palette.ink, strokeWidth: 2 },
      text(context.uniqueId(`${id}-domain`), `${action.domain[0]} ≤ x ≤ ${action.domain[1]}`, at.x + 115, at.y + 170, 18, palette.muted),
    );
    return;
  }
  if (action.type === "board.draw_number_line") {
    drawNumberLine(action, context);
    return;
  }
  if (action.type === "board.draw_fraction_bars") {
    drawFractionBars(action, context);
    return;
  }
  if (action.type === "board.render_custom") {
    const id = context.actionId(action.element_id);
    const at = context.place("center", 90);
    context.add(text(
      id,
      "Teacher Brain requested a custom diagram; raw SVG is intentionally not projected.",
      at.x,
      at.y,
      20,
      palette.muted,
    ));
    return;
  }
  if (action.type === "board.show_slide") {
    const at = context.place("center", 90);
    context.add(text(
      context.uniqueId("active-slide"),
      `Slide: ${action.slide_ref}`.slice(0, 500),
      at.x,
      at.y,
      24,
      palette.green,
    ));
  }
}

function drawNumberLine(
  action: Extract<TeacherBrainBoardAction, { type: "board.draw_number_line" }>,
  context: TeacherBrainDrawingContext,
) {
  const id = context.actionId(action.element_id);
  const at = context.place("center", 175);
  const width = 520;
  const span = action.max - action.min || 1;
  context.add(
    { id: context.uniqueId(`${id}-axis`), type: "line", x: at.x, y: at.y + 60, points: [[0, 0], [width, 0]], strokeColor: palette.ink, strokeWidth: 3 },
    text(context.uniqueId(`${id}-min`), String(action.min), at.x - 8, at.y + 88, 18),
    text(context.uniqueId(`${id}-max`), String(action.max), at.x + width - 8, at.y + 88, 18),
  );
  for (const [index, mark] of action.marks.slice(0, 16).entries()) {
    const ratio = Math.max(0, Math.min(1, (mark.value - action.min) / span));
    const x = at.x + ratio * width;
    context.add(
      { id: context.uniqueId(`${id}-tick-${index}`), type: "line", x, y: at.y + 47, points: [[0, 0], [0, 26]], strokeColor: palette.green, strokeWidth: 2 },
      text(context.uniqueId(`${id}-label-${index}`), (mark.label ?? String(mark.value)).slice(0, 80), x - 12, at.y + 20, 16, palette.green),
    );
  }
}

function drawFractionBars(
  action: Extract<TeacherBrainBoardAction, { type: "board.draw_fraction_bars" }>,
  context: TeacherBrainDrawingContext,
) {
  const id = context.actionId(action.element_id);
  const at = context.place("center", Math.min(4, action.fractions.length) * 72 + 35);
  for (const [row, fraction] of action.fractions.slice(0, 4).entries()) {
    const [numeratorText, denominatorText] = fraction.split("/");
    const numerator = Number(numeratorText);
    const denominator = Number(denominatorText);
    const y = at.y + row * 72;
    context.add(text(context.uniqueId(`${id}-fraction-${row}`), fraction, at.x, y + 12, 22, palette.green));
    if (denominator > 24) {
      context.add(
        { id: context.uniqueId(`${id}-summary-${row}`), type: "rectangle", x: at.x + 90, y, width: 500, height: 46, strokeColor: palette.green, backgroundColor: palette.paper, fillStyle: "solid", strokeWidth: 2 },
        text(context.uniqueId(`${id}-summary-label-${row}`), `${numerator} shaded of ${denominator} equal parts`, at.x + 120, y + 12, 18, palette.muted),
      );
      continue;
    }
    const cellWidth = Math.min(42, 500 / denominator);
    for (let index = 0; index < denominator; index += 1) {
      context.add({
        id: context.uniqueId(`${id}-cell-${row}-${index}`),
        type: "rectangle",
        x: at.x + 90 + index * cellWidth,
        y,
        width: cellWidth,
        height: 46,
        strokeColor: palette.green,
        backgroundColor: index < numerator ? palette.lime : palette.paper,
        fillStyle: "solid",
        strokeWidth: 1,
      });
    }
  }
}

function applyHighlight(
  elements: BoardElement[],
  target: string | undefined,
  style: "pulse" | "outline" | "fill",
) {
  if (!target) return;
  for (const element of elements) {
    if (element.id !== target && !element.id.startsWith(`${target}-`)) continue;
    element.strokeColor = style === "fill" ? palette.ink : palette.amber;
    if (element.type !== "text") {
      element.strokeWidth = style === "pulse" ? 4 : 3;
      if (style === "fill") element.backgroundColor = palette.lime;
    }
  }
}

function plainMath(value: string) {
  return value
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\(?:times|cdot)/g, "×")
    .replace(/\\leq?/g, "≤")
    .replace(/\\geq?/g, "≥")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function genericTutorScene(turn: TutorTurn, revision: number): ExcalidrawScene {
  const answerCopy = wrapText(turn.answer, 92, 6);
  const answerLines = Math.max(1, answerCopy.split("\n").length);
  const answerPanelHeight = Math.max(180, Math.min(260, 118 + answerLines * 30));
  const nodeTop = 145 + answerPanelHeight;
  const equationMatches = [...turn.answer.matchAll(/(-?\d+(?:\.\d+)?)\s*([+\-×÷*/])\s*(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)/g)];
  const arithmeticMatch = equationMatches.at(-1);
  const equation = arithmeticMatch?.[0];
  const conceptTop = nodeTop + (equation ? 72 : 0);
  const elements: BoardElement[] = [
    text("tutor-title", turn.visual.title, 70, 36, 40, palette.green),
    { id: "answer-panel", type: "rectangle", x: 65, y: 105, width: 1_310, height: answerPanelHeight, strokeColor: palette.green, backgroundColor: palette.paper, fillStyle: "solid", strokeWidth: 2 },
    text(
      "answer-label",
      turn.disposition === "defer" ? "A safe next step" : turn.disposition === "clarify" ? "Let’s make sure I heard you" : "Short answer",
      100,
      130,
      19,
      palette.muted,
    ),
    text("answer-copy", answerCopy, 100, 174, 24, palette.ink),
  ];
  if (equation) {
    elements.push(text("equation-callout", equation.replace("*", "×").replace("/", "÷"), 485, nodeTop + 6, 36, palette.green));
  }

  const nodes = arithmeticMatch
    ? [
        { label: arithmeticMatch[1], detail: "First number" },
        { label: arithmeticMatch[3], detail: "Second number" },
        { label: arithmeticMatch[4], detail: "Result" },
      ]
    : turn.visual.nodes;
  const connections = arithmeticMatch
    ? [
        { from: 0, to: 1, label: arithmeticMatch[2].replace("*", "×").replace("/", "÷") },
        { from: 1, to: 2, label: "=" },
      ]
    : turn.visual.connections;
  const columnCount = Math.min(3, Math.max(1, nodes.length));
  const nodeWidth = columnCount === 1 ? 520 : columnCount === 2 ? 500 : 380;
  const horizontalGap = columnCount === 1 ? 0 : columnCount === 2 ? 90 : 65;
  const totalWidth = columnCount * nodeWidth + (columnCount - 1) * horizontalGap;
  const startX = 720 - totalWidth / 2;
  const positions = nodes.map((_, index) => ({
    x: startX + (index % columnCount) * (nodeWidth + horizontalGap),
    y: conceptTop + Math.floor(index / columnCount) * 165,
    width: nodeWidth,
    height: 120,
    row: Math.floor(index / columnCount),
    column: index % columnCount,
  }));
  nodes.forEach((node, index) => {
    const position = positions[index];
    elements.push({
      id: `concept-${index}`,
      type: "rectangle",
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      strokeColor: palette.green,
      backgroundColor: index % 2 === 0 ? palette.greenSoft : palette.lime,
      fillStyle: index % 2 === 0 ? "hachure" : "solid",
      strokeWidth: 2,
    });
    elements.push(text(`concept-${index}-label`, wrapText(node.label, Math.max(22, Math.floor(position.width / 13)), 2), position.x + 22, position.y + 18, 22, palette.ink));
    if (node.detail.trim().toLowerCase() !== node.label.trim().toLowerCase()) {
      elements.push(text(`concept-${index}-detail`, wrapText(node.detail, Math.max(30, Math.floor(position.width / 9)), 3), position.x + 22, position.y + 59, 16, palette.muted));
    }
  });
  connections.forEach((connection, index) => {
    const from = positions[connection.from];
    const to = positions[connection.to];
    if (!from || !to) return;
    const sameRow = from.row === to.row;
    const startPoint = sameRow
      ? { x: from.x + (to.column > from.column ? from.width : 0), y: from.y + from.height / 2 }
      : { x: from.x + from.width / 2, y: from.y + from.height };
    const endPoint = sameRow
      ? { x: to.x + (to.column > from.column ? 0 : to.width), y: to.y + to.height / 2 }
      : { x: to.x + to.width / 2, y: to.y };
    const deltaX = endPoint.x - startPoint.x;
    const deltaY = endPoint.y - startPoint.y;
    const points: [number, number][] = sameRow
      ? [[0, 0], [deltaX, deltaY]]
      : [[0, 0], [0, deltaY / 2], [deltaX, deltaY / 2], [deltaX, deltaY]];
    elements.push({
      id: `connection-${index}`,
      type: "arrow",
      x: startPoint.x,
      y: startPoint.y,
      points,
      strokeColor: palette.amber,
      strokeWidth: 2,
      label: connection.label,
    });
  });
  if (turn.followUpQuestion) {
    const visualBottom = positions.length > 0 ? Math.max(...positions.map((position) => position.y + position.height)) : nodeTop;
    elements.push(text("follow-up", `Try next: ${wrapText(turn.followUpQuestion, 82, 2)}`, 75, Math.min(730, visualBottom + 45), 23, palette.green));
  }

  return {
    schemaVersion: 1,
    sceneId: "general-tutor-answer",
    revision,
    title: turn.visual.title,
    language: "en",
    status: "complete",
    source: "agent-drawing",
    elements,
  };
}

function hundredGrid(id: string, x: number, y: number, shaded: number, label: string, pattern: "hachure" | "solid"): BoardElement[] {
  const cell = 18;
  const gap = 2;
  const elements: BoardElement[] = [text(`${id}-label`, label, x, y - 44, 30, palette.green)];
  for (let index = 0; index < 100; index += 1) {
    elements.push({
      id: `${id}-cell-${index}`,
      type: "rectangle",
      x: x + (index % 10) * (cell + gap),
      y: y + Math.floor(index / 10) * (cell + gap),
      width: cell,
      height: cell,
      strokeColor: palette.ink,
      backgroundColor: index < shaded ? (pattern === "hachure" ? palette.greenSoft : palette.lime) : palette.paper,
      fillStyle: index < shaded ? pattern : "solid",
      strokeWidth: 1,
    });
  }
  return elements;
}

export function decimalComparisonScene(
  stage: "explain" | "hint" | "complete",
  language: "en" | "es",
  revision: number,
  values: [number, number] = [0.35, 0.4],
): ExcalidrawScene {
  const [left, right] = values;
  const leftFixed = left.toFixed(2);
  const rightFixed = right.toFixed(2);
  const [leftOnes, leftPlaces] = leftFixed.split(".");
  const [rightOnes, rightPlaces] = rightFixed.split(".");
  const leftHundredths = Math.round(left * 100);
  const rightHundredths = Math.round(right * 100);
  const lesser = Math.min(left, right);
  const greater = Math.max(left, right);
  const lesserHundredths = Math.round(lesser * 100);
  const greaterHundredths = Math.round(greater * 100);
  const lineX = 835;
  const lineWidth = 520;
  const leftPointX = lineX + left * lineWidth;
  const rightPointX = lineX + right * lineWidth;
  const lesserPointX = lineX + lesser * lineWidth;
  const greaterPointX = lineX + greater * lineWidth;
  const sameTenths = Math.floor(left * 10) === Math.floor(right * 10);
  const strings = language === "es"
    ? {
        title: "Compara los decimales",
        equivalence: `${leftFixed}   y   ${rightFixed}`,
        chart: ["unidades", "décimos", "centésimos"],
        compare: `${lesserHundredths} centésimos  <  ${greaterHundredths} centésimos`,
        prompt: stage === "complete" ? `${greater.toFixed(2)} > ${lesser.toFixed(2)}  ·  Compruébalo otra vez más tarde` : stage === "hint" ? `Pista: compara ${sameTenths ? "los centésimos" : "primero los décimos"}` : `¿Cuál es mayor: ${leftFixed} o ${rightFixed}?`,
      }
    : {
        title: "Compare decimals by place",
        equivalence: `${leftFixed}   and   ${rightFixed}`,
        chart: ["ones", "tenths", "hundredths"],
        compare: `${lesserHundredths} hundredths  <  ${greaterHundredths} hundredths`,
        prompt: stage === "complete" ? `${greater.toFixed(2)} > ${lesser.toFixed(2)}  ·  Check independently again later` : stage === "hint" ? `Hint: compare ${sameTenths ? "the hundredths" : "the tenths first"}` : `Which is greater: ${leftFixed} or ${rightFixed}?`,
      };

  const elements: BoardElement[] = [
    text("title", strings.title, 80, 40, 42, palette.green),
    text("equivalence", strings.equivalence, 660, 48, 38, palette.ink),
    { id: "place-chart", type: "rectangle", x: 70, y: 120, width: 720, height: 150, strokeColor: palette.green, backgroundColor: palette.paper, fillStyle: "solid", strokeWidth: 2 },
    text("place-head-ones", strings.chart[0], 120, 140, 22, palette.muted),
    text("place-head-tenths", strings.chart[1], 330, 140, 22, palette.muted),
    text("place-head-hundredths", strings.chart[2], 535, 140, 22, palette.muted),
    text("place-a-ones", leftOnes, 155, 190, 30, palette.ink),
    text("place-a-tenths", leftPlaces[0], 365, 190, 30, palette.ink),
    text("place-a-hundredths", leftPlaces[1], 590, 190, 30, palette.ink),
    text("place-b-ones", rightOnes, 155, 228, 30, palette.ink),
    text("place-b-tenths", rightPlaces[0], 365, 228, 30, palette.green),
    text("place-b-hundredths", rightPlaces[1], 590, 228, 30, palette.green),
    ...hundredGrid("grid-a", 110, 365, leftHundredths, leftFixed, "hachure"),
    ...hundredGrid("grid-b", 490, 365, rightHundredths, rightFixed, "solid"),
    text("comparison", strings.compare, 170, 590, 30, palette.ink),
    { id: "number-line", type: "line", x: 835, y: 460, points: [[0, 0], [520, 0]], strokeColor: palette.ink, strokeWidth: 3 },
    { id: "tick-0", type: "line", x: 835, y: 448, points: [[0, 0], [0, 24]], strokeColor: palette.ink },
    { id: "tick-1", type: "line", x: 1355, y: 448, points: [[0, 0], [0, 24]], strokeColor: palette.ink },
    text("zero", "0", 824, 486, 22),
    text("one", "1", 1347, 486, 22),
    { id: "point-a", type: "diamond", x: leftPointX - 11, y: 442, width: 22, height: 22, strokeColor: palette.green, backgroundColor: palette.greenSoft, fillStyle: "solid" },
    { id: "point-b", type: "ellipse", x: rightPointX - 11, y: 442, width: 22, height: 22, strokeColor: palette.ink, backgroundColor: palette.lime, fillStyle: "solid" },
    text("point-a-label", leftFixed, leftPointX - 28, 395, 24, palette.green),
    text("point-b-label", rightFixed, rightPointX - 28, 490, 24, palette.ink),
    { id: "greater-arrow", type: "arrow", x: lesserPointX, y: 560, points: [[0, 0], [Math.max(35, greaterPointX - lesserPointX), 0]], strokeColor: palette.amber, strokeWidth: 3, label: language === "es" ? "mayor" : "greater" },
    text("prompt", strings.prompt, 820, 640, stage === "complete" ? 28 : 34, stage === "hint" ? palette.amber : palette.green),
  ];

  return {
    schemaVersion: 1,
    sceneId: "decimal-comparison",
    revision,
    title: strings.title,
    language,
    status: stage === "complete" ? "complete" : "active",
    source: "reviewed-component",
    elements,
  };
}
