import { describe, expect, it } from "vitest";
import { bridgeRegistry, validateBridgeParams, whiteboardTools } from "../../components/bridges/registry";

describe("trusted Visual Bridge registry", () => {
  it("validates the required whiteboard tool contracts", () => {
    expect(whiteboardTools.renderHundredGrid({ values: [0.35, 0.4], interactive: true }).success).toBe(true);
    expect(whiteboardTools.renderPlaceValueChart({ values: [0.35, 0.4] }).success).toBe(true);
    expect(whiteboardTools.renderNumberLine({ min: 0, max: 1, points: [0.35, 0.4] }).success).toBe(true);
    expect(whiteboardTools.renderFractionBars({ values: [0.25, 0.5, 0.75] }).success).toBe(true);
    expect(whiteboardTools.renderEquationBalance({ left: "2x + 3", right: "11" }).success).toBe(true);
  });

  it("rejects arbitrary or out-of-range bridge parameters", () => {
    expect(validateBridgeParams("unknown-tool", {})).toEqual({ success: false, error: "Unknown bridge tool" });
    expect(whiteboardTools.renderHundredGrid({ values: [0.35, 4] }).success).toBe(false);
    expect(whiteboardTools.renderNumberLine({ min: 1, max: 0, points: [0.4] }).success).toBe(false);
  });

  it("has deterministic checks and review metadata", () => {
    const bridge = bridgeRegistry["decimal-hundred-grid"];
    expect(bridge.check({ values: [0.35, 0.4] }).answer).toBe("0.40");
    expect(bridge.reviewStatus).toBe("reviewed");
    expect(bridge.allowedInteractions).toContain("retry with hint");
  });
});
