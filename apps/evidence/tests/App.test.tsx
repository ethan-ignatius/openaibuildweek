import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { memoryConditions } from "../src/results";

describe("Teacher Brain evidence brief", () => {
  beforeEach(() => {
    window.print = vi.fn();
  });

  it("renders the controlled lift and the negative result", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Teacher Brain" }),
    ).toBeInTheDocument();
    expect(screen.getByText("+7.86 pts")).toBeInTheDocument();
    expect(screen.getByText("35.4%")).toBeInTheDocument();
    expect(screen.getByText("AUC, in plain English")).toBeInTheDocument();
    expect(
      screen.getByText(/Pick one future answer that was correct and one that was wrong/),
    ).toBeInTheDocument();
    expect(screen.getByText("Guessing")).toBeInTheDocument();
    expect(screen.getByText("Perfect")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "NCTE did not show harness lift" }),
    ).toBeInTheDocument();
  });

  it("keeps rendered results aligned with typed evaluation data", () => {
    render(<App />);

    const teacherBrainRow = screen
      .getByRole("rowheader", { name: "Teacher Brain notes" })
      .closest("tr");
    expect(teacherBrainRow).not.toBeNull();
    expect(within(teacherBrainRow!).getByText("0.7143")).toBeInTheDocument();
    expect(within(teacherBrainRow!).getByText("0.1723")).toBeInTheDocument();

    const bestAuc = Math.max(...memoryConditions.map((condition) => condition.auc));
    expect(bestAuc).toBe(memoryConditions[2].auc);
  });

  it("offers a printable report and source artifacts", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Print brief" }));
    expect(window.print).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("link", { name: /Learner-memory report/ }),
    ).toHaveAttribute("target", "_blank");
  });
});
