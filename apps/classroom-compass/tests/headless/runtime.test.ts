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
    expect(record.commands.filter((command) => command.toolId === "excalidraw.renderScene")).toHaveLength(3);
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
    expect(output.delivered.some((command) => command.toolId === "excalidraw.renderScene")).toBe(true);
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
    expect(output.delivered.some((command) => command.toolId === "excalidraw.renderScene")).toBe(true);
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
});
