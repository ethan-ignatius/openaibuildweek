import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleClassroomOutput } from "../../headless/adapters/classroom-output";
import { FixtureSensorAdapter } from "../../headless/adapters/fixture-sensor";
import { TutorRuntime } from "../../headless/core/tutor-runtime";
import type { ClassroomOutputAdapter, HeadlessEvent, SensorAdapter, TutorCommand } from "../../headless/core/types";
import type { TutorAnswerProvider } from "../../headless/reasoning/tutor-provider";
import { LocalEventStore, newSessionRecord } from "../../headless/storage/local-event-store";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function storeFor(sessionId: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "classroom-compass-headless-"));
  directories.push(directory);
  return new LocalEventStore(directory, newSessionRecord(sessionId, "demo"));
}

describe("headless tutor runtime", () => {
  it("runs the complete autonomous spoken decimal loop and stores observations, not labels", async () => {
    const store = await storeFor("session-demo-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [new FixtureSensorAdapter("session-demo-test", 0, true)], output);
    await runtime.start({ stopWhenSensorsComplete: true });
    const record = runtime.snapshot();
    expect(record.status).toBe("stopped");
    expect(record.rawMediaRetainedBytes).toBe(0);
    expect(record.evidence).toHaveLength(1);
    expect(record.evidence[0].statement).toContain("check independently later");
    expect(record.commands.some((command) => command.text?.startsWith("Hint:"))).toBe(true);
    expect(record.commands.filter((command) => command.toolId === "visual-stage.renderScene")).toHaveLength(3);
    const publicBoard = runtime.publicBoardState();
    expect(publicBoard.status).toBe("closed");
    expect(JSON.stringify(publicBoard)).not.toMatch(/seat-a2|student|hypothesis|confidence/i);
    expect(JSON.stringify(record.evidence)).not.toMatch(/whole numbers|diagnosis|bad at decimals/i);
    expect(JSON.parse(await readFile(store.filePath, "utf8")).rawMediaRetainedBytes).toBe(0);
  });

  it("stops owned sensor and output activity on pause and stop", async () => {
    const store = await storeFor("session-control-test");
    const output = new ConsoleClassroomOutput(true);
    output.cancel = vi.fn(async () => {});
    let release!: () => void;
    const sensor: SensorAdapter = {
      id: "blocking-sensor",
      status: "ready",
      start: vi.fn(async () => { sensor.status = "running"; await new Promise<void>((resolve) => { release = resolve; }); }),
      pause: vi.fn(async () => { sensor.status = "paused"; }),
      resume: vi.fn(async () => { sensor.status = "running"; }),
      stop: vi.fn(async () => { sensor.status = "stopped"; release?.(); }),
    };
    const runtime = new TutorRuntime(store, [sensor], output);
    const running = runtime.start();
    await vi.waitFor(() => expect(runtime.health().status).toBe("running"));
    await runtime.pause();
    expect(sensor.pause).toHaveBeenCalledOnce();
    expect(output.cancel).toHaveBeenCalledOnce();
    expect(runtime.health().status).toBe("paused");
    await runtime.stop();
    expect(sensor.stop).toHaveBeenCalledOnce();
    expect(runtime.health().rawMediaRetainedBytes).toBe(0);
    await running;
  });

  it("stops room mode instead of silently continuing after a required sensor fails", async () => {
    const previous = process.env.CC_STOP_ON_SENSOR_FAILURE;
    process.env.CC_STOP_ON_SENSOR_FAILURE = "1";
    try {
      const store = await storeFor("session-required-sensor-failure-test");
      const output = new ConsoleClassroomOutput(true);
      const runtime = new TutorRuntime(store, [], output);
      await runtime.start();
      await runtime.handleEvent({
        id: "failed-microphone",
        sessionId: "session-required-sensor-failure-test",
        kind: "sensor_unavailable",
        source: "live",
        occurredAt: new Date().toISOString(),
        payload: { detail: "Configured microphone was not found." },
        provenance: { adapter: "test-microphone", version: "1" },
      });
      expect(runtime.health().status).toBe("stopped");
      expect(runtime.snapshot().audit.some((entry) => entry.action === "sensor_failure_reported")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CC_STOP_ON_SENSOR_FAILURE;
      else process.env.CC_STOP_ON_SENSOR_FAILURE = previous;
    }
  });

  it("records unrelated questions and gives a capability notice without answering", async () => {
    const store = await storeFor("session-ignore-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const event: HeadlessEvent = { id: "unrelated", sessionId: "session-ignore-test", kind: "question_transcribed", source: "simulated", occurredAt: new Date().toISOString(), payload: { text: "Can I sharpen my pencil?" }, provenance: { adapter: "test", version: "1" } };
    await runtime.handleEvent(event);
    expect(runtime.snapshot().events).toHaveLength(1);
    expect(output.delivered).toHaveLength(1);
    expect(output.delivered[0].text).toContain("no general tutor model is configured");
    expect(runtime.snapshot().audit.some((item) => item.action === "general_question_unanswered")).toBe(true);
    await runtime.stop();
  });

  it("treats a new voice-adapter utterance as a question when no check is active", async () => {
    const store = await storeFor("session-continuous-voice-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const event: HeadlessEvent = {
      id: "voice-utterance",
      sessionId: "session-continuous-voice-test",
      kind: "response_transcribed",
      source: "live",
      occurredAt: new Date().toISOString(),
      payload: { text: "Why is zero point three five not bigger than zero point four? Thirty-five is bigger than four." },
      provenance: { adapter: "macos-on-device-speech", version: "1.0.0" },
    };
    await runtime.handleEvent(event);
    expect(runtime.health().activeInteraction?.status).toBe("awaiting_check");
    expect(output.delivered.some((command) => command.toolId === "visual-stage.renderScene")).toBe(true);
    await runtime.stop();
  });

  it("acknowledges a live hand raise by camera zone without identifying a person", async () => {
    const store = await storeFor("session-hand-raise-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    await runtime.handleEvent({
      id: "raised-hand",
      sessionId: "session-hand-raise-test",
      kind: "hand_raise",
      source: "live",
      occurredAt: new Date().toISOString(),
      payload: { seat: "camera-center", detail: "Wrist observed above shoulder." },
      provenance: { adapter: "macos-vision-hand-raise", version: "1.0.0", confidenceBand: "medium" },
    });
    expect(output.delivered).toHaveLength(1);
    expect(output.delivered[0].text).toBe("I see a raised hand near the center. Go ahead with your question.");
    expect(runtime.snapshot().evidence).toHaveLength(0);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "hand_raise_acknowledged")).toBe(true);
    await runtime.stop();
  });

  it("discards ambient transcripts and associates the called-on turn with a seat when raise gating is enabled", async () => {
    const previous = process.env.CC_REQUIRE_HAND_RAISE;
    process.env.CC_REQUIRE_HAND_RAISE = "1";
    try {
      const store = await storeFor("session-raised-hand-audio-gate-test");
      const output = new ConsoleClassroomOutput(true);
      const runtime = new TutorRuntime(store, [], output);
      await runtime.start();
      const base = { sessionId: "session-raised-hand-audio-gate-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "test", version: "1" } };

      await runtime.handleEvent({ ...base, id: "ambient", kind: "question_transcribed", payload: { text: "Someone nearby is talking." } });
      expect(runtime.snapshot().events).toHaveLength(0);
      expect(runtime.snapshot().audit.some((entry) => entry.action === "ambient_transcript_ignored")).toBe(true);

      await runtime.handleEvent({ ...base, id: "raise", kind: "hand_raise", payload: { seat: "camera-right" } });
      await runtime.handleEvent({ ...base, id: "called-on-question", kind: "question_transcribed", payload: { text: "What is three times three?" } });

      const savedQuestion = runtime.snapshot().events.find((event) => event.id === "called-on-question");
      expect(savedQuestion).toMatchObject({ studentRef: "seat:camera-right", payload: { seat: "camera-right" } });
      expect(runtime.snapshot().audit.some((entry) => entry.action === "called_on_turn_started")).toBe(true);
      expect(output.delivered.some((command) => command.text?.includes("equal groups with 3 in each group"))).toBe(true);
      await runtime.stop();
    } finally {
      if (previous === undefined) delete process.env.CC_REQUIRE_HAND_RAISE;
      else process.env.CC_REQUIRE_HAND_RAISE = previous;
    }
  });

  it("stops interruptible lesson speech before acknowledging a hand raise", async () => {
    const store = await storeFor("session-spoken-interruption-test");
    const delivered: TutorCommand[] = [];
    let releaseOpening!: () => void;
    const cancel = vi.fn(async () => releaseOpening?.());
    const output: ClassroomOutputAdapter = {
      id: "blocking-classroom-output",
      deliver: vi.fn(async (command: TutorCommand) => {
        delivered.push(command);
        if (command.text === "Opening explanation") {
          await new Promise<void>((resolve) => { releaseOpening = resolve; });
        }
      }),
      cancel,
      close: vi.fn(async () => {}),
    };
    const provider: TutorAnswerProvider = {
      id: "interruptible-lesson-fixture",
      answer: vi.fn(async () => { throw new Error("No question expected"); }),
      beginLesson: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "Opening explanation",
        spokenAnswer: "Opening explanation",
        visual: { title: "Opening lesson", nodes: [], connections: [] },
        followUpQuestion: "What do you notice?",
        provider: "fixture",
        model: "fixture",
        language: "en" as const,
      })),
      languageForStudent: () => "en",
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    const starting = runtime.start();
    await vi.waitFor(() => expect(delivered.some((command) => command.text === "Opening explanation")).toBe(true));
    await runtime.handleEvent({
      id: "interrupting-hand",
      sessionId: "session-spoken-interruption-test",
      kind: "hand_raise",
      source: "live",
      occurredAt: new Date().toISOString(),
      studentRef: "seat-english",
      payload: { seat: "camera-left" },
      provenance: { adapter: "fixture-camera", version: "1", confidenceBand: "high" },
    });
    await starting;

    expect(cancel).toHaveBeenCalledOnce();
    expect(delivered.some((command) => command.text?.includes("Go ahead with your question"))).toBe(true);
    expect(delivered.some((command) => command.text === "What do you notice?")).toBe(false);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "lesson_speech_interrupted")).toBe(true);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "lesson_start_interrupted")).toBe(true);
    await runtime.stop();
  });

  it("can wait for a raised hand without auto-starting a Teacher Brain lesson", async () => {
    const previous = process.env.CC_AUTO_START_LESSON;
    process.env.CC_AUTO_START_LESSON = "0";
    try {
      const store = await storeFor("session-wait-for-raise-test");
      const output = new ConsoleClassroomOutput(true);
      const provider: TutorAnswerProvider = {
        id: "waiting-room-fixture",
        answer: vi.fn(async () => { throw new Error("No question expected"); }),
        beginLesson: vi.fn(async () => { throw new Error("Autostart must remain disabled"); }),
      };
      const runtime = new TutorRuntime(store, [], output, provider);

      await runtime.start();

      expect(provider.beginLesson).not.toHaveBeenCalled();
      expect(output.delivered).toHaveLength(0);
      expect(runtime.snapshot().audit.some((entry) => entry.action === "lesson_autostart_disabled")).toBe(true);
      await runtime.stop();
    } finally {
      if (previous === undefined) delete process.env.CC_AUTO_START_LESSON;
      else process.env.CC_AUTO_START_LESSON = previous;
    }
  });

  it("serializes simultaneous sensor events without losing the tutoring action", async () => {
    const store = await storeFor("session-concurrent-voice-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const occurredAt = new Date().toISOString();
    await Promise.all([
      runtime.handleEvent({ id: "microphone", sessionId: "session-concurrent-voice-test", kind: "microphone_connected", source: "live", occurredAt, payload: { device: "test" }, provenance: { adapter: "test", version: "1" } }),
      runtime.handleEvent({ id: "question", sessionId: "session-concurrent-voice-test", kind: "question_transcribed", source: "live", occurredAt, payload: { text: "Why is zero point three five not bigger than zero point four?" }, provenance: { adapter: "test", version: "1" } }),
    ]);
    expect(runtime.snapshot().events).toHaveLength(2);
    expect(output.delivered.some((command) => command.toolId === "visual-stage.renderScene")).toBe(true);
    await runtime.stop();
  });

  it("completes the visual loop for the user's 0.20 and 0.40 voice question", async () => {
    const store = await storeFor("session-general-decimal-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const occurredAt = new Date().toISOString();
    await runtime.handleEvent({ id: "question-20-40", sessionId: "session-general-decimal-test", kind: "question_transcribed", source: "live", occurredAt, payload: { text: "Why is point why is .2 smaller than .4" }, provenance: { adapter: "voice", version: "1" } });
    expect(JSON.stringify(runtime.publicBoardState())).toContain("0.20");
    expect(JSON.stringify(runtime.publicBoardState())).toContain("0.40");
    await runtime.handleEvent({ id: "answer-40", sessionId: "session-general-decimal-test", kind: "response_transcribed", source: "live", occurredAt, payload: { text: "0.40 is greater" }, provenance: { adapter: "voice", version: "1" } });
    expect(runtime.snapshot().evidence[0]?.statement).toContain("0.40 as greater");
    expect(runtime.publicBoardState().status).toBe("complete");
    await runtime.stop();
  });

  it("answers an arbitrary question through a model provider and renders its visual plan", async () => {
    const store = await storeFor("session-model-question-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-general-tutor",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "Blue light is scattered through the atmosphere more strongly than red light.",
        spokenAnswer: "Air molecules scatter blue light more strongly, so the daytime sky looks blue.",
        visual: {
          title: "Why the sky looks blue",
          nodes: [
            { label: "Sunlight", detail: "Many wavelengths enter the air" },
            { label: "Atmosphere", detail: "Blue wavelengths scatter widely" },
          ],
          connections: [{ from: 0, to: 1, label: "enters" }],
        },
        followUpQuestion: "Which color scatters more strongly?",
        provider: "fixture-general-tutor",
        model: "fixture-model",
      })),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    await runtime.handleEvent({ id: "sky-question", sessionId: "session-model-question-test", kind: "question_transcribed", source: "live", occurredAt: new Date().toISOString(), payload: { text: "Why is the sky blue?" }, provenance: { adapter: "voice", version: "1" } });
    expect(provider.answer).toHaveBeenCalledOnce();
    expect(runtime.publicBoardState()).toMatchObject({ sceneId: "general-tutor-answer", source: "agent-drawing" });
    expect(JSON.stringify(runtime.publicBoardState())).toContain("Why the sky looks blue");
    expect(output.delivered.some((command) => command.text?.includes("daytime sky looks blue"))).toBe(true);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "tutor_model_answered")).toBe(true);
    await runtime.stop();
  });

  it("routes a Teacher Brain plan through the Excalidraw translator and preserves the seat reference", async () => {
    const store = await storeFor("session-teacher-brain-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "teacher-brain-fixture",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "One half means one of two equal parts.",
        spokenAnswer: "One half means one of two equal parts.",
        visual: { title: "One half", nodes: [], connections: [] },
        followUpQuestion: "How many equal parts make the whole?",
        provider: "teacher-brain-fixture",
        model: "fixture-model",
        language: "en" as const,
        boardPlan: {
          board_actions: [
            { type: "board.clear", region: "all" },
            { type: "board.draw_fraction_bars", fractions: ["1/2"], element_id: "one-half" },
          ],
          narration_segments: [{ text: "One half means one of two equal parts.", language: "English", highlight_element_id: "one-half" }],
          check_for_understanding: "How many equal parts make the whole?",
          pedagogical_rationale: "Use a part-whole representation.",
          resume_guidance: "Return to equivalent fractions.",
        },
      })),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    await runtime.handleEvent({
      id: "fraction-question",
      sessionId: "session-teacher-brain-test",
      kind: "question_transcribed",
      source: "live",
      occurredAt: new Date().toISOString(),
      studentRef: "seat-a2",
      payload: { text: "What does one half mean?" },
      provenance: { adapter: "voice", version: "1" },
    });

    expect(provider.answer).toHaveBeenCalledWith(expect.objectContaining({
      studentRef: "seat-a2",
    }), expect.any(AbortSignal));
    expect(runtime.publicBoardState()).toMatchObject({
      sceneId: "teacher-brain-2",
      source: "agent-drawing",
    });
    expect(JSON.stringify(runtime.publicBoardState())).toContain("1/2");
    await runtime.stop();
  });

  it("starts the lesson, gives a bilingual interruption answer, and resumes explicitly", async () => {
    const store = await storeFor("session-teacher-brain-lifecycle-test");
    const output = new ConsoleClassroomOutput(true);
    const plan = (label: string, bilingual = false) => ({
      board_actions: [
        { type: "board.clear" as const, region: "all" as const },
        { type: "board.write_text" as const, region: "center" as const, text: label, element_id: label.toLowerCase().replaceAll(" ", "-") },
      ],
      narration_segments: bilingual
        ? [
            { text: "Un medio y dos cuartos cubren la misma cantidad.", language: "Spanish", highlight_element_id: label.toLowerCase().replaceAll(" ", "-") },
            { text: "In English: one half and two fourths cover the same amount.", language: "English", highlight_element_id: label.toLowerCase().replaceAll(" ", "-") },
          ]
        : [{ text: label, language: "English", highlight_element_id: label.toLowerCase().replaceAll(" ", "-") }],
      check_for_understanding: bilingual ? "¿Qué cantidad cubren?" : "What do you notice?",
      pedagogical_rationale: "Use a visual comparison.",
      resume_guidance: "Return to the fraction bar lesson.",
    });
    const beginLesson = vi.fn(async () => ({
      disposition: "answer" as const,
      answer: "Opening lesson",
      spokenAnswer: "Opening lesson",
      visual: { title: "Fractions", nodes: [], connections: [] },
      followUpQuestion: "What do you notice?",
      provider: "teacher-brain-fixture",
      model: "fixture",
      language: "en" as const,
      boardPlan: plan("Opening lesson"),
    }));
    const answer = vi.fn(async () => ({
      disposition: "answer" as const,
      answer: "Un medio equivale a dos cuartos.",
      spokenAnswer: "Un medio equivale a dos cuartos.",
      spokenSegments: [
        { text: "Un medio y dos cuartos cubren la misma cantidad.", language: "es" as const },
        { text: "In English: one half and two fourths cover the same amount.", language: "en" as const },
      ],
      visual: { title: "Fractions", nodes: [], connections: [] },
      followUpQuestion: "¿Qué cantidad cubren?",
      provider: "teacher-brain-fixture",
      model: "fixture",
      language: "es" as const,
      boardPlan: plan("Bilingual explanation", true),
      providerMetadata: { resumeGuidance: "Return to the fraction bar lesson." },
    }));
    const resumeLesson = vi.fn(async () => ({
      disposition: "answer" as const,
      answer: "Now let’s return to the fraction bars.",
      spokenAnswer: "Now let’s return to the fraction bars.",
      visual: { title: "Fractions", nodes: [], connections: [] },
      followUpQuestion: "Which pair should we compare next?",
      provider: "teacher-brain-fixture",
      model: "fixture",
      language: "en" as const,
      boardPlan: plan("Resumed lesson"),
    }));
    const provider: TutorAnswerProvider = {
      id: "teacher-brain-fixture",
      beginLesson,
      answer,
      resumeLesson,
      languageForStudent: () => "es",
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    await runtime.handleEvent({
      id: "spanish-question",
      sessionId: "session-teacher-brain-lifecycle-test",
      kind: "question_transcribed",
      source: "simulated",
      occurredAt: new Date().toISOString(),
      studentRef: "seat-spanish",
      payload: { text: "¿Por qué un medio es igual a dos cuartos?" },
      provenance: { adapter: "fixture", version: "1", confidenceBand: "high" },
    });

    expect(beginLesson).toHaveBeenCalledOnce();
    expect(answer).toHaveBeenCalledWith(expect.objectContaining({ studentRef: "seat-spanish" }), expect.any(AbortSignal));
    expect(resumeLesson).toHaveBeenCalledWith(expect.objectContaining({
      resumeGuidance: "Return to the fraction bar lesson.",
    }), expect.any(AbortSignal));
    expect(output.delivered.some((command) => command.language === "es" && command.text?.startsWith("Un medio"))).toBe(true);
    expect(output.delivered.some((command) => command.language === "en" && command.text?.startsWith("In English"))).toBe(true);
    expect(JSON.stringify(output.delivered)).toContain("English recap");
    expect(runtime.snapshot().audit.some((entry) => entry.action === "lesson_resumed")).toBe(true);
    await runtime.stop();
  });

  it("uses verified decimal computation instead of asking the language model to guess arithmetic", async () => {
    const store = await storeFor("session-verified-math-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-general-tutor",
      answer: vi.fn(async () => { throw new Error("The model must not be called for a recognized computation"); }),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    await runtime.handleEvent({
      id: "decimal-question",
      sessionId: "session-verified-math-test",
      kind: "question_transcribed",
      source: "live",
      occurredAt: new Date().toISOString(),
      payload: { text: "Why is 0.35 not bigger than 0.4?" },
      provenance: { adapter: "voice", version: "1" },
    });
    expect(provider.answer).not.toHaveBeenCalled();
    expect(output.delivered.some((command) => command.text?.includes("40 hundredths is more than 35 hundredths"))).toBe(true);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "reviewed_tool_selected")).toBe(true);
    await runtime.stop();
  });

  it("queues a follow-up that arrives while the first model answer is still being prepared", async () => {
    const store = await storeFor("session-queued-follow-up-test");
    const output = new ConsoleClassroomOutput(true);
    let releaseFirst!: () => void;
    const provider: TutorAnswerProvider = {
      id: "fixture-conversation-tutor",
      answer: vi.fn(async (input) => {
        if (input.transcript === "How does rain form?") await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return {
          disposition: "answer" as const,
          answer: `Answer for: ${input.transcript}`,
          spokenAnswer: `Answer for: ${input.transcript}`,
          visual: { title: "Conversation", nodes: [{ label: "Idea", detail: input.transcript }], connections: [] },
          followUpQuestion: "",
          provider: "fixture-conversation-tutor",
          model: "fixture-model",
        };
      }),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    const first = runtime.handleEvent({ id: "first", sessionId: "session-queued-follow-up-test", kind: "question_transcribed", source: "live", occurredAt: new Date().toISOString(), payload: { text: "How does rain form?" }, provenance: { adapter: "voice", version: "1", confidenceBand: "medium" } });
    await vi.waitFor(() => expect(provider.answer).toHaveBeenCalledOnce());
    await runtime.handleEvent({ id: "follow-up", sessionId: "session-queued-follow-up-test", kind: "response_transcribed", source: "live", occurredAt: new Date().toISOString(), payload: { text: "What happens to the water next?" }, provenance: { adapter: "voice", version: "1", confidenceBand: "medium" } });
    releaseFirst();
    await first;
    expect(provider.answer).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.answer).mock.calls[1][0].history).toEqual(expect.arrayContaining([
      { role: "student", content: "How does rain form?" },
    ]));
    expect(runtime.snapshot().audit.some((entry) => entry.action === "question_queued")).toBe(true);
    await runtime.stop();
  });

  it("does not treat its own amplified follow-up prompt as a new student question", async () => {
    const store = await storeFor("session-output-echo-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-echo-tutor",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "Evaporation changes liquid water into water vapor.",
        spokenAnswer: "Evaporation changes liquid water into water vapor.",
        visual: { title: "Evaporation", nodes: [{ label: "Liquid", detail: "Warms into vapor" }], connections: [] },
        followUpQuestion: "What supplies the energy for evaporation?",
        provider: "fixture-echo-tutor",
        model: "fixture-model",
      })),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    await runtime.handleEvent({ id: "water", sessionId: "session-output-echo-test", kind: "question_transcribed", source: "live", occurredAt: new Date().toISOString(), payload: { text: "What is evaporation?" }, provenance: { adapter: "voice", version: "1" } });
    await runtime.handleEvent({ id: "speaker-echo", sessionId: "session-output-echo-test", kind: "response_transcribed", source: "live", occurredAt: new Date().toISOString(), payload: { text: "What supplies the energy for evaporation?" }, provenance: { adapter: "voice", version: "1" } });
    expect(provider.answer).toHaveBeenCalledOnce();
    expect(runtime.snapshot().audit.some((entry) => entry.action === "tutor_audio_echo_ignored")).toBe(true);
    await runtime.stop();
  });

  it("keeps mixed loudspeaker echo and overlapping Whisper windows in one model turn", async () => {
    const store = await storeFor("session-mixed-output-echo-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-explanatory-tutor",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "Three times three means three equal groups of three. Three plus three plus three equals nine.",
        spokenAnswer: "Three times three means three equal groups of three. Three plus three plus three equals nine.",
        visual: { title: "Three groups of three", nodes: [{ label: "3 + 3 + 3", detail: "Three equal groups" }], connections: [] },
        followUpQuestion: "How does repeated addition show the same total?",
        provider: "fixture-explanatory-tutor",
        model: "fixture-model",
      })),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    const base = { sessionId: "session-mixed-output-echo-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "voice", version: "1" } };
    await runtime.handleEvent({ ...base, id: "raise", kind: "hand_raise", payload: { seat: "camera-center" } });
    await runtime.handleEvent({ ...base, id: "callout-echo", kind: "question_transcribed", payload: { text: "I see a raised hand near the center. Go ahead with your question." } });
    await runtime.handleEvent({ ...base, id: "actual-question", kind: "response_transcribed", payload: { text: "I see a raised hand near the center. Go ahead with your question. What is three times three?" } });
    await runtime.handleEvent({
      ...base,
      id: "rolling-window-echo",
      kind: "response_transcribed",
      payload: { text: "Go ahead with your question. What is three times three? 3 times 3 means 3 equal groups with 3 in each group. Combining those equal groups gives 9. So 3 times 3 equals 9. How could you show 3 × 3 with dots or counters?" },
    });
    expect(provider.answer).not.toHaveBeenCalled();
    expect(runtime.snapshot().audit.some((entry) => entry.action === "reviewed_arithmetic_selected")).toBe(true);
    expect(output.delivered.some((command) => command.text?.includes("equal groups with 3 in each group"))).toBe(true);
    expect(output.delivered.filter((command) => command.text === "Let me think about that.")).toHaveLength(0);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "tutor_audio_echo_ignored")).toBe(true);
    expect(runtime.snapshot().audit.filter((entry) => entry.action === "reviewed_arithmetic_selected")).toHaveLength(1);
    await runtime.stop();
  });

  it("gives an arithmetic clue after an incorrect reply and confirms a corrected retry", async () => {
    const store = await storeFor("session-arithmetic-coaching-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const base = { sessionId: "session-arithmetic-coaching-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "voice", version: "1", confidenceBand: "high" as const } };
    await runtime.handleEvent({ ...base, id: "question", kind: "question_transcribed", payload: { text: "What is three times three?" } });
    await runtime.handleEvent({ ...base, id: "first-answer", kind: "response_transcribed", payload: { text: "I think it is six." } });

    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_retry_prompted")).toBe(true);
    expect(output.delivered.some((command) => command.text?.includes("does not match the pattern yet"))).toBe(true);
    expect(runtime.publicBoardState().title).toBe("Let’s adjust one step");

    await runtime.handleEvent({ ...base, id: "second-answer", kind: "response_transcribed", payload: { text: "I would draw three groups of three, so there are nine dots." } });
    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_check_completed")).toBe(true);
    expect(output.delivered.some((command) => command.text === "Yes—your answer connects to the key idea.")).toBe(true);
    expect(runtime.publicBoardState().title).toBe("You’re on the right track!");
    expect(JSON.stringify(runtime.publicBoardState())).not.toContain("I think it is six");
    await runtime.stop();
  });

  it("uses the tutor provider to coach a partly correct science response without grading it", async () => {
    const store = await storeFor("session-science-coaching-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-coaching-tutor",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "Photosynthesis lets a plant use sunlight, water, and carbon dioxide to make sugar for growth.",
        spokenAnswer: "A plant uses sunlight, water, and carbon dioxide to make sugar. That sugar helps it build new roots, stems, and leaves.",
        visual: { title: "Plant food factory", kind: "sequence" as const, keyIdea: "Plants make sugar using light, water, and carbon dioxide.", example: "A sunny leaf makes sugar.", nodes: [{ label: "Inputs", detail: "Light, water, and air", symbol: "plant" as const }, { label: "Sugar", detail: "Food for growth", symbol: "plant" as const }], connections: [{ from: 0, to: 1, label: "make" }] },
        followUpQuestion: "What ingredients does a plant use to make sugar?",
        comprehensionCheck: {
          prompt: "What ingredients does a plant use to make sugar?",
          expectedIdeas: ["sunlight", "water", "carbon dioxide"],
          acceptableAnswers: [],
          hint: "Look at the three inputs shown before sugar.",
          correction: "A plant uses sunlight, water, and carbon dioxide to make sugar.",
        },
        provider: "fixture-coaching-tutor",
        model: "fixture-model",
      })),
      assess: vi.fn(async (input) => input.studentResponse.includes("water")
        ? { status: "correct" as const, feedback: "You connected all three inputs to the sugar the plant makes.", coachingExplanation: "Sunlight supplies energy while water and carbon dioxide supply material.", retryPrompt: "", identifiedIdeas: ["sunlight", "water", "carbon dioxide"], provider: "fixture-coaching-tutor", model: "fixture-model" }
        : { status: "partly_correct" as const, feedback: "You noticed that sunlight matters.", coachingExplanation: "The plant also needs two materials shown in the visual.", retryPrompt: "Besides sunlight, what two materials enter the plant?", identifiedIdeas: ["sunlight"], provider: "fixture-coaching-tutor", model: "fixture-model" }),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    const base = { sessionId: "session-science-coaching-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "voice", version: "1", confidenceBand: "high" as const } };
    await runtime.handleEvent({ ...base, id: "question", kind: "question_transcribed", payload: { text: "How does photosynthesis help a plant?" } });
    await runtime.handleEvent({ ...base, id: "partial", kind: "response_transcribed", payload: { text: "It uses sunlight." } });
    expect(provider.assess).toHaveBeenCalledOnce();
    expect(output.delivered.some((command) => command.text === "You noticed that sunlight matters.")).toBe(true);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_retry_prompted")).toBe(true);

    await runtime.handleEvent({ ...base, id: "corrected", kind: "response_transcribed", payload: { text: "It uses sunlight, water, and carbon dioxide." } });
    expect(provider.assess).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_check_completed")).toBe(true);
    expect(runtime.snapshot().audit.every((entry) => !/grade|rank|diagnos/i.test(entry.action))).toBe(true);
    expect(JSON.stringify(runtime.publicBoardState())).not.toContain("It uses sunlight, water");
    await runtime.stop();
  });

  it("falls back cautiously when the answer provider has no assessment capability", async () => {
    const store = await storeFor("session-coaching-fallback-test");
    const output = new ConsoleClassroomOutput(true);
    const provider: TutorAnswerProvider = {
      id: "fixture-answer-only-tutor",
      answer: vi.fn(async () => ({
        disposition: "answer" as const,
        answer: "A shadow forms when an object blocks light.",
        spokenAnswer: "A shadow forms when an object blocks light from reaching a surface.",
        visual: { title: "How shadows form", kind: "cause_effect" as const, keyIdea: "An object blocks light and leaves a darker area.", example: "Your hand can block a flashlight.", nodes: [{ label: "Light", detail: "Travels toward an object", symbol: "sun" as const }, { label: "Shadow", detail: "The blocked area is darker", symbol: "idea" as const }], connections: [{ from: 0, to: 1, label: "is blocked" }] },
        followUpQuestion: "What must an object do to make a shadow?",
        comprehensionCheck: { prompt: "What must an object do to make a shadow?", expectedIdeas: ["block light"], acceptableAnswers: [], hint: "Think about what happens between the light and the wall.", correction: "The object must block light from reaching part of a surface." },
        provider: "fixture-answer-only-tutor",
        model: "fixture-model",
      })),
    };
    const runtime = new TutorRuntime(store, [], output, provider);
    await runtime.start();
    const base = { sessionId: "session-coaching-fallback-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "voice", version: "1" } };
    await runtime.handleEvent({ ...base, id: "question", kind: "question_transcribed", payload: { text: "How do shadows form?" } });
    await runtime.handleEvent({ ...base, id: "response", kind: "response_transcribed", payload: { text: "It blocks something." } });
    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_retry_prompted")).toBe(true);
    expect(runtime.publicBoardState().title).toMatch(/Good start|clearer/);
    expect(runtime.snapshot().audit.every((entry) => entry.action !== "tutor_model_failed")).toBe(true);
    await runtime.stop();
  });

  it("ends the coaching loop with a supportive correction after two unsuccessful attempts", async () => {
    const store = await storeFor("session-bounded-coaching-test");
    const output = new ConsoleClassroomOutput(true);
    const runtime = new TutorRuntime(store, [], output);
    await runtime.start();
    const base = { sessionId: "session-bounded-coaching-test", source: "live" as const, occurredAt: new Date().toISOString(), provenance: { adapter: "voice", version: "1" } };
    await runtime.handleEvent({ ...base, id: "question", kind: "question_transcribed", payload: { text: "What is two times four?" } });
    await runtime.handleEvent({ ...base, id: "attempt-one", kind: "response_transcribed", payload: { text: "I would draw one group, so four dots." } });
    await runtime.handleEvent({ ...base, id: "attempt-two", kind: "response_transcribed", payload: { text: "Maybe it is six dots." } });
    expect(runtime.snapshot().audit.some((entry) => entry.action === "comprehension_check_closed_with_correction")).toBe(true);
    expect(output.delivered.some((command) => command.text?.startsWith("Let’s rebuild that idea together."))).toBe(true);
    expect(runtime.publicBoardState().status).toBe("complete");

    const commandCount = output.delivered.length;
    await runtime.handleEvent({ ...base, id: "new-question", kind: "response_transcribed", payload: { text: "What is five plus five?" } });
    expect(output.delivered.length).toBeGreaterThan(commandCount);
    expect(runtime.snapshot().audit.filter((entry) => entry.action === "comprehension_check_closed_with_correction")).toHaveLength(1);
    await runtime.stop();
  });
});
