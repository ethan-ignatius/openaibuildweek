import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultTeacherBrainRoster } from "../config/classroom-seating-plan";
import type {
  TutorAnswerProvider,
  TutorLessonInput,
  TutorQuestion,
  TutorTurn,
} from "./tutor-provider";

const studentName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const language = z.string().min(2).max(35).regex(/^[^\r\n]+$/);
const elementId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const region = z.enum(["top", "left", "center", "right", "bottom", "scratch"]);

const writeTextAction = z.object({
  type: z.literal("board.write_text"),
  region,
  text: z.string().min(1).max(10_000),
  element_id: elementId,
});
const writeMathAction = z.object({
  type: z.literal("board.write_math"),
  region,
  latex: z.string().min(1).max(10_000),
  element_id: elementId,
});
const plotFunctionAction = z.object({
  type: z.literal("board.plot_function"),
  expr: z.string().min(1).max(1_000),
  domain: z.tuple([z.number().finite(), z.number().finite()]),
  element_id: elementId,
});
const numberLineAction = z.object({
  type: z.literal("board.draw_number_line"),
  min: z.number().finite(),
  max: z.number().finite(),
  marks: z.array(z.object({
    value: z.number().finite(),
    label: z.string().max(100).optional(),
  })).max(100),
  element_id: elementId,
});
const fractionBarsAction = z.object({
  type: z.literal("board.draw_fraction_bars"),
  fractions: z.array(z.string().regex(/^[0-9]+\/[1-9][0-9]*$/)).min(1).max(20),
  element_id: elementId,
});
const renderCustomAction = z.object({
  type: z.literal("board.render_custom"),
  svg: z.string().min(1).max(100_000),
  element_id: elementId,
});
const highlightAction = z.object({
  type: z.literal("board.highlight"),
  element_id: elementId,
  style: z.enum(["pulse", "outline", "fill"]),
});
const unhighlightAction = z.object({
  type: z.literal("board.unhighlight"),
  element_id: elementId,
});
const clearAction = z.object({
  type: z.literal("board.clear"),
  region: z.union([region, z.literal("all")]),
});
const showSlideAction = z.object({
  type: z.literal("board.show_slide"),
  slide_ref: z.string().min(1).max(2_048),
});

export const teacherBrainBoardActionSchema = z.discriminatedUnion("type", [
  writeTextAction,
  writeMathAction,
  plotFunctionAction,
  numberLineAction,
  fractionBarsAction,
  renderCustomAction,
  highlightAction,
  unhighlightAction,
  clearAction,
  showSlideAction,
]);

export const teacherBrainPlanSchema = z.object({
  board_actions: z.array(teacherBrainBoardActionSchema).min(1).max(24),
  narration_segments: z.array(z.object({
    text: z.string().min(1).max(10_000),
    language,
    highlight_element_id: elementId.optional().nullable(),
  })).min(1).max(24),
  check_for_understanding: z.string().min(1).max(2_000),
  pedagogical_rationale: z.string().min(1).max(2_400),
  resume_guidance: z.string().min(1).max(2_000),
});

const teachingTurnResponseSchema = z.object({
  session_id: z.string().min(1),
  turn_index: z.number().int().positive(),
  kind: z.enum(["instruction", "interruption"]),
  student: studentName.optional().nullable(),
  plan: teacherBrainPlanSchema,
  token_usage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  latency_ms: z.number().nonnegative(),
});

const classroomSessionSchema = z.object({
  session_id: z.string().min(1),
  status: z.enum(["active", "interrupted", "ended"]),
}).passthrough();

export const teacherBrainRosterSchema = z.array(z.object({
  studentRef: z.string().min(1).max(128),
  name: studentName,
  language: language.default("English"),
})).max(60);

export type TeacherBrainBoardAction = z.infer<typeof teacherBrainBoardActionSchema>;
export type TeacherBrainPlan = z.infer<typeof teacherBrainPlanSchema>;
export type TeacherBrainRosterEntry = z.infer<typeof teacherBrainRosterSchema>[number];

type TeacherBrainProviderOptions = {
  baseUrl?: string;
  objective?: string;
  sourceMaterial?: string;
  sourceRef?: string;
  openingInstruction?: string;
  resumeInstruction?: string;
  roster?: TeacherBrainRosterEntry[];
  timeoutMs?: number;
  fetcher?: typeof fetch;
};

export class TeacherBrainTutorProvider implements TutorAnswerProvider {
  readonly id = "teacher-brain-api@1.0.0";
  private sessionId: string | null = null;
  private sessionRoster = new Set<string>();
  private profilesByRef = new Map<string, TeacherBrainRosterEntry>();

  constructor(private options: TeacherBrainProviderOptions = {}) {
    for (const entry of teacherBrainRosterSchema.parse(options.roster ?? defaultTeacherBrainRoster())) {
      this.profilesByRef.set(entry.studentRef, entry);
    }
  }

  async answer(input: TutorQuestion, signal?: AbortSignal): Promise<TutorTurn> {
    const profile = this.profileFor(input.studentRef);
    const responseLanguage = questionLanguage(input.transcript, profile.language);
    const sessionId = await this.ensureSession(input.lessonTitle, profile, signal);
    const result = await this.post(
      `/api/teacher/sessions/${encodeURIComponent(sessionId)}/interruptions`,
      {
        student: profile.name,
        question: input.transcript,
        language: responseLanguage,
      },
      teachingTurnResponseSchema,
      signal,
    );
    return this.toTutorTurn(result, input.lessonTitle, input.transcript);
  }

  async beginLesson(
    input: TutorLessonInput,
    signal?: AbortSignal,
  ): Promise<TutorTurn> {
    const sessionId = await this.ensureSession(input.lessonTitle, undefined, signal);
    const result = await this.post(
      `/api/teacher/sessions/${encodeURIComponent(sessionId)}/teach`,
      {
        instruction: this.options.openingInstruction
          ?? "Begin the main lesson in English with one concrete representation and a short check for understanding.",
      },
      teachingTurnResponseSchema,
      signal,
    );
    return this.toTutorTurn(result, input.lessonTitle);
  }

  async resumeLesson(
    input: TutorLessonInput,
    signal?: AbortSignal,
  ): Promise<TutorTurn> {
    const sessionId = await this.ensureSession(input.lessonTitle, undefined, signal);
    const guidance = input.resumeGuidance?.trim();
    const instruction = this.options.resumeInstruction
      ?? "Resume the main lesson in English with a brief verbal bridge. Continue from the stored resume guidance without repeating the interruption answer.";
    const result = await this.post(
      `/api/teacher/sessions/${encodeURIComponent(sessionId)}/teach`,
      {
        instruction: `${instruction}${guidance ? ` Stored bridge: ${guidance}` : ""}`.slice(0, 5_000),
      },
      teachingTurnResponseSchema,
      signal,
    );
    return this.toTutorTurn(result, input.lessonTitle);
  }

  languageForStudent(studentRef?: string): "en" | "es" {
    return languageCode(this.profileFor(studentRef).language);
  }

  displayNameForStudent(studentRef?: string): string | undefined {
    const reference = studentRef?.trim();
    return reference ? this.profilesByRef.get(reference)?.name : undefined;
  }

  classroomSessionId(): string | null {
    return this.sessionId;
  }

  apiBaseUrl(): string {
    return (this.options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  }

  roster(): TeacherBrainRosterEntry[] {
    return [...this.profilesByRef.values()].map((profile) => ({ ...profile }));
  }

  private toTutorTurn(
    result: z.infer<typeof teachingTurnResponseSchema>,
    lessonTitle: string,
    studentQuestion?: string,
  ): TutorTurn {
    if (result.kind === "interruption") {
      const firstAction = result.plan.board_actions[0];
      if (firstAction.type !== "board.clear" || firstAction.region !== "all") {
        throw new Error("Teacher Brain interruption did not begin with a full board clear");
      }
      const narrationLanguages = result.plan.narration_segments.map((segment) => languageCode(segment.language));
      if (narrationLanguages.includes("es") && !narrationLanguages.includes("en")) {
        throw new Error("Teacher Brain Spanish interruption omitted the English recap");
      }
    }
    const spokenSegments = result.plan.narration_segments
      .map((segment) => ({
        text: segment.text.trim(),
        language: languageCode(segment.language),
      }))
      .filter((segment) => Boolean(segment.text));
    const narration = spokenSegments.map((segment) => segment.text).join(" ");
    const spokenLanguage = spokenSegments[0]?.language ?? "en";
    const boardTitle = result.plan.board_actions.find((action) =>
      action.type === "board.write_text" && action.region === "top"
    );
    const visualTitle = boardTitle?.type === "board.write_text"
      ? boardTitle.text.slice(0, 100)
      : questionTitle(studentQuestion) || lessonTitle.slice(0, 100) || "Student question";
    const customLabels = orderVisualLabels(result.plan.board_actions
      .filter((action): action is Extract<TeacherBrainBoardAction, { type: "board.render_custom" }> => action.type === "board.render_custom")
      .flatMap((action) => extractSvgTextLabels(action.svg))
      .filter((label) => normalizedWords(label) !== normalizedWords(visualTitle)), `${visualTitle} ${spokenSegments[0]?.text ?? narration}`);
    const actionNodes = result.plan.board_actions
      .map(actionSummary)
      .filter((node): node is NonNullable<ReturnType<typeof actionSummary>> => node !== null)
      .filter((node) => normalizedWords(node.label) !== normalizedWords(visualTitle));
    const nodes = uniqueVisualNodes(
      customLabels.length >= 2
        ? customLabels.map(visualNodeForLabel)
        : actionNodes,
    ).slice(0, 4);
    const visualKind = inferVisualKind(`${visualTitle} ${spokenSegments[0]?.text ?? narration}`);
    const connections = nodes.slice(1).map((_, index) => ({
      from: index,
      to: index + 1,
      label: visualKind === "sequence" ? "then" : visualKind === "cause_effect" ? "leads to" : "connects to",
    }));
    const spokenSentences = (spokenSegments[0]?.text ?? narration)
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean);

    return {
      disposition: "answer",
      answer: narration.slice(0, 1_200),
      spokenAnswer: spokenSegments[0]?.text.slice(0, 700) ?? narration.slice(0, 700),
      visual: {
        title: visualTitle,
        kind: visualKind,
        keyIdea: spokenSentences[0]?.slice(0, 220) || visualTitle,
        example: spokenSentences[1]?.slice(0, 220) || "Use the picture to trace how each part connects.",
        nodes,
        connections,
      },
      followUpQuestion: result.plan.check_for_understanding.slice(0, 240),
      provider: this.id,
      model: "teacher-brain-responses-api",
      language: spokenLanguage,
      spokenSegments,
      boardPlan: result.plan,
      providerMetadata: {
        sessionId: result.session_id,
        turnIndex: result.turn_index,
        resumeGuidance: result.plan.resume_guidance,
        tokenUsage: result.token_usage,
      },
    };
  }

  private profileFor(studentRef?: string): TeacherBrainRosterEntry {
    const reference = studentRef?.trim() || "anonymous-seat";
    const configured = this.profilesByRef.get(reference);
    if (configured) return configured;
    const safeReference = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(reference)
      ? reference
      : `Student_${createHash("sha256").update(reference).digest("hex").slice(0, 12)}`;
    const fallback = {
      studentRef: reference,
      name: safeReference,
      language: "English",
    };
    this.profilesByRef.set(reference, fallback);
    return fallback;
  }

  private async ensureSession(
    lessonTitle: string,
    activeProfile: TeacherBrainRosterEntry | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const roster = uniqueProfiles([
      ...(activeProfile ? [activeProfile] : []),
      ...this.profilesByRef.values(),
    ]);
    const rosterChanged = roster.some((profile) => !this.sessionRoster.has(profile.name));
    if (this.sessionId && !rosterChanged) return this.sessionId;

    if (this.sessionId) {
      try {
        await this.post(
          `/api/teacher/sessions/${encodeURIComponent(this.sessionId)}/end`,
          {},
          classroomSessionSchema,
          signal,
        );
      } catch {
        // A stale session must not prevent a new roster-aware classroom session.
      }
    }

    const created = await this.post(
      "/api/teacher/sessions",
      {
        topic: lessonTitle.slice(0, 500) || "Open classroom questions",
        objective: (
          this.options.objective
          ?? "Answer student questions accurately, check understanding, and reconnect to the lesson."
        ).slice(0, 2_000),
        source_material: this.options.sourceMaterial?.slice(0, 50_000) ?? null,
        source_ref: this.options.sourceRef?.slice(0, 2_048) ?? null,
        students: roster.map((profile) => ({
          name: profile.name,
          language: profile.language,
        })),
      },
      classroomSessionSchema,
      signal,
    );
    this.sessionId = created.session_id;
    this.sessionRoster = new Set(roster.map((profile) => profile.name));
    return created.session_id;
  }

  private async post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const baseUrl = this.apiBaseUrl();
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180_000);
    const response = await (this.options.fetcher ?? fetch)(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = errorDetail(payload);
      throw new Error(`Teacher Brain returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return schema.parse(payload);
  }
}

export function createTeacherBrainProviderFromEnvironment(
  environment: Record<string, string | undefined>,
): TeacherBrainTutorProvider {
  let roster: TeacherBrainRosterEntry[] = defaultTeacherBrainRoster();
  if (environment.CC_TEACHER_BRAIN_ROSTER_JSON) {
    roster = teacherBrainRosterSchema.parse(
      JSON.parse(environment.CC_TEACHER_BRAIN_ROSTER_JSON),
    );
  }
  return new TeacherBrainTutorProvider({
    baseUrl: environment.CC_TEACHER_BRAIN_API_URL,
    objective: environment.CC_TEACHER_BRAIN_OBJECTIVE,
    sourceMaterial: environment.CC_TEACHER_BRAIN_SOURCE_MATERIAL,
    sourceRef: environment.CC_TEACHER_BRAIN_SOURCE_REF,
    openingInstruction: environment.CC_TEACHER_BRAIN_OPENING_INSTRUCTION,
    resumeInstruction: environment.CC_TEACHER_BRAIN_RESUME_INSTRUCTION,
    timeoutMs: environment.CC_TEACHER_BRAIN_TIMEOUT_MS
      ? z.coerce.number().int().min(1_000).max(600_000).parse(
          environment.CC_TEACHER_BRAIN_TIMEOUT_MS,
        )
      : undefined,
    roster,
  });
}

function uniqueProfiles(
  profiles: TeacherBrainRosterEntry[],
): TeacherBrainRosterEntry[] {
  const byName = new Map<string, TeacherBrainRosterEntry>();
  for (const profile of profiles) byName.set(profile.name, profile);
  return [...byName.values()].slice(0, 60);
}

function languageCode(value: string): "en" | "es" {
  const normalized = value.trim().toLowerCase();
  return normalized === "es" || normalized.startsWith("es-") || normalized.includes("spanish")
    ? "es"
    : "en";
}

export function questionLanguage(transcript: string, configuredLanguage: string): "English" | "Spanish" {
  const normalized = ` ${transcript.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zñ0-9]+/g, " ")} `;
  const spanishSignals = [
    " que ", " como ", " por que ", " porque ", " cual ", " donde ", " cuando ", " quien ",
    " es ", " son ", " una ", " uno ", " el ", " la ", " los ", " las ", " puede ", " funciona ",
  ];
  const englishSignals = [
    " what ", " how ", " why ", " which ", " where ", " when ", " who ", " is ", " are ",
    " the ", " a ", " an ", " can ", " does ", " do ", " work ", " mean ",
  ];
  const spanishScore = spanishSignals.filter((signal) => normalized.includes(signal)).length
    + (/[¿¡ñ]/i.test(transcript) ? 2 : 0);
  const englishScore = englishSignals.filter((signal) => normalized.includes(signal)).length;
  if (spanishScore > englishScore && spanishScore >= 2) return "Spanish";
  if (englishScore > spanishScore && englishScore >= 2) return "English";
  return languageCode(configuredLanguage) === "es" ? "Spanish" : "English";
}

function actionSummary(
  action: TeacherBrainBoardAction,
): TutorTurn["visual"]["nodes"][number] | null {
  if (action.type === "board.write_text") {
    return visualNodeForLabel(action.text.slice(0, 80));
  }
  if (action.type === "board.write_math") {
    return { label: plainMath(action.latex).slice(0, 80), detail: "See how the quantities fit together.", symbol: "number" };
  }
  if (action.type === "board.plot_function") {
    return { label: `f(x) = ${action.expr}`.slice(0, 80), detail: `Follow the graph from ${action.domain[0]} to ${action.domain[1]}.`, symbol: "number" };
  }
  if (action.type === "board.draw_number_line") {
    return { label: "Number line", detail: `Place the values between ${action.min} and ${action.max}.`, symbol: "number" };
  }
  if (action.type === "board.draw_fraction_bars") {
    return { label: action.fractions.join(", ").slice(0, 80), detail: "Compare equal parts of the same whole.", symbol: "divide" };
  }
  return null;
}

function extractSvgTextLabels(svg: string): string[] {
  const labels: string[] = [];
  for (const match of svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) {
    const label = decodeXmlText(match[1].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (label.length >= 2 && label.length <= 80) labels.push(label);
    if (labels.length >= 12) break;
  }
  return [...new Set(labels)];
}

function decodeXmlText(value: string) {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");
}

function normalizedWords(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function questionTitle(question?: string) {
  const normalized = question?.replace(/\s+/g, " ").trim().replace(/[?.!]+$/, "") ?? "";
  if (!normalized) return "";
  return `${normalized[0].toUpperCase()}${normalized.slice(1)}`.slice(0, 100);
}

function orderVisualLabels(labels: string[], context: string) {
  const content = context.toLowerCase();
  if (!/water cycle|evaporation|condensation|precipitation/.test(content)) return labels;
  const waterCycleOrder = (label: string) => {
    const value = label.toLowerCase();
    if (/sun|heat|energy/.test(value)) return 0;
    if (/evapor|transpir|vapor/.test(value)) return 1;
    if (/condens|cloud/.test(value)) return 2;
    if (/rain|precip|snow|hail/.test(value)) return 3;
    if (/collect|river|lake|ocean|ground/.test(value)) return 4;
    return 5;
  };
  return labels
    .map((label, index) => ({ label, index, order: waterCycleOrder(label) }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ label }) => label);
}

function uniqueVisualNodes(nodes: TutorTurn["visual"]["nodes"]) {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = normalizedWords(node.label);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function visualNodeForLabel(label: string): TutorTurn["visual"]["nodes"][number] {
  const content = label.toLowerCase();
  if (/sun|light|solar/.test(content)) return { label, detail: "Energy arrives from sunlight.", symbol: "sun" };
  if (/water|rain|vapor|ocean/.test(content)) return { label, detail: "Track where the water moves next.", symbol: "water" };
  if (/plant|leaf|root|sugar|glucose|food/.test(content)) return { label, detail: "See how this helps the plant grow.", symbol: "plant" };
  if (/cloud|condens/.test(content)) return { label, detail: "Tiny droplets gather together.", symbol: "cloud" };
  if (/earth|planet|world/.test(content)) return { label, detail: "Connect this part to the whole system.", symbol: "earth" };
  if (/atom|molecule|carbon|oxygen|gas|chemical/.test(content)) return { label, detail: "Follow this material through the change.", symbol: "atom" };
  if (/number|fraction|equation|equal|total|\d/.test(content)) return { label, detail: "Use the quantities as clues.", symbol: "number" };
  return { label, detail: "Look for how this part connects to the next idea.", symbol: "idea" };
}

function inferVisualKind(value: string): NonNullable<TutorTurn["visual"]["kind"]> {
  const content = value.toLowerCase();
  if (/cycle|again and again|repeats?|loops? back/.test(content)) return "cycle";
  if (/compare|difference|versus| vs\.? |greater|less than/.test(content)) return "comparison";
  if (/cause|because|why |results? in|leads? to/.test(content)) return "cause_effect";
  if (/how |process|steps?|first|next|then|finally|make|form/.test(content)) return "sequence";
  if (/groups?|times|multiply|share equally/.test(content)) return "groups";
  return "concept";
}

function plainMath(value: string) {
  return value
    .replace(/\\text\{?([^{}]+)\}?/g, "$1")
    .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1/$2")
    .replace(/\\(?:times|cdot)/g, "×")
    .replace(/\\(?:rightarrow|longrightarrow)/g, "→")
    .replace(/\\leq?/g, "≤")
    .replace(/\\geq?/g, "≥")
    .replace(/[{}]/g, "")
    .replace(/\\[;,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function errorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("detail" in payload)) return "";
  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail.slice(0, 300);
  if (detail && typeof detail === "object" && "message" in detail) {
    return String((detail as { message?: unknown }).message ?? "").slice(0, 300);
  }
  return "";
}
