import type { ClassroomOutputAdapter, HeadlessEvent, InteractionState, ObservedEvidence, RuntimeHealth, SensorAdapter, TutorCommand } from "./types";
import { DecimalTutorPolicy } from "../policies/decimal-tutor-policy";
import { LocalEventStore } from "../storage/local-event-store";
import type { TutorAnswerProvider, TutorHistoryItem } from "../reasoning/tutor-provider";
import { decimalComparisonScene, ExcalidrawBoardController, genericTutorScene, teacherBrainPlanScene, tutorThinkingScene, type ExcalidrawScene } from "../whiteboard/excalidraw-tool";

export class TutorRuntime {
  private controller = new AbortController();
  private activeInteraction: InteractionState | null = null;
  private interactionLanguage: "en" | "es" = "en";
  private status: RuntimeHealth["status"] = "starting";
  private boardRevision = 0;
  private processingQuestion = false;
  private conversation: TutorHistoryItem[] = [];
  private deferredQuestions: HeadlessEvent[] = [];
  private activeSpokenText: string | null = null;
  private recentSpokenTexts: Array<{ text: string; completedAt: number }> = [];

  constructor(
    private store: LocalEventStore,
    private sensors: SensorAdapter[],
    private output: ClassroomOutputAdapter,
    private tutorProvider: TutorAnswerProvider | null = null,
    private policy = new DecimalTutorPolicy(),
    private board = new ExcalidrawBoardController(),
  ) {}

  async start(options: { stopWhenSensorsComplete?: boolean } = {}) {
    await this.store.initialize();
    this.status = "running";
    await this.store.update((record) => { record.status = "running"; });
    await this.store.appendAudit("runtime_started", `Headless tutor started with ${this.sensors.length} sensor adapter(s) and output ${this.output.id}.`);
    await Promise.all(this.sensors.map((sensor) => sensor.start((event) => this.handleEvent(event), this.controller.signal)));
    if (options.stopWhenSensorsComplete) await this.stop("Sensor fixture completed.");
  }

  async handleEvent(event: HeadlessEvent) {
    if (this.status !== "running") return;
    await this.store.appendEvent(event);
    if ((event.kind === "question_transcribed" || event.kind === "response_transcribed") && this.isTutorAudioEcho(event.payload.text ?? "")) {
      await this.store.appendAudit("tutor_audio_echo_ignored", "A transcript closely matched current or recent tutor speech and was not treated as a student turn.");
      return;
    }
    if (event.kind === "hand_raise") return this.handleHandRaise(event);
    if (event.kind === "question_transcribed") return this.handleQuestion(event);
    if (event.kind === "response_transcribed") {
      if (this.activeInteraction) return this.handleResponse(event);
      return this.handleQuestion({ ...event, kind: "question_transcribed" });
    }
  }

  private async handleHandRaise(event: HeadlessEvent) {
    if (this.processingQuestion || this.activeInteraction || this.activeSpokenText) {
      await this.store.appendAudit("hand_raise_observed_busy", "A hand raise was recorded while the tutor was already facilitating a turn; it did not interrupt the active interaction.");
      return;
    }
    const zone = event.payload.seat === "camera-left"
      ? "on the left side"
      : event.payload.seat === "camera-right"
        ? "on the right side"
        : "near the center";
    await this.store.appendAudit("hand_raise_acknowledged", `A live hand-raise event ${zone} was acknowledged without identifying a person.`);
    await this.speak(`I see a raised hand ${zone}. Go ahead with your question.`, "en");
  }

  private async handleQuestion(event: HeadlessEvent) {
    if (this.processingQuestion) {
      if (this.deferredQuestions.length < 3) {
        this.deferredQuestions.push(event);
        await this.store.appendAudit("question_queued", "A follow-up arrived while the tutor was finishing its response and will be answered next.");
      } else {
        await this.store.appendAudit("question_queue_full", "The bounded follow-up queue was full; the observed transcript remains in the event record.");
      }
      return;
    }
    if (this.activeInteraction) {
      await this.store.appendAudit("question_deferred", "A new question arrived during the short reviewed interaction; it was recorded but not answered concurrently.");
      return;
    }
    // Route recognized computations through a reviewed tool before asking a
    // generative model. This is an algorithm over arbitrary values, not a list
    // of canned questions or answers, and prevents a small model from guessing
    // arithmetic while leaving open-ended questions to the general tutor.
    const decision = this.policy.evaluate(event);
    if (decision.action === "start_decimal_bridge") {
      this.activeInteraction = decision.interaction;
      this.interactionLanguage = decision.language;
      await this.store.appendAudit("reviewed_tool_selected", "The decimal-comparison computation tool verified the values and selected its reviewed interactive bridge. Its instructional hypothesis remains ephemeral.");
      await this.showBoard(decimalComparisonScene("explain", decision.language, ++this.boardRevision, decision.interaction.values));
      for (const text of this.policy.explanation(decision.language, decision.interaction.values)) await this.speak(text, decision.language);
      this.activeInteraction.status = "awaiting_check";
      return;
    }

    let providerFailure: string | null = null;
    let modelAnswered = false;
    if (this.tutorProvider) {
      this.processingQuestion = true;
      await this.showBoard(tutorThinkingScene(++this.boardRevision));
      await this.speak("Let me think about that.", "en");
      await this.store.appendAudit("tutor_model_requested", `Sent a sanitized, untrusted transcript to ${this.tutorProvider.id}.`);
      try {
        const turn = await this.tutorProvider.answer({
          transcript: event.payload.text ?? "",
          lessonTitle: this.store.snapshot().lessonTitle,
          history: this.conversation,
          studentRef: event.studentRef,
          confidenceBand: event.provenance.confidenceBand,
          transcriptionSegments: event.payload.transcriptionSegments,
        });
        this.conversation.push(
          { role: "student", content: event.payload.text ?? "" },
          { role: "tutor", content: `${turn.answer}${turn.followUpQuestion ? ` ${turn.followUpQuestion}` : ""}` },
        );
        this.conversation = this.conversation.slice(-8);
        const turnLanguage = turn.language ?? "en";
        await this.showBoard(
          turn.boardPlan
            ? teacherBrainPlanScene(turn.boardPlan, turn.visual.title, turnLanguage, ++this.boardRevision)
            : genericTutorScene(turn, ++this.boardRevision),
        );
        await this.speak(turn.spokenAnswer, turnLanguage);
        if (turn.followUpQuestion) await this.speak(turn.followUpQuestion, turnLanguage);
        await this.store.appendAudit("tutor_model_answered", `${turn.provider} produced a validated ${turn.disposition} response using ${turn.model}.`);
        modelAnswered = true;
      } catch (error) {
        providerFailure = error instanceof Error ? error.message : "Unknown model error";
        await this.store.appendAudit("tutor_model_failed", `${this.tutorProvider.id} failed validation or availability checks.`);
      } finally {
        this.processingQuestion = false;
      }
      if (modelAnswered) {
        await this.answerNextQueuedQuestion();
        return;
      }
    }
    await this.store.appendAudit("general_question_unanswered", decision.reason);
    await this.speak(providerFailure
      ? "I heard the question, but the configured tutor service is unavailable right now. Please ask the teacher to check it and try again."
      : "I heard the question, but no general tutor model is configured. Please enable the local Ollama provider and try again.", "en");
    await this.answerNextQueuedQuestion();
  }

  private async handleResponse(event: HeadlessEvent) {
    const interaction = this.activeInteraction;
    if (!interaction || !["awaiting_check", "retrying"].includes(interaction.status)) {
      await this.store.appendAudit("unmatched_response", "A response was observed without an active comprehension check.");
      return;
    }
    interaction.evidenceEventIds.push(event.id);
    interaction.attempts += 1;
    const result = this.policy.parseCheckResponse(event.payload.text ?? "", interaction.values);
    if (result === "correct") {
      interaction.status = "complete";
      await this.showBoard(decimalComparisonScene("complete", this.interactionLanguage, ++this.boardRevision, interaction.values));
      await this.speak(this.policy.success(this.interactionLanguage, interaction.values), this.interactionLanguage);
      const evidence: ObservedEvidence = {
        id: crypto.randomUUID(),
        sessionId: event.sessionId,
        studentRef: interaction.studentRef,
        concept: interaction.concept,
        statement: `The student identified ${Math.max(...interaction.values).toFixed(2)} as greater after the place-value and Excalidraw visual representation; check independently later.`,
        sourceEventIds: [...interaction.evidenceEventIds],
        interactionId: interaction.id,
        observedAt: new Date().toISOString(),
        provenance: { source: event.source === "simulated" ? "simulated" : "live", policy: this.policy.id, version: this.policy.version },
      };
      await this.store.appendEvidence(evidence);
      await this.store.appendAudit("observed_result_saved", "Saved an observed result without saving the temporary misconception hypothesis as a diagnosis.");
      this.activeInteraction = null;
      return;
    }
    if (interaction.attempts < 2) {
      interaction.status = "retrying";
      await this.showBoard(decimalComparisonScene("hint", this.interactionLanguage, ++this.boardRevision, interaction.values));
      await this.speak(this.policy.hint(this.interactionLanguage, interaction.values), this.interactionLanguage);
      await this.speak(this.policy.checkPrompt(this.interactionLanguage, interaction.values), this.interactionLanguage);
      return;
    }
    interaction.status = "escalated";
    await this.speak(this.interactionLanguage === "es" ? "Hagamos una pausa y pidamos apoyo al docente." : "Let’s pause here and ask the teacher for support.", this.interactionLanguage);
    await this.store.appendAudit("interaction_escalated", `The response remained ${result}; no mastery or misconception claim was saved.`);
    this.activeInteraction = null;
  }

  private async speak(text: string, language: "en" | "es") {
    const command: TutorCommand = {
      id: crypto.randomUUID(),
      kind: "speak",
      text,
      language,
      createdAt: new Date().toISOString(),
      provenance: { policy: this.policy.id, version: this.policy.version },
    };
    await this.store.appendCommand(command);
    this.activeSpokenText = text;
    try {
      await this.output.deliver(command);
    } finally {
      this.activeSpokenText = null;
      this.recentSpokenTexts.push({ text, completedAt: Date.now() });
      this.recentSpokenTexts = this.recentSpokenTexts.filter((item) => Date.now() - item.completedAt < 15_000).slice(-6);
    }
  }

  private async answerNextQueuedQuestion() {
    const next = this.deferredQuestions.shift();
    if (next) await this.handleQuestion(next);
  }

  private isTutorAudioEcho(transcript: string) {
    const tokens = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const heard = tokens(transcript);
    if (heard.size < 4) return false;
    const candidates = [
      ...(this.activeSpokenText ? [this.activeSpokenText] : []),
      ...this.recentSpokenTexts.filter((item) => Date.now() - item.completedAt < 15_000).map((item) => item.text),
    ];
    return candidates.some((candidate) => {
      const spoken = tokens(candidate);
      const intersection = [...heard].filter((token) => spoken.has(token)).length;
      return intersection / Math.max(heard.size, spoken.size) >= 0.78;
    });
  }

  private async showBoard(sceneCandidate: unknown) {
    const scene = this.board.render(sceneCandidate);
    const command: TutorCommand = {
      id: crypto.randomUUID(),
      kind: "hardware_visual",
      toolId: "excalidraw.renderScene",
      params: { scene },
      language: scene.language,
      createdAt: new Date().toISOString(),
      provenance: { policy: this.policy.id, version: this.policy.version },
    };
    await this.store.appendCommand(command);
    await this.output.deliver(command);
  }

  /** Bounded integration point for a future LLM diagram planner. */
  async renderAgentDrawing(sceneCandidate: unknown) {
    await this.showBoard(sceneCandidate);
    await this.store.appendAudit("agent_board_scene_rendered", "Rendered a schema-validated public Excalidraw scene through the allow-listed board tool.");
  }

  async pause(reason = "Operator requested pause.") {
    if (this.status !== "running") return;
    this.status = "paused";
    await Promise.all(this.sensors.map((sensor) => sensor.pause()));
    await this.output.cancel();
    this.board.setStatus("paused");
    await this.store.update((record) => { record.status = "paused"; });
    await this.store.appendAudit("runtime_paused", `${reason} Owned camera/microphone processes were stopped.`);
  }

  async resume() {
    if (this.status !== "paused") return;
    await Promise.all(this.sensors.map((sensor) => sensor.resume()));
    this.board.setStatus(this.activeInteraction ? "active" : "idle");
    this.status = "running";
    await this.store.update((record) => { record.status = "running"; });
    await this.store.appendAudit("runtime_resumed", "Headless sensing resumed.");
  }

  async stop(reason = "Operator requested stop.") {
    if (this.status === "stopped") return;
    this.status = "stopped";
    this.controller.abort();
    await Promise.all(this.sensors.map((sensor) => sensor.stop()));
    await this.output.cancel();
    await this.output.close();
    this.board.setStatus("closed");
    await this.store.update((record) => { record.status = "stopped"; record.endedAt = new Date().toISOString(); });
    await this.store.appendAudit("runtime_stopped", `${reason} All owned sensor/output processes were terminated.`);
  }

  health(): RuntimeHealth {
    const record = this.store.snapshot();
    return {
      service: "classroom-compass-headless",
      status: this.status,
      sessionId: record.sessionId,
      mode: record.mode,
      sensors: this.sensors.map((sensor) => ({ id: sensor.id, status: sensor.status })),
      activeInteraction: this.activeInteraction ? structuredClone(this.activeInteraction) : null,
      rawMediaRetainedBytes: 0,
      lastEventAt: record.events.at(-1)?.occurredAt,
    };
  }

  snapshot() { return this.store.snapshot(); }
  publicBoardState(): ExcalidrawScene { return this.board.snapshot(); }
  async deleteSession() { await this.stop("Session deleted."); await this.store.delete(); }
}
