import { describe, expect, it } from "vitest";
import { decimalComparisonScene, ExcalidrawBoardController, genericTutorScene, teacherBrainPlanScene } from "../../headless/whiteboard/excalidraw-tool";

describe("bounded Excalidraw whiteboard tool", () => {
  it("builds an accurate reviewed decimal scene", () => {
    const scene = decimalComparisonScene("explain", "en", 1);
    const board = new ExcalidrawBoardController();
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
    const board = new ExcalidrawBoardController();
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
    const panel = scene.elements.find((element) => element.id === "answer-panel");
    expect(panel).toMatchObject({ type: "rectangle", width: 1310 });
    expect("height" in panel! && panel.height).toBeLessThanOrEqual(260);
    const concepts = scene.elements.filter((element) => /^concept-\d$/.test(element.id));
    expect(concepts).toHaveLength(3);
    expect(concepts.every((element) => element.type === "rectangle")).toBe(true);
    expect(concepts.map((element) => element.x)).toEqual([...concepts.map((element) => element.x)].sort((a, b) => a - b));
    const connectors = scene.elements.filter((element) => element.id.startsWith("connection-"));
    expect(connectors.every((element) => element.type === "arrow" && element.points.length === 2)).toBe(true);
    expect(connectors.every((element) => element.type === "arrow" && Math.abs(element.points[1][0]) < 100)).toBe(true);
    expect(connectors.map((element) => "label" in element ? element.label : undefined)).toEqual(["+", "="]);
    expect(scene.elements.find((element) => element.id === "equation-callout")).toMatchObject({ type: "text", text: "2 + 24 = 26" });
  });

  it("rejects duplicate IDs and out-of-bounds agent commands", () => {
    const board = new ExcalidrawBoardController();
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
    expect(() => new ExcalidrawBoardController().render(scene)).not.toThrow();
  });
});
