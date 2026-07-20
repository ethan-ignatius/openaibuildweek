import { render, screen } from "@testing-library/react";
import type { BoardElement } from "@teacher-brain/shared";
import { describe, expect, it } from "vitest";
import { BoardElementView } from "../src/BoardElementView";
import {
  applyBoardAction,
  boardReducer,
  createStarterState,
} from "../src/board-state";

describe("board state", () => {
  it("renders the M0 equation with a synchronized highlight state", () => {
    const state = createStarterState();
    expect(state["m0-equation"]?.highlight).toBe("pulse");

    render(<BoardElementView element={state["m0-equation"] as BoardElement} />);
    const equation = document.querySelector('[data-element-id="m0-equation"]');
    expect(equation).toHaveClass("highlight-pulse");
    expect(equation?.querySelector(".katex")).toBeInTheDocument();
  });

  it("applies write, highlight, unhighlight, and regional clear actions", () => {
    let state = applyBoardAction({}, {
      type: "board.write_text",
      region: "scratch",
      text: "Try subtracting five from both sides.",
      element_id: "hint-1",
    });
    state = applyBoardAction(state, {
      type: "board.highlight",
      element_id: "hint-1",
      style: "outline",
    });
    expect(state["hint-1"]?.highlight).toBe("outline");

    state = applyBoardAction(state, {
      type: "board.unhighlight",
      element_id: "hint-1",
    });
    expect(state["hint-1"]?.highlight).toBeUndefined();

    state = applyBoardAction(state, {
      type: "board.clear",
      region: "scratch",
    });
    expect(state).toEqual({});
  });

  it("replaces local state with a retained server snapshot", () => {
    const state = boardReducer(createStarterState(), {
      type: "board.snapshot",
      elements: [
        {
          action: {
            type: "board.write_text",
            region: "top",
            text: "Snapshot title",
            element_id: "snapshot-title",
          },
        },
      ],
    });

    expect(Object.keys(state)).toEqual(["snapshot-title"]);
  });
});

describe("board element", () => {
  it("sanitizes custom SVG", () => {
    render(
      <BoardElementView
        element={{
          action: {
            type: "board.render_custom",
            element_id: "safe-svg",
            svg: '<svg><script>alert(1)</script><circle cx="5" cy="5" r="5" /></svg>',
          },
        }}
      />,
    );

    expect(screen.queryByText("alert(1)")).not.toBeInTheDocument();
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(document.querySelector("circle")).toBeInTheDocument();
  });
});
