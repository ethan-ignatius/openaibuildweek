import { describe, expect, it, vi } from "vitest";
import { createTutorProviderFromEnvironment } from "../../headless/reasoning/tutor-provider";
import {
  questionLanguage,
  teacherBrainPlanSchema,
  TeacherBrainTutorProvider,
} from "../../headless/reasoning/teacher-brain-provider";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Teacher Brain API tutor provider", () => {
  it("creates a roster-aware session and returns its board and narration plan", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/api/teacher/sessions")) {
        return jsonResponse({ session_id: "classroom-fixture", status: "active" });
      }
      return jsonResponse({
        session_id: "classroom-fixture",
        turn_index: 1,
        kind: "interruption",
        student: "Jordan",
        plan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            { type: "board.write_math", region: "center", latex: "3/4", element_id: "fraction" },
            { type: "board.highlight", element_id: "fraction", style: "outline" },
          ],
          narration_segments: [{
            text: "Tres cuartos significa tres de cuatro partes iguales.",
            language: "Spanish",
            highlight_element_id: "fraction",
          }, {
            text: "In English: three fourths means three of four equal parts.",
            language: "English",
            highlight_element_id: "fraction",
          }],
          check_for_understanding: "¿Qué cuenta el denominador?",
          pedagogical_rationale: "Use equal parts before symbolic comparison.",
          resume_guidance: "Return to the number-line example.",
        },
        token_usage: { input: 100, output: 50, total: 150 },
        latency_ms: 25,
      });
    });
    const provider = new TeacherBrainTutorProvider({
      fetcher: fetcher as typeof fetch,
      roster: [{ studentRef: "seat-a2", name: "Jordan", language: "Spanish" }],
    });

    const turn = await provider.answer({
      transcript: "¿Por qué el número de abajo representa partes iguales?",
      lessonTitle: "Equivalent fractions",
      history: [],
      studentRef: "seat-a2",
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].body).toMatchObject({
      topic: "Equivalent fractions",
      students: [{ name: "Jordan", language: "Spanish" }],
    });
    expect(requests[1].url).toContain("/classroom-fixture/interruptions");
    expect(requests[1].body).toEqual({
      student: "Jordan",
      question: "¿Por qué el número de abajo representa partes iguales?",
      language: "Spanish",
    });
    expect(turn.language).toBe("es");
    expect(turn.spokenAnswer).toContain("Tres cuartos");
    expect(turn.followUpQuestion).toContain("denominador");
    expect(turn.spokenSegments).toEqual([
      { text: "Tres cuartos significa tres de cuatro partes iguales.", language: "es" },
      { text: "In English: three fourths means three of four equal parts.", language: "en" },
    ]);
    const boardPlan = teacherBrainPlanSchema.parse(turn.boardPlan);
    expect(boardPlan.board_actions[0]).toEqual({
      type: "board.clear",
      region: "all",
    });
    expect(turn.providerMetadata).toMatchObject({
      sessionId: "classroom-fixture",
      resumeGuidance: "Return to the number-line example.",
    });
  });

  it("is selected explicitly without changing the local Ollama default", () => {
    const provider = createTutorProviderFromEnvironment({
      CC_TUTOR_PROVIDER: "teacher-brain",
      CC_TEACHER_BRAIN_API_URL: "http://127.0.0.1:8000",
      CC_TEACHER_BRAIN_ROSTER_JSON: JSON.stringify([
        { studentRef: "camera-left", name: "Riley", language: "English" },
      ]),
    });
    expect(provider?.id).toBe("teacher-brain-api@1.0.0");
    expect(createTutorProviderFromEnvironment({})?.id).toBe("ollama-local-tutor@1.0.0");
  });

  it("uses the fixed seating profiles and follows the language actually spoken", () => {
    const provider = createTutorProviderFromEnvironment({
      CC_TUTOR_PROVIDER: "teacher-brain",
      CC_TEACHER_BRAIN_API_URL: "http://127.0.0.1:8000",
    });
    expect(provider).toBeInstanceOf(TeacherBrainTutorProvider);
    const teacherBrain = provider as TeacherBrainTutorProvider;
    expect(teacherBrain.roster()).toEqual([
      { studentRef: "seat:camera-right", name: "Emanuel", language: "Spanish" },
      { studentRef: "seat:camera-left", name: "Ethan", language: "English" },
    ]);
    expect(teacherBrain.languageForStudent("seat:camera-right")).toBe("es");
    expect(teacherBrain.languageForStudent("seat:camera-left")).toBe("en");
    expect(teacherBrain.displayNameForStudent("seat:camera-right")).toBe("Emanuel");
    expect(teacherBrain.displayNameForStudent("seat:camera-left")).toBe("Ethan");
    expect(questionLanguage("¿Cómo funciona la fotosíntesis?", "English")).toBe("Spanish");
    expect(questionLanguage("How does photosynthesis work?", "Spanish")).toBe("English");
    expect(questionLanguage("Photosynthesis?", "Spanish")).toBe("Spanish");
  });

  it("sends the spoken language and fixed seat identity to Teacher Brain", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/api/teacher/sessions")) {
        return jsonResponse({ session_id: "fixed-seating-fixture", status: "active" });
      }
      return jsonResponse({
        session_id: "fixed-seating-fixture",
        turn_index: 1,
        kind: "interruption",
        student: "Emanuel",
        plan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            { type: "board.write_text", region: "top", text: "Water cycle", element_id: "title" },
          ],
          narration_segments: [{ text: "Water evaporates when it gains heat.", language: "English" }],
          check_for_understanding: "What happens after evaporation?",
          pedagogical_rationale: "Connect heat to a change of state.",
          resume_guidance: "Return to the main lesson.",
        },
        token_usage: { input: 20, output: 10, total: 30 },
        latency_ms: 8,
      });
    });
    const provider = new TeacherBrainTutorProvider({ fetcher: fetcher as typeof fetch });

    await provider.answer({
      transcript: "How does water become a cloud?",
      lessonTitle: "Water cycle",
      history: [],
      studentRef: "seat:camera-right",
    });

    expect(requests[0].body.students).toEqual([
      { name: "Emanuel", language: "Spanish" },
      { name: "Ethan", language: "English" },
    ]);
    expect(requests[1].body).toEqual({
      student: "Emanuel",
      question: "How does water become a cloud?",
      language: "English",
    });
  });

  it("turns safe labels from a requested custom sketch into Visual Stage concept cards", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/teacher/sessions")) {
        return jsonResponse({ session_id: "visual-stage-fixture", status: "active" });
      }
      return jsonResponse({
        session_id: "visual-stage-fixture",
        turn_index: 1,
        kind: "interruption",
        student: "Jordan",
        plan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            {
              type: "board.render_custom",
              svg: "<svg><script>doNotRun()</script><text>Sunlight</text><text>Water</text><text>Carbon dioxide</text><text>Sugar</text></svg>",
              element_id: "plant-process",
            },
          ],
          narration_segments: [{
            text: "A leaf uses sunlight, water, and carbon dioxide to make sugar. The plant uses that sugar to grow.",
            language: "English",
          }],
          check_for_understanding: "Which part supplies the energy?",
          pedagogical_rationale: "Show inputs and output.",
          resume_guidance: "Return to plant structures.",
        },
        token_usage: { input: 30, output: 20, total: 50 },
        latency_ms: 12,
      });
    });
    const provider = new TeacherBrainTutorProvider({ fetcher: fetcher as typeof fetch });

    const turn = await provider.answer({
      transcript: "How do plants make food?",
      lessonTitle: "Open classroom questions",
      history: [],
      studentRef: "Jordan",
    });

    expect(turn.visual.title).toBe("How do plants make food");
    expect(turn.visual.kind).toBe("sequence");
    expect(turn.visual.nodes.map((node) => node.label)).toEqual([
      "Sunlight", "Water", "Carbon dioxide", "Sugar",
    ]);
    expect(turn.visual.nodes.map((node) => node.symbol)).toEqual([
      "sun", "water", "atom", "plant",
    ]);
    expect(JSON.stringify(turn.visual)).not.toContain("doNotRun");
  });

  it("prefers explicit numbered teaching stages over incidental custom-sketch labels", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/teacher/sessions")) {
        return jsonResponse({ session_id: "photosynthesis-fixture", status: "active" });
      }
      return jsonResponse({
        session_id: "photosynthesis-fixture",
        turn_index: 1,
        kind: "instruction",
        student: null,
        plan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            { type: "board.write_text", region: "top", text: "Photosynthesis", element_id: "title" },
            { type: "board.render_custom", svg: "<svg><text>Roots</text><text>Water</text><text>Stomata</text><text>Chloroplasts</text></svg>", element_id: "leaf" },
            { type: "board.write_text", region: "left", text: "1. Inputs\nWater and carbon dioxide enter", element_id: "inputs" },
            { type: "board.write_text", region: "center", text: "2. Capture light\nChlorophyll captures energy", element_id: "light" },
            { type: "board.write_text", region: "right", text: "3. Make glucose and oxygen\nAtoms are rearranged", element_id: "products" },
            { type: "board.write_text", region: "bottom", text: "4. Use glucose\nEnergy, growth, cellulose, and storage", element_id: "uses" },
          ],
          narration_segments: [{ text: "Plants use light energy to rearrange water and carbon dioxide into glucose and oxygen.", language: "English" }],
          check_for_understanding: "What supplies matter and what supplies energy?",
          pedagogical_rationale: "Trace matter and energy separately.",
          resume_guidance: "Continue with how glucose supports the plant.",
        },
        token_usage: { input: 30, output: 20, total: 50 },
        latency_ms: 12,
      });
    });
    const provider = new TeacherBrainTutorProvider({ fetcher: fetcher as typeof fetch });

    const turn = await provider.beginLesson({ lessonTitle: "Photosynthesis" });

    expect(turn.visual.nodes.map((node) => node.label)).toEqual([
      "1. Inputs", "2. Capture light", "3. Make glucose and oxygen", "4. Use glucose",
    ]);
    expect(turn.visual.nodes[2].detail).toBe("Atoms are rearranged");
    expect(turn.visual.nodes.map((node) => node.label)).not.toContain("Roots");
  });

  it("opens and explicitly resumes a lesson through the teach endpoint", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let turnIndex = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/api/teacher/sessions")) {
        return jsonResponse({ session_id: "classroom-lifecycle", status: "active" });
      }
      turnIndex += 1;
      return jsonResponse({
        session_id: "classroom-lifecycle",
        turn_index: turnIndex,
        kind: "instruction",
        student: null,
        plan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            { type: "board.write_text", region: "center", text: `Lesson turn ${turnIndex}`, element_id: `lesson-${turnIndex}` },
          ],
          narration_segments: [{ text: `Lesson narration ${turnIndex}`, language: "English", highlight_element_id: `lesson-${turnIndex}` }],
          check_for_understanding: "What do you notice?",
          pedagogical_rationale: "Keep the lesson coherent.",
          resume_guidance: "Continue with the next representation.",
        },
        token_usage: { input: 10, output: 10, total: 20 },
        latency_ms: 5,
      });
    });
    const provider = new TeacherBrainTutorProvider({
      fetcher: fetcher as typeof fetch,
      roster: [
        { studentRef: "seat-english", name: "Jordan", language: "English" },
        { studentRef: "seat-spanish", name: "Sofia", language: "Spanish" },
      ],
    });

    const opening = await provider.beginLesson({ lessonTitle: "Fractions" });
    const resumed = await provider.resumeLesson({
      lessonTitle: "Fractions",
      resumeGuidance: "Return to the number line.",
    });

    expect(opening.spokenAnswer).toContain("Lesson narration 1");
    expect(resumed.spokenAnswer).toContain("Lesson narration 2");
    const teachingRequests = requests.filter((request) => request.url.endsWith("/teach"));
    expect(teachingRequests).toHaveLength(2);
    expect(teachingRequests[0].body.instruction).toContain("main lesson in English");
    expect(teachingRequests[1].body.instruction).toContain("main lesson in English");
    expect(requests.at(-1)?.body.instruction).toContain("Return to the number line");
    expect(provider.classroomSessionId()).toBe("classroom-lifecycle");
    expect(provider.languageForStudent("seat-spanish")).toBe("es");
  });

  it("fails closed when the Teacher Brain response does not match the contract", async () => {
    const provider = new TeacherBrainTutorProvider({
      fetcher: (async (input: string | URL | Request) => String(input).endsWith("/sessions")
        ? jsonResponse({ session_id: "classroom-fixture", status: "active" })
        : jsonResponse({ plan: { board_actions: [{ type: "shell.exec" }] } })) as typeof fetch,
    });
    await expect(provider.answer({
      transcript: "Draw something unsafe.",
      lessonTitle: "Safety",
      history: [],
      studentRef: "seat-a2",
    })).rejects.toThrow();
  });
});
