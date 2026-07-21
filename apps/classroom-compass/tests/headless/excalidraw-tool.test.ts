import { describe, expect, it } from "vitest";
import { decimalComparisonScene, genericTutorScene, teacherBrainPlanScene, teacherBrainVisualStageScene, VisualStageBoardController } from "../../headless/whiteboard/excalidraw-tool";

describe("bounded Visual Stage whiteboard tool", () => {
  it("builds an accurate reviewed decimal scene", () => {
    const scene = decimalComparisonScene("explain", "en", 1);
    const board = new VisualStageBoardController();
    expect(board.render(scene)).toMatchObject({
      sceneId: "decimal-comparison",
      source: "reviewed-component",
      status: "active",
    });
    expect(scene.elements.filter((element) => element.id.startsWith("grid-a-cell-"))).toHaveLength(100);
    expect(scene.elements.filter((element) => element.id.startsWith("grid-b-cell-"))).toHaveLength(100);
    const shaded35 = scene.elements.filter((element) => element.id.startsWith("grid-a-cell-") && "backgroundColor" in element && element.backgroundColor === "#dcebe3");
    const shaded40 = scene.elements.filter((element) => element.id.startsWith("grid-b-cell-") && "backgroundColor" in element && element.backgroundColor === "#d8ea83");
    expect(shaded35).toHaveLength(35);
    expect(shaded40).toHaveLength(40);
  });

  it("renders the values from a newly recognized decimal question", () => {
    const scene = decimalComparisonScene("explain", "en", 2, [0.2, 0.4]);
    const shaded20 = scene.elements.filter((element) => element.id.startsWith("grid-a-cell-") && "backgroundColor" in element && element.backgroundColor === "#dcebe3");
    const shaded40 = scene.elements.filter((element) => element.id.startsWith("grid-b-cell-") && "backgroundColor" in element && element.backgroundColor === "#d8ea83");
    expect(shaded20).toHaveLength(20);
    expect(shaded40).toHaveLength(40);
    expect(JSON.stringify(scene)).toContain("0.20");
    expect(JSON.stringify(scene)).toContain("0.40");
  });

  it("accepts an agent-planned drawing only through the public schema", () => {
    const board = new VisualStageBoardController();
    const rendered = board.render({
      schemaVersion: 1,
      sceneId: "agent-fraction-sketch",
      revision: 1,
      title: "Three fourths",
      language: "en",
      status: "active",
      source: "agent-drawing",
      studentRef: "private-seat-a2",
      transcript: "private question",
      hypothesis: "private interpretation",
      elements: [
        { id: "bar", type: "rectangle", x: 10, y: 10, width: 400, height: 80, label: "3/4", privateNote: "do not display" },
        { id: "stroke", type: "line", x: 10, y: 120, points: [[0, 0], [30, 12], [70, 4]], strokeColor: "#17211b" },
      ],
    });
    expect(JSON.stringify(rendered)).not.toMatch(/private-seat|private question|private interpretation|privateNote/);
    expect(rendered.source).toBe("agent-drawing");
  });

  it("lays out generated answers compactly with a clean left-to-right visual flow", () => {
    const scene = genericTutorScene({
      disposition: "answer",
      answer: "Adding combines quantities. 2 + 24 = 26.",
      spokenAnswer: "Two plus twenty-four equals twenty-six.",
      visual: {
        title: "Adding whole numbers",
        kind: "groups",
        keyIdea: "Multiplication and addition can both combine equal groups.",
        example: "Imagine 2 counters beside 24 more counters.",
        nodes: [
          { label: "2", detail: "First quantity" },
          { label: "24", detail: "Second quantity" },
          { label: "26", detail: "Combined total" },
        ],
        connections: [
          { from: 0, to: 1, label: "plus" },
          { from: 1, to: 2, label: "equals" },
        ],
      },
      followUpQuestion: "Can you show the addition with objects?",
      provider: "fixture",
      model: "fixture",
    }, 1);
    const panel = scene.elements.find((element) => element.id === "big-idea-panel");
    expect(panel).toMatchObject({ type: "rectangle", width: 830, height: 200, fillStyle: "solid" });
    expect(scene.elements.find((element) => element.id === "example-panel")).toMatchObject({ type: "rectangle", width: 440, height: 200 });
    const concepts = scene.elements.filter((element) => /^concept-\d$/.test(element.id));
    expect(concepts).toHaveLength(3);
    expect(concepts.every((element) => element.type === "rectangle")).toBe(true);
    expect(concepts.map((element) => element.x)).toEqual([...concepts.map((element) => element.x)].sort((a, b) => a - b));
    const connectors = scene.elements.filter((element) => /^connection-\d+$/.test(element.id));
    expect(connectors.every((element) => element.type === "arrow" && element.points.length === 2)).toBe(true);
    expect(connectors.every((element) => element.type === "arrow" && Math.abs(element.points[1][0]) < 100)).toBe(true);
    expect(scene.elements.filter((element) => /^connection-\d+-label$/.test(element.id)).map((element) => "text" in element ? element.text : undefined)).toEqual(["+", "="]);
    expect(scene.elements.find((element) => element.id === "example-copy")).toMatchObject({ type: "text" });
    expect(JSON.stringify(scene.elements.find((element) => element.id === "example-copy"))).toContain("2 + 24 = 26");
    expect(scene.elements.filter((element) => element.id.startsWith("concept-") && element.type === "rectangle").every((element) => "fillStyle" in element && element.fillStyle === "solid")).toBe(true);
  });

  it("keeps long elementary science copy inside its teaching cards", () => {
    const scene = genericTutorScene({
      disposition: "answer",
      answer: "Photosynthesis lets a plant use sunlight, water, and carbon dioxide to make glucose and release oxygen.",
      spokenAnswer: "Photosynthesis lets a plant use sunlight, water, and carbon dioxide to make glucose and release oxygen.",
      visual: {
        title: "How a plant obtains the inputs for photosynthesis",
        kind: "sequence",
        keyIdea: "Plants take in water through their roots and carbon dioxide through tiny openings in their leaves, then chlorophyll captures light energy to help make glucose.",
        example: "Follow each ingredient from outside the plant into the leaf, where the materials connect and glucose is made.",
        nodes: [
          { label: "Sunlight energy", detail: "Chlorophyll captures light in the leaf" },
          { label: "Carbon dioxide through stomata", detail: "Gas enters through tiny leaf openings" },
          { label: "Water from the roots", detail: "Water travels upward through xylem" },
          { label: "Glucose and oxygen", detail: "Sugar is made and oxygen is released" },
        ],
        connections: [{ from: 0, to: 1, label: "then" }, { from: 1, to: 2, label: "then" }, { from: 2, to: 3, label: "then" }],
      },
      followUpQuestion: "Which input enters through the roots, and which input enters through the leaves?",
      provider: "fixture",
      model: "fixture",
    }, 3);
    const textElement = (id: string) => scene.elements.find((element) => element.id === id && element.type === "text");
    const renderedBottom = (id: string) => {
      const element = textElement(id);
      if (!element || element.type !== "text") throw new Error(`Missing text element ${id}`);
      const lines = element.text.split("\n").length;
      const size = element.fontSize ?? 28;
      return element.y + size + Math.max(0, lines - 1) * size * 1.28;
    };

    expect(renderedBottom("big-idea-copy")).toBeLessThanOrEqual(326);
    expect(renderedBottom("example-copy")).toBeLessThanOrEqual(326);
    for (let index = 0; index < 4; index += 1) {
      expect(renderedBottom(`concept-${index}-label`)).toBeLessThan(500);
      expect(renderedBottom(`concept-${index}-detail`)).toBeLessThanOrEqual(565);
    }
    expect(renderedBottom("follow-up")).toBeLessThanOrEqual(745);
  });

  it("rejects duplicate IDs and out-of-bounds agent commands", () => {
    const board = new VisualStageBoardController();
    const base = {
      schemaVersion: 1 as const,
      sceneId: "invalid-scene",
      revision: 1,
      title: "Invalid",
      language: "en" as const,
      status: "active" as const,
      source: "agent-drawing" as const,
    };
    expect(() => board.render({ ...base, elements: [
      { id: "same", type: "text", x: 0, y: 0, text: "A" },
      { id: "same", type: "text", x: 20, y: 20, text: "B" },
    ] })).toThrow(/Duplicate board element id/);
    expect(() => board.render({ ...base, elements: [
      { id: "huge", type: "rectangle", x: 0, y: 0, width: 100_000, height: 10 },
    ] })).toThrow();
  });

  it("translates Teacher Brain board tools into a private-data-free Excalidraw scene", () => {
    const scene = teacherBrainPlanScene({
      board_actions: [
        { type: "board.clear", region: "all" },
        { type: "board.write_text", region: "top", text: "Equivalent fractions", element_id: "lesson.title" },
        { type: "board.write_math", region: "center", latex: "\\frac{3}{4}", element_id: "fraction.value" },
        { type: "board.draw_fraction_bars", fractions: ["3/4"], element_id: "fraction.bar" },
        { type: "board.draw_number_line", min: 0, max: 1, marks: [{ value: 0.75, label: "3/4" }], element_id: "fraction.line" },
        { type: "board.highlight", element_id: "fraction.value", style: "outline" },
        { type: "board.render_custom", svg: "<svg><script>privateTranscript()</script></svg>", element_id: "custom.private" },
      ],
      narration_segments: [
        { text: "Tres cuartos son tres de cuatro partes iguales.", language: "Spanish", highlight_element_id: "fraction.value" },
        { text: "Three fourths is three equal parts out of four.", language: "English", highlight_element_id: "fraction.value" },
      ],
      check_for_understanding: "What does the denominator count?",
      pedagogical_rationale: "private operator rationale",
      resume_guidance: "private resume plan",
    }, "Equivalent fractions", "en", 4);

    expect(scene).toMatchObject({
      sceneId: "teacher-brain-4",
      source: "agent-drawing",
      status: "active",
    });
    expect(JSON.stringify(scene)).toContain("3/4");
    expect(JSON.stringify(scene)).toContain("Español");
    expect(JSON.stringify(scene)).toContain("English recap");
    expect(JSON.stringify(scene)).toContain("Tres cuartos");
    expect(JSON.stringify(scene)).toContain("Three fourths");
    expect(JSON.stringify(scene)).not.toContain("private operator rationale");
    expect(JSON.stringify(scene)).not.toContain("private resume plan");
    expect(JSON.stringify(scene)).not.toContain("privateTranscript");
    expect(() => new VisualStageBoardController().render(scene)).not.toThrow();
  });

  it("uses the child-friendly Visual Stage layout instead of projecting a custom-SVG placeholder", () => {
    const scene = teacherBrainVisualStageScene({
      disposition: "answer",
      answer: "Plants use sunlight, water, and carbon dioxide to make sugar and release oxygen.",
      spokenAnswer: "Plants use sunlight, water, and carbon dioxide to make sugar.",
      visual: {
        title: "How plants make food",
        kind: "sequence",
        keyIdea: "A leaf uses light energy to make sugar.",
        example: "Trace each ingredient into the leaf.",
        nodes: [
          { label: "Sunlight", detail: "Energy from the sun", symbol: "sun" },
          { label: "Water", detail: "Moves up from the roots", symbol: "water" },
          { label: "Sugar", detail: "Food made by the plant", symbol: "plant" },
        ],
        connections: [{ from: 0, to: 1, label: "joins" }, { from: 1, to: 2, label: "helps make" }],
      },
      followUpQuestion: "What provides the energy?",
      provider: "teacher-brain-fixture",
      model: "fixture",
      language: "en",
      boardPlan: {
        board_actions: [
          { type: "board.clear", region: "all" },
          { type: "board.write_text", region: "top", text: "How plants make food", element_id: "title" },
          { type: "board.render_custom", svg: "<svg><text>Sunlight</text><text>Water</text><text>Sugar</text></svg>", element_id: "diagram" },
        ],
        narration_segments: [{ text: "Plants make sugar using light.", language: "English" }],
        check_for_understanding: "What provides the energy?",
        pedagogical_rationale: "Use a concrete process.",
        resume_guidance: "Return to the lesson.",
      },
    }, 7);

    expect(scene.sceneId).toBe("general-tutor-answer");
    expect(JSON.stringify(scene)).toContain("THE BIG IDEA");
    expect(JSON.stringify(scene)).toContain("Sunlight");
    expect(JSON.stringify(scene)).not.toContain("custom diagram");
  });
});
