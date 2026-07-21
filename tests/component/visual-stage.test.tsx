import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VisualScene } from "../../components/board/VisualStageProjector";
import { coachingFeedbackScene, decimalComparisonScene, genericTutorScene } from "../../headless/whiteboard/excalidraw-tool";

describe("animated visual stage", () => {
  it("renders a reviewed decimal scene as an accessible SVG with both hundred grids", () => {
    const scene = decimalComparisonScene("explain", "en", 1, [0.35, 0.4]);
    const { container } = render(<VisualScene scene={scene} />);
    expect(screen.getByRole("img", { name: "Compare decimals by place" })).toBeVisible();
    expect(container.querySelectorAll("rect.visual-stage-shape")).toHaveLength(201);
    expect(container.textContent).toContain("35 hundredths");
    expect(container.textContent).toContain("40 hundredths");
    expect(container.querySelectorAll(".visual-stage-connector path")).toHaveLength(4);
  });

  it("renders a generated concept diagram without executing arbitrary markup", () => {
    const scene = genericTutorScene({
      disposition: "answer",
      answer: "Water warms, evaporates, cools, and condenses into clouds.",
      spokenAnswer: "Water warms into vapor and later cools into tiny cloud droplets.",
      visual: {
        title: "How clouds form",
        kind: "sequence",
        keyIdea: "Clouds form when rising water vapor cools into tiny droplets.",
        example: "It is like invisible steam becoming a misty window.",
        nodes: [
          { label: "Warm water", detail: "Energy lifts vapor" },
          { label: "Water vapor", detail: "Rises and cools" },
          { label: "Cloud droplets", detail: "Condensation" },
        ],
        connections: [{ from: 0, to: 1, label: "evaporates" }, { from: 1, to: 2, label: "condenses" }],
      },
      followUpQuestion: "What happens when vapor cools?",
      provider: "fixture",
      model: "fixture",
    }, 2);
    const { container } = render(<VisualScene scene={scene} />);
    expect(screen.getByRole("img", { name: "How clouds form" })).toBeVisible();
    expect(container.textContent).toContain("Water vapor");
    expect(container.textContent).toContain("THE BIG IDEA");
    expect(container.textContent).toContain("MAKE IT REAL");
    expect(container.querySelector('[data-stage-id="big-idea-panel"]')).toBeInTheDocument();
    expect(container.textContent).not.toContain("<script");
  });

  it("renders supportive coaching without exposing the raw student response", () => {
    const scene = coachingFeedbackScene({
      status: "partly_correct",
      feedback: "You correctly noticed that sunlight matters.",
      coachingExplanation: "The plant also needs water and carbon dioxide.",
      retryPrompt: "What two materials join sunlight?",
      identifiedIdeas: ["sunlight"],
      provider: "fixture",
      model: "fixture",
    }, {
      prompt: "What ingredients does a plant use?",
      expectedIdeas: ["sunlight", "water", "carbon dioxide"],
      acceptableAnswers: [],
      hint: "Look at the inputs.",
      correction: "Plants use sunlight, water, and carbon dioxide.",
    }, 3);
    const { container } = render(<VisualScene scene={scene} />);
    expect(screen.getByRole("img", { name: "Good start—add one more idea" })).toBeVisible();
    expect(container.textContent).toContain("ALMOST THERE");
    expect(container.textContent).toContain("What two materials join sunlight?");
    expect(container.textContent).not.toContain("My name is Student A");
  });
});
