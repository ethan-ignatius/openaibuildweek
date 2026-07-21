import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  TutorAnswerProvider,
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
    for (const entry of teacherBrainRosterSchema.parse(options.roster ?? [])) {
      this.profilesByRef.set(entry.studentRef, entry);
    }
  }

  async answer(input: TutorQuestion, signal?: AbortSignal): Promise<TutorTurn> {
    const profile = this.profileFor(input.studentRef);
    const sessionId = await this.ensureSession(input.lessonTitle, profile, signal);
    const result = await this.post(
      `/api/teacher/sessions/${encodeURIComponent(sessionId)}/interruptions`,
      {
        student: profile.name,
        question: input.transcript,
        language: profile.language,
      },
      teachingTurnResponseSchema,
      signal,
    );
    const narration = result.plan.narration_segments
      .map((segment) => segment.text.trim())
      .filter(Boolean)
      .join(" ");
    const spokenLanguage = languageCode(
      result.plan.narration_segments[0]?.language ?? profile.language,
    );
    const nodes = result.plan.board_actions
      .map(actionSummary)
      .filter((node): node is { label: string; detail: string } => node !== null)
      .slice(0, 6);

    return {
      disposition: "answer",
      answer: narration.slice(0, 1_200),
      spokenAnswer: narration.slice(0, 700),
      visual: {
        title: input.lessonTitle.slice(0, 100) || "Student question",
        nodes,
        connections: [],
      },
      followUpQuestion: result.plan.check_for_understanding.slice(0, 240),
      provider: this.id,
      model: "teacher-brain-responses-api",
      language: spokenLanguage,
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
    activeProfile: TeacherBrainRosterEntry,
    signal?: AbortSignal,
  ): Promise<string> {
    const roster = uniqueProfiles([
      activeProfile,
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
    const baseUrl = (this.options.baseUrl ?? "http://127.0.0.1:8000").replace(/\/$/, "");
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
  let roster: TeacherBrainRosterEntry[] = [];
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

function actionSummary(
  action: TeacherBrainBoardAction,
): { label: string; detail: string } | null {
  if (action.type === "board.write_text") {
    return { label: action.text.slice(0, 80), detail: `Board text · ${action.region}` };
  }
  if (action.type === "board.write_math") {
    return { label: action.latex.slice(0, 80), detail: `Mathematical representation · ${action.region}` };
  }
  if (action.type === "board.plot_function") {
    return { label: `f(x) = ${action.expr}`.slice(0, 80), detail: `Domain ${action.domain[0]} to ${action.domain[1]}` };
  }
  if (action.type === "board.draw_number_line") {
    return { label: "Number line", detail: `${action.min} to ${action.max}` };
  }
  if (action.type === "board.draw_fraction_bars") {
    return { label: action.fractions.join(", ").slice(0, 80), detail: "Fraction bars" };
  }
  return null;
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
