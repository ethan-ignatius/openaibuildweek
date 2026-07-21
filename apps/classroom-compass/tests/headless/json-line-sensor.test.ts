import { describe, expect, it } from "vitest";
import { JsonLineSensorAdapter } from "../../headless/adapters/json-line-sensor";
import type { HeadlessEvent } from "../../headless/core/types";

describe("JSON-line subprocess sensor", () => {
  it("drains every validated event before a short-lived adapter exits", async () => {
    const fixture = JSON.stringify({
      kind: "question_transcribed",
      source: "live",
      payload: { text: "Why is zero point three five not bigger than zero point four?" },
      provenance: { adapter: "short-lived-test", version: "1" },
    });
    const sensor = new JsonLineSensorAdapter("short-lived-test", "session-voice", {
      executable: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(`${fixture}\n`)})`],
    });
    const observed: HeadlessEvent[] = [];
    await sensor.start(async (event) => { observed.push(event); }, new AbortController().signal);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      sessionId: "session-voice",
      kind: "question_transcribed",
      payload: { text: "Why is zero point three five not bigger than zero point four?" },
    });
  });

  it("reports a missing sensor executable instead of exiting silently", async () => {
    const sensor = new JsonLineSensorAdapter("missing-microphone-test", "session-missing-microphone", {
      executable: "/definitely-not-installed/classroom-compass-microphone",
    });
    const observed: HeadlessEvent[] = [];

    await sensor.start(async (event) => { observed.push(event); }, new AbortController().signal);

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      sessionId: "session-missing-microphone",
      kind: "sensor_unavailable",
    });
    expect(observed[0].payload.detail).toContain("Unable to start missing-microphone-test");
  });
});
