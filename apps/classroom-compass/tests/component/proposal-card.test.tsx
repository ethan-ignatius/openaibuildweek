import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProposalCard } from "../../components/teacher/ProposalCard";
import { createInitialState, decimalProposal, decimalQuestionEvent } from "../../demo/fixtures";
import type { AppState } from "../../domain/types";

function harness() {
  let current: AppState = { ...createInitialState(), events: [decimalQuestionEvent], proposals: [decimalProposal] };
  const update = (recipe: (state: AppState) => AppState) => { current = recipe(current); };
  render(<ProposalCard proposal={current.proposals[0]} state={current} update={update} />);
  return () => current;
}

describe("teacher proposal controls", () => {
  it("requires an explicit launch action before a bridge appears", () => {
    const current = harness();
    expect(current().activeBridge).toBeNull();
    fireEvent.click(screen.getByTestId("launch-proposal-decimals"));
    expect(current().activeBridge?.bridgeId).toBe("decimal-hundred-grid");
    expect(current().proposals[0].reviewState).toBe("confirmed");
  });

  it("dismisses without creating student evidence", () => {
    const current = harness();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(current().proposals[0].reviewState).toBe("dismissed");
    expect(current().students.every((student) => student.evidence.length === 0)).toBe(true);
  });
});
