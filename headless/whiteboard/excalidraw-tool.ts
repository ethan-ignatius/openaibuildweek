import { z } from "zod";
import { visualSymbolSchema, type ComprehensionCheck, type TutorAssessment, type TutorTurn } from "../reasoning/tutor-provider";

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
  symbol: visualSymbolSchema.optional(),
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
  navy: "#1d2b53",
  blue: "#2f5fb3",
  blueSoft: "#e8f1ff",
  purple: "#6f4cc3",
  purpleSoft: "#efe9ff",
  coral: "#b9473d",
  coralSoft: "#ffe9e4",
  sun: "#8a5a00",
  sunSoft: "#fff1b8",
  teal: "#14766f",
  tealSoft: "#def6f2",
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

function inferVisualSymbol(value: string, fallback: z.infer<typeof visualSymbolSchema> = "idea"): z.infer<typeof visualSymbolSchema> {
  const content = value.toLocaleLowerCase();
  if (/sun|solar|light/.test(content)) return "sun";
  if (/earth|world|planet|globe/.test(content)) return "earth";
  if (/cloud|rain|storm/.test(content)) return "cloud";
  if (/water|vapor|ocean|river|droplet/.test(content)) return "water";
  if (/plant|leaf|flower|tree|photosynth|sugar|glucose|food/.test(content)) return "plant";
  if (/animal|bird|fish|mammal|insect/.test(content)) return "animal";
  if (/atom|molecule|particle|chemical/.test(content)) return "atom";
  if (/book|read|story|word|language|history/.test(content)) return "book";
  if (/time|clock|day|year|season/.test(content)) return "clock";
  if (/people|person|community|team/.test(content)) return "people";
  if (/compare|balance|equal|greater|less/.test(content)) return "scale";
  if (/shape|angle|triangle|square|geometry/.test(content)) return "shapes";
  if (/map|country|place|land/.test(content)) return "map";
  if (/speak|speech|ask|say|sound/.test(content)) return "speech";
  if (/divide|share|split/.test(content)) return "divide";
  if (/add|plus|combine|total/.test(content)) return "plus";
  if (/group|times|multiply/.test(content)) return "groups";
  if (/\d/.test(content)) return "number";
  return fallback;
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
      text("thinking-kicker", "CLASSROOM COMPASS", 88, 72, 18, palette.blue),
      text("thinking-title", "Let’s build the idea together", 88, 118, 48, palette.navy),
      text("thinking-detail", "I’m turning the question into a short explanation and a picture.", 92, 194, 26, palette.muted),
      { id: "thinking-step-1", type: "ellipse", x: 150, y: 335, width: 230, height: 150, strokeColor: palette.blue, backgroundColor: palette.blueSoft, fillStyle: "solid", strokeWidth: 2 },
      { id: "thinking-step-2", type: "ellipse", x: 605, y: 335, width: 230, height: 150, strokeColor: palette.purple, backgroundColor: palette.purpleSoft, fillStyle: "solid", strokeWidth: 2 },
      { id: "thinking-step-3", type: "ellipse", x: 1_060, y: 335, width: 230, height: 150, strokeColor: palette.coral, backgroundColor: palette.coralSoft, fillStyle: "solid", strokeWidth: 2 },
      text("thinking-step-1-number", "1", 245, 360, 26, palette.blue),
      text("thinking-step-1-label", "Hear the question", 190, 410, 23, palette.navy),
      text("thinking-step-2-number", "2", 700, 360, 26, palette.purple),
      text("thinking-step-2-label", "Find the clues", 655, 410, 23, palette.navy),
      text("thinking-step-3-number", "3", 1_155, 360, 26, palette.coral),
      text("thinking-step-3-label", "Build the picture", 1_100, 410, 23, palette.navy),
      { id: "thinking-arrow-1", type: "arrow", x: 395, y: 410, points: [[0, 0], [180, 0]], strokeColor: palette.sun, strokeWidth: 4 },
      { id: "thinking-arrow-2", type: "arrow", x: 850, y: 410, points: [[0, 0], [180, 0]], strokeColor: palette.sun, strokeWidth: 4 },
      { id: "thinking-spark-1", type: "diamond", x: 1_270, y: 105, width: 28, height: 28, strokeColor: palette.sun, backgroundColor: palette.sunSoft, fillStyle: "solid" },
      { id: "thinking-spark-2", type: "diamond", x: 1_315, y: 150, width: 16, height: 16, strokeColor: palette.purple, backgroundColor: palette.purpleSoft, fillStyle: "solid" },
    ],
  };
}

export function genericTutorScene(turn: TutorTurn, revision: number): ExcalidrawScene {
  const equationMatches = [...turn.answer.matchAll(/(-?\d+(?:\.\d+)?)\s*([+\-×÷*/])\s*(-?\d+(?:\.\d+)?)\s*=\s*(-?\d+(?:\.\d+)?)/g)];
  const arithmeticMatch = equationMatches.at(-1);
  const equation = arithmeticMatch?.[0];
  const sentences = turn.answer.split(/(?<=[.!?])\s+/).filter(Boolean);
  const keyIdea = turn.visual.keyIdea?.trim() || sentences[0] || turn.visual.title;
  const example = turn.visual.example?.trim() || sentences[1] || "Picture the idea one clear step at a time.";
  const visualKind = turn.visual.kind ?? (arithmeticMatch ? "groups" : "concept");
  const sectionLabels: Record<NonNullable<TutorTurn["visual"]["kind"]>, string> = {
    concept: "CONNECT THE IDEAS",
    sequence: "FOLLOW THE STEPS",
    cause_effect: "SEE WHAT CAUSES WHAT",
    comparison: "COMPARE THE CLUES",
    cycle: "WATCH THE CYCLE",
    groups: "BUILD IT WITH GROUPS",
  };
  const elements: BoardElement[] = [
    text("stage-kicker", "CLASSROOM COMPASS  •  VISUAL EXPLANATION", 72, 28, 16, palette.blue),
    text("tutor-title", turn.visual.title, 72, 61, 43, palette.navy),
    { id: "decor-spark-1", type: "diamond", x: 1_292, y: 40, width: 28, height: 28, strokeColor: palette.sun, backgroundColor: palette.sunSoft, fillStyle: "solid" },
    { id: "decor-spark-2", type: "diamond", x: 1_335, y: 74, width: 17, height: 17, strokeColor: palette.purple, backgroundColor: palette.purpleSoft, fillStyle: "solid" },
    { id: "big-idea-panel", type: "rectangle", x: 70, y: 126, width: 830, height: 180, strokeColor: palette.blue, backgroundColor: palette.blueSoft, fillStyle: "solid", strokeWidth: 2 },
    { id: "big-idea-dot", type: "ellipse", x: 100, y: 151, width: 42, height: 42, strokeColor: palette.blue, backgroundColor: palette.paper, fillStyle: "solid", strokeWidth: 2, label: "★" },
    text("big-idea-label", turn.disposition === "clarify" ? "LET’S CHECK WHAT I HEARD" : turn.disposition === "defer" ? "A SAFE NEXT STEP" : "THE BIG IDEA", 160, 156, 18, palette.blue),
    text("big-idea-copy", wrapText(keyIdea, 52, 3), 105, 214, 29, palette.navy),
    { id: "example-panel", type: "rectangle", x: 930, y: 126, width: 440, height: 180, strokeColor: palette.sun, backgroundColor: palette.sunSoft, fillStyle: "solid", strokeWidth: 2 },
    text("example-label", equation ? "SEE IT WITH NUMBERS" : "MAKE IT REAL", 965, 156, 18, palette.sun),
    text("example-copy", wrapText(equation ? `${example}\n${equation.replace("*", "×").replace("/", "÷")}` : example, 34, 5), 965, 202, equation ? 23 : 21, palette.navy),
    text("path-label", sectionLabels[visualKind], 72, 342, 17, palette.purple),
  ];

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
  const columnCount = Math.min(4, Math.max(1, nodes.length));
  const nodeWidth = columnCount === 1 ? 580 : columnCount === 2 ? 520 : columnCount === 3 ? 385 : 290;
  const horizontalGap = columnCount === 1 ? 0 : columnCount === 2 ? 70 : columnCount === 3 ? 40 : 35;
  const totalWidth = columnCount * nodeWidth + (columnCount - 1) * horizontalGap;
  const startX = 720 - totalWidth / 2;
  const positions = nodes.map((_, index) => ({
    x: startX + index * (nodeWidth + horizontalGap),
    y: 385,
    width: nodeWidth,
    height: 170,
    row: 0,
    column: index,
  }));

  connections.forEach((connection, index) => {
    const from = positions[connection.from];
    const to = positions[connection.to];
    if (!from || !to) return;
    const forward = to.column > from.column;
    const startPoint = { x: from.x + (forward ? from.width : 0), y: from.y + from.height / 2 };
    const endPoint = { x: to.x + (forward ? 0 : to.width), y: to.y + to.height / 2 };
    const deltaX = endPoint.x - startPoint.x;
    const deltaY = endPoint.y - startPoint.y;
    elements.push({
      id: `connection-${index}`,
      type: "arrow",
      x: startPoint.x,
      y: startPoint.y,
      points: [[0, 0], [deltaX, deltaY]],
      strokeColor: palette.purple,
      strokeWidth: 3,
    });
    if (connection.label) {
      elements.push({
        id: `connection-${index}-label`,
        type: "text",
        x: startPoint.x + deltaX / 2,
        y: 360,
        text: connection.label,
        fontSize: 15,
        strokeColor: palette.purple,
        textAlign: "center",
      });
    }
  });

  const nodeColors = [
    { stroke: palette.blue, background: palette.blueSoft },
    { stroke: palette.purple, background: palette.purpleSoft },
    { stroke: palette.coral, background: palette.coralSoft },
    { stroke: palette.teal, background: palette.tealSoft },
  ];
  nodes.forEach((node, index) => {
    const position = positions[index];
    const colors = nodeColors[index % nodeColors.length];
    elements.push({
      id: `concept-${index}`,
      type: "rectangle",
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      strokeColor: colors.stroke,
      backgroundColor: colors.background,
      fillStyle: "solid",
      strokeWidth: 2,
    });
    elements.push({
      id: `concept-${index}-number-badge`,
      type: "ellipse",
      x: position.x + 22,
      y: position.y + 22,
      width: 42,
      height: 42,
      strokeColor: colors.stroke,
      backgroundColor: palette.paper,
      fillStyle: "solid",
      strokeWidth: 2,
      label: String(index + 1),
    });
    elements.push({
      id: `concept-${index}-symbol`,
      type: "ellipse",
      x: position.x + position.width - 63,
      y: position.y + 22,
      width: 42,
      height: 42,
      strokeColor: colors.stroke,
      backgroundColor: palette.paper,
      fillStyle: "solid",
      strokeWidth: 2,
      symbol: inferVisualSymbol(`${node.label} ${node.detail}`, node.symbol ?? "idea"),
    });
    elements.push(text(`concept-${index}-label`, wrapText(node.label, Math.max(10, Math.floor((position.width - 155) / 12)), 2), position.x + 80, position.y + 28, 23, palette.navy));
    if (node.detail.trim().toLowerCase() !== node.label.trim().toLowerCase()) {
      elements.push(text(`concept-${index}-detail`, wrapText(node.detail, Math.max(22, Math.floor(position.width / 10)), 3), position.x + 25, position.y + 88, 18, palette.ink));
    }
  });
  if (turn.followUpQuestion) {
    elements.push({ id: "follow-up-panel", type: "rectangle", x: 70, y: 640, width: 1_300, height: 105, strokeColor: palette.purple, backgroundColor: palette.purpleSoft, fillStyle: "solid", strokeWidth: 2 });
    elements.push(text("follow-up-label", "YOUR TURN", 105, 670, 17, palette.purple));
    elements.push(text("follow-up", wrapText(turn.followUpQuestion, 76, 2), 250, 666, 25, palette.navy));
  } else if (nodes.length === 0) {
    elements.push(text("closing-idea", wrapText(turn.answer, 90, 4), 105, 430, 27, palette.navy));
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

export function coachingFeedbackScene(
  assessment: TutorAssessment,
  check: ComprehensionCheck,
  revision: number,
  finalCorrection = false,
): ExcalidrawScene {
  const presentation = assessment.status === "correct"
    ? { title: "You’re on the right track!", label: "IDEA CONNECTED", stroke: palette.teal, soft: palette.tealSoft, symbol: "idea" as const }
    : assessment.status === "partly_correct"
      ? { title: "Good start—add one more idea", label: "ALMOST THERE", stroke: palette.purple, soft: palette.purpleSoft, symbol: "plus" as const }
      : assessment.status === "off_track"
        ? { title: "Let’s adjust one step", label: "TRY A NEW CLUE", stroke: palette.coral, soft: palette.coralSoft, symbol: "question" as const }
        : { title: "Let’s make the idea clearer", label: "SAY A LITTLE MORE", stroke: palette.blue, soft: palette.blueSoft, symbol: "speech" as const };
  const coachingText = finalCorrection ? check.correction : assessment.coachingExplanation;
  const nextPrompt = assessment.status === "correct"
    ? "Nice reasoning. Keep using the visual steps to explain how you know."
    : finalCorrection
      ? "Use this explanation as a model, then try a similar question when you’re ready."
      : assessment.retryPrompt || check.prompt;
  return {
    schemaVersion: 1,
    sceneId: "student-coaching-feedback",
    revision,
    title: presentation.title,
    language: "en",
    status: assessment.status === "correct" || finalCorrection ? "complete" : "active",
    source: "reviewed-component",
    elements: [
      text("feedback-kicker", "CLASSROOM COMPASS  •  COACHING MOMENT", 72, 32, 16, presentation.stroke),
      text("feedback-title", presentation.title, 72, 74, 46, palette.navy),
      { id: "feedback-symbol", type: "ellipse", x: 1_245, y: 48, width: 82, height: 82, strokeColor: presentation.stroke, backgroundColor: presentation.soft, fillStyle: "solid", strokeWidth: 3, symbol: presentation.symbol },
      { id: "feedback-working-panel", type: "rectangle", x: 70, y: 170, width: 610, height: 285, strokeColor: presentation.stroke, backgroundColor: presentation.soft, fillStyle: "solid", strokeWidth: 2 },
      text("feedback-working-label", presentation.label, 108, 205, 17, presentation.stroke),
      text("feedback-working-copy", wrapText(assessment.feedback, 43, 6), 108, 260, 27, palette.navy),
      { id: "feedback-clue-panel", type: "rectangle", x: 730, y: 170, width: 640, height: 285, strokeColor: palette.sun, backgroundColor: palette.sunSoft, fillStyle: "solid", strokeWidth: 2 },
      text("feedback-clue-label", assessment.status === "correct" ? "WHY IT WORKS" : finalCorrection ? "LET’S REBUILD IT" : "NEXT CLUE", 770, 205, 17, palette.sun),
      text("feedback-clue-copy", wrapText(coachingText, 46, 7), 770, 258, 24, palette.navy),
      { id: "feedback-next-panel", type: "rectangle", x: 70, y: 520, width: 1_300, height: 155, strokeColor: palette.blue, backgroundColor: palette.blueSoft, fillStyle: "solid", strokeWidth: 2 },
      text("feedback-next-label", assessment.status === "correct" ? "KEEP GOING" : finalCorrection ? "TAKEAWAY" : "TRY AGAIN", 108, 552, 17, palette.blue),
      text("feedback-next-copy", wrapText(nextPrompt, 78, 3), 108, 598, 27, palette.navy),
      { id: "feedback-spark-1", type: "diamond", x: 1_285, y: 705, width: 24, height: 24, strokeColor: palette.sun, backgroundColor: palette.sunSoft, fillStyle: "solid" },
      { id: "feedback-spark-2", type: "diamond", x: 1_325, y: 728, width: 14, height: 14, strokeColor: palette.purple, backgroundColor: palette.purpleSoft, fillStyle: "solid" },
    ],
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
