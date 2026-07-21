import type { ClassroomOutputAdapter, HeadlessEvent, InteractionState, ObservedEvidence, RuntimeHealth, SensorAdapter, TutorCommand } from "./types";
import { DecimalTutorPolicy } from "../policies/decimal-tutor-policy";
import { ArithmeticTutorPolicy } from "../policies/arithmetic-tutor-policy";
import { LocalEventStore } from "../storage/local-event-store";
import type { ComprehensionCheck, TutorAnswerProvider, TutorAssessment, TutorHistoryItem, TutorTurn } from "../reasoning/tutor-provider";
import { coachingFeedbackScene, decimalComparisonScene, ExcalidrawBoardController, genericTutorScene, teacherBrainPlanScene, tutorThinkingScene, type ExcalidrawScene } from "../whiteboard/excalidraw-tool";
import { stripKnownTutorSpeech, transcriptSimilarity } from "./turn-filter";

type GeneralCheckState = {
  originalQuestion: string;
  turn: TutorTurn;
  check: ComprehensionCheck;
  attempts: number;
};

type CalledOnState = {
  seat: string;
  studentRef: string;
  expiresAt: number;
  fragments: string[];
};

const checkNumberWords: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

function normalizeCheckText(value: string) {
  return value.toLocaleLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (word) => checkNumberWords[word])
    .match(/[+\-]?\d+(?:\.\d+)?|[\p{L}]+/gu)?.join(" ") ?? "";
}

function meaningfulWords(value: string) {
  const ignored = new Set(["a", "an", "and", "are", "as", "at", "be", "because", "by", "for", "from", "in", "is", "it", "of", "on", "or", "the", "to", "with"]);
  return normalizeCheckText(value).split(" ").filter((word) => word.length > 1 && !ignored.has(word));
}

function transcriptWords(value: string) {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** Avoid closing a called-on turn on a preamble or partial rolling transcript. */
function looksLikeCompleteQuestion(value: string) {
  const words = transcriptWords(value);
  if (words.length < 3) return false;
  if (value.includes("?")) return true;
  const questionWords = new Set([
    "can", "could", "did", "do", "does", "how", "is", "may", "should", "was", "were",
    "what", "when", "where", "which", "who", "why", "will", "would", "cómo", "cuál", "cuándo",
    "dónde", "porqué", "puede", "puedes", "qué", "quién",
  ]);
  const cueIndex = words.findIndex((word) => questionWords.has(word));
  if (cueIndex >= 0 && cueIndex <= 2 && words.length - cueIndex >= 4) return true;
  return /^(?:please\s+)?(?:describe|explain|help me|i don['’]t understand|show me|tell me|ayúdame|dime|explica|muéstrame|no entiendo)\b/i.test(value.trim()) && words.length >= 4;
}

function localAssessment(check: ComprehensionCheck, response: string): TutorAssessment | null {
  const normalizedResponse = normalizeCheckText(response);
  const accepted = check.acceptableAnswers.find((answer) => {
    const normalizedAnswer = normalizeCheckText(answer);
    return normalizedAnswer && (` ${normalizedResponse} `).includes(` ${normalizedAnswer} `);
  });
  if (accepted) {
    return {
      status: "correct",
      feedback: "Yes—your answer connects to the key idea.",
      coachingExplanation: check.correction,
      retryPrompt: "",
      identifiedIdeas: [accepted],
      provider: "local-comprehension-check@1.0.0",
      model: "deterministic-match",
    };
  }

  const expectedNumbers = new Set(check.acceptableAnswers.flatMap((answer) => normalizeCheckText(answer).match(/[+\-]?\d+(?:\.\d+)?/g) ?? []));
  const responseNumbers = normalizedResponse.match(/[+\-]?\d+(?:\.\d+)?/g) ?? [];
  if (expectedNumbers.size > 0 && responseNumbers.length > 0 && responseNumbers.every((number) => !expectedNumbers.has(number))) {
    return {
      status: "off_track",
      feedback: "You chose a clear result, but it does not match the pattern yet.",
      coachingExplanation: check.hint,
      retryPrompt: check.prompt,
      identifiedIdeas: [],
      provider: "local-comprehension-check@1.0.0",
      model: "deterministic-match",
    };
  }
  return null;
}

function cautiousFallbackAssessment(check: ComprehensionCheck, response: string): TutorAssessment {
  const responseWords = new Set(meaningfulWords(response));
  const identifiedIdeas = check.expectedIdeas.filter((idea) => {
    const ideaWords = meaningfulWords(idea);
    return ideaWords.length > 0 && ideaWords.filter((word) => responseWords.has(word)).length / ideaWords.length >= 0.35;
  });
  const partlyCorrect = identifiedIdeas.length > 0;
  return {
    status: partlyCorrect ? "partly_correct" : "unclear",
    feedback: partlyCorrect ? "You included a useful piece of the idea." : "I heard your response, but I need one more detail to connect it to the visual.",
    coachingExplanation: check.hint,
    retryPrompt: check.prompt,
    identifiedIdeas,
    provider: "local-comprehension-check@1.0.0",
    model: "cautious-keyword-fallback",
  };
}

export class TutorRuntime {
  private controller = new AbortController();
  private activeInteraction: InteractionState | null = null;
  private interactionLanguage: "en" | "es" = "en";
  private status: RuntimeHealth["status"] = "starting";
  private boardRevision = 0;
  private processingQuestion = false;
  private conversation: TutorHistoryItem[] = [];
  private deferredQuestions: HeadlessEvent[] = [];
  private activeSpokenTexts = new Map<string, string>();
  private speechEpoch = 0;
  private activeDeliveryInterruptible = false;
  private recentSpokenTexts: Array<{ text: string; completedAt: number }> = [];
  private recentStudentTexts: Array<{ text: string; acceptedAt: number }> = [];
  private readonly arithmeticPolicy = new ArithmeticTutorPolicy();
  private activeGeneralCheck: GeneralCheckState | null = null;
  private assessingResponse = false;
  private calledOn: CalledOnState | null = null;
  private activeStudentRef: string | undefined;
  private readonly requireHandRaise = process.env.CC_REQUIRE_HAND_RAISE === "1";
  private readonly calledOnWindowMs = Number(process.env.CC_CALLED_ON_WINDOW_MS ?? 30_000);
  private readonly stopOnSensorFailure = process.env.CC_STOP_ON_SENSOR_FAILURE === "1";

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
    await this.beginLessonIfSupported();
    await Promise.all(this.sensors.map((sensor) => sensor.start((event) => this.handleEvent(event), this.controller.signal)));
    if (options.stopWhenSensorsComplete) await this.stop("Sensor fixture completed.");
  }

  async handleEvent(event: HeadlessEvent) {
    if (this.status !== "running") return;
    const transcriptEvent = event.kind === "question_transcribed" || event.kind === "response_transcribed";
    if (transcriptEvent) {
      if (this.calledOn && Date.now() > this.calledOn.expiresAt) {
        this.calledOn = null;
        await this.store.appendAudit("called_on_window_expired", "The listening window ended without storing or answering ambient speech.");
      }
      // In hand-raise mode, model latency and amplified tutor speech are not
      // additional student turns. A reviewed interaction/check explicitly
      // opens response input; otherwise a new hand raise is required.
      const continuingTurn = Boolean(
        this.activeInteraction
        || this.activeGeneralCheck
        || (!this.requireHandRaise && this.processingQuestion),
      );
      if (this.requireHandRaise && !continuingTurn && !this.calledOn) {
        await this.store.appendAudit("ambient_transcript_ignored", "A transcript outside a confirmed hand-raise listening window was discarded and not stored.");
        process.stderr.write("Ignored ambient speech; waiting for a confirmed raised hand.\n");
        return;
      }
      const studentRef = this.calledOn?.studentRef ?? (continuingTurn ? this.activeStudentRef : undefined);
      const seat = this.calledOn?.seat;
      if (studentRef) event = {
        ...event,
        studentRef,
        payload: { ...event.payload, ...(seat ? { seat } : {}) },
      };
      const preparedText = await this.prepareStudentText(event.payload.text ?? "");
      if (!preparedText) return;
      event = { ...event, payload: { ...event.payload, text: preparedText } };
      if (this.calledOn) {
        const completeQuestion = this.captureCalledOnQuestion(preparedText);
        if (!completeQuestion) {
          await this.store.appendAudit("called_on_fragment_waiting", "The microphone produced a partial turn, so the hand-raise gate stayed open for a complete question without storing the fragment as participation evidence.");
          return;
        }
        event = { ...event, payload: { ...event.payload, text: completeQuestion } };
        this.activeStudentRef = this.calledOn.studentRef;
        await this.store.appendAudit("called_on_turn_started", `The next usable microphone turn was associated with ${this.calledOn.seat} by classroom turn-taking, not by voice identification.`);
        process.stderr.write(`Question received for ${this.calledOn.seat}.\n`);
        this.calledOn = null;
      }
      this.recentStudentTexts.push({ text: event.payload.text ?? preparedText, acceptedAt: Date.now() });
      this.recentStudentTexts = this.recentStudentTexts.filter((item) => Date.now() - item.acceptedAt < 20_000).slice(-6);
    }
    await this.store.appendEvent(event);
    if (event.kind === "sensor_unavailable") {
      const detail = event.payload.detail ?? "A required classroom sensor became unavailable.";
      process.stderr.write(`\nCLASSROOM COMPASS SENSOR FAILURE: ${detail}\n\n`);
      await this.store.appendAudit("sensor_failure_reported", detail);
      if (this.stopOnSensorFailure) await this.stop("A required room sensor became unavailable.");
      return;
    }
    if (event.kind === "hand_raise") return this.handleHandRaise(event);
    if (event.kind === "question_transcribed") return this.handleQuestion(event);
    if (event.kind === "response_transcribed") {
      if (this.activeInteraction) return this.handleResponse(event);
      if (this.activeGeneralCheck) return this.handleGeneralCheckResponse(event);
      return this.handleQuestion({ ...event, kind: "question_transcribed" });
    }
  }

  private async handleHandRaise(event: HeadlessEvent) {
    if (this.calledOn && Date.now() <= this.calledOn.expiresAt) {
      await this.store.appendAudit("hand_raise_waiting_for_question", "Another possible raise was observed while the system was already waiting for the previously called-on seat.");
      return;
    }
    if (this.activeSpokenTexts.size > 0 && this.activeDeliveryInterruptible) {
      this.speechEpoch += 1;
      await this.output.cancel();
      await this.store.appendAudit("lesson_speech_interrupted", "Current lesson speech was stopped for a confirmed hand raise.");
    } else if (this.processingQuestion || this.activeInteraction || this.activeGeneralCheck || this.activeSpokenTexts.size > 0) {
      await this.store.appendAudit("hand_raise_observed_busy", "A hand raise was recorded while the tutor was already facilitating a turn; it did not interrupt the active interaction.");
      return;
    }
    const zone = event.payload.seat === "camera-left"
      ? "on the left side"
      : event.payload.seat === "camera-right"
        ? "on the right side"
        : "near the center";
    const seat = event.payload.seat ?? "camera-center";
    const calledOn = {
      seat,
      studentRef: event.studentRef ?? `seat:${seat}`,
      expiresAt: Date.now() + this.calledOnWindowMs,
      fragments: [],
    };
    this.calledOn = calledOn;
    const language = this.tutorProvider?.languageForStudent?.(calledOn.studentRef) ?? "en";
    process.stderr.write(`Listening window opened for ${seat} (${Math.round(this.calledOnWindowMs / 1_000)} seconds).\n`);
    await this.store.appendAudit("hand_raise_acknowledged", `A live hand-raise event ${zone} was acknowledged without identifying a person.`);
    await this.speak(
      language === "es"
        ? "Veo una mano levantada. Adelante con tu pregunta."
        : `I see a raised hand ${zone}. Go ahead with your question.`,
      language,
    );
    if (this.calledOn === calledOn) calledOn.expiresAt = Date.now() + this.calledOnWindowMs;
  }

  private async handleQuestion(event: HeadlessEvent) {
    if (this.activeGeneralCheck) return this.handleGeneralCheckResponse(event);
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

    const arithmeticTurn = this.arithmeticPolicy.evaluate(event);
    if (arithmeticTurn) {
      await this.store.appendAudit("reviewed_arithmetic_selected", "A reviewed arithmetic reasoning tool computed the result and supplied an age-appropriate representation before the general language model.");
      this.conversation.push(
        { role: "student", content: event.payload.text ?? "" },
        { role: "tutor", content: `${arithmeticTurn.answer}${arithmeticTurn.followUpQuestion ? ` ${arithmeticTurn.followUpQuestion}` : ""}` },
      );
      this.conversation = this.conversation.slice(-8);
      await this.showBoard(genericTutorScene(arithmeticTurn, ++this.boardRevision));
      await this.speak(arithmeticTurn.spokenAnswer, "en");
      const arithmeticCheck = this.activateGeneralCheck(event, arithmeticTurn);
      if (arithmeticCheck) await this.speak(arithmeticCheck.check.prompt, "en");
      return;
    }

    let providerFailure: string | null = null;
    let modelAnswered = false;
    if (this.tutorProvider) {
      this.processingQuestion = true;
      const studentLanguage = this.tutorProvider.languageForStudent?.(event.studentRef) ?? "en";
      await this.showBoard(tutorThinkingScene(++this.boardRevision, studentLanguage));
      await this.store.appendAudit("tutor_thinking", "The tutor kept the current turn open while preparing one explanation; no extra microphone turn was created.");
      await this.store.appendAudit("tutor_model_requested", `Sent a sanitized, untrusted transcript to ${this.tutorProvider.id}.`);
      try {
        const turn = await this.tutorProvider.answer({
          transcript: event.payload.text ?? "",
          lessonTitle: this.store.snapshot().lessonTitle,
          history: [...this.conversation],
          studentRef: event.studentRef,
          confidenceBand: event.provenance.confidenceBand,
          transcriptionSegments: event.payload.transcriptionSegments,
          gradeBand: process.env.CC_GRADE_BAND ?? "grades 4-8",
        }, this.controller.signal);
        this.conversation.push(
          { role: "student", content: event.payload.text ?? "" },
          { role: "tutor", content: `${turn.answer}${turn.followUpQuestion ? ` ${turn.followUpQuestion}` : ""}` },
        );
        this.conversation = this.conversation.slice(-8);
        if (turn.boardPlan) {
          await this.deliverTutorTurn(turn, false);
        } else {
          await this.showBoard(genericTutorScene(turn, ++this.boardRevision));
          await this.speak(turn.spokenAnswer, turn.language ?? "en");
          const generalCheck = this.activateGeneralCheck(event, turn);
          if (generalCheck) await this.speak(generalCheck.check.prompt, turn.language ?? "en");
        }
        await this.store.appendAudit("tutor_model_answered", `${turn.provider} produced a validated ${turn.disposition} response using ${turn.model}.`);
        modelAnswered = true;
        if (this.tutorProvider.resumeLesson) {
          try {
            const resumeGuidance = typeof turn.providerMetadata?.resumeGuidance === "string"
              ? turn.providerMetadata.resumeGuidance
              : undefined;
            const resumed = await this.tutorProvider.resumeLesson({
              lessonTitle: this.store.snapshot().lessonTitle,
              resumeGuidance,
            }, this.controller.signal);
            const completed = await this.deliverTutorTurn(resumed, true);
            await this.store.appendAudit(
              completed ? "lesson_resumed" : "lesson_resume_interrupted",
              completed
                ? "Teacher Brain returned to the interrupted lesson using its explicit resume guidance."
                : "The resumed lesson speech was stopped for another confirmed hand raise.",
            );
          } catch {
            await this.store.appendAudit("lesson_resume_failed", "The interruption answer completed, but the follow-on lesson turn was unavailable.");
          }
        }
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
        statement: `The student identified ${Math.max(...interaction.values).toFixed(2)} as greater after the place-value projected visual representation; check independently later.`,
        sourceEventIds: [...interaction.evidenceEventIds],
        interactionId: interaction.id,
        observedAt: new Date().toISOString(),
        provenance: { source: event.source === "simulated" ? "simulated" : "live", policy: this.policy.id, version: this.policy.version },
      };
      await this.store.appendEvidence(evidence);
      await this.store.appendAudit("observed_result_saved", "Saved an observed result without saving the temporary misconception hypothesis as a diagnosis.");
      this.activeInteraction = null;
      this.activeStudentRef = undefined;
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
    this.activeStudentRef = undefined;
  }

  private activateGeneralCheck(event: HeadlessEvent, turn: TutorTurn) {
    if (turn.disposition !== "answer" || !turn.followUpQuestion) {
      this.activeGeneralCheck = null;
      this.activeStudentRef = undefined;
      return null;
    }
    const check = turn.comprehensionCheck ?? {
      prompt: turn.followUpQuestion,
      expectedIdeas: [turn.visual.keyIdea || turn.answer.split(/(?<=[.!?])\s+/)[0] || turn.visual.title],
      acceptableAnswers: [],
      hint: turn.visual.example || "Use the visual steps and explain one connection in your own words.",
      correction: turn.answer,
    };
    this.activeGeneralCheck = {
      originalQuestion: event.payload.text ?? "",
      turn,
      check,
      attempts: 0,
    };
    return this.activeGeneralCheck;
  }

  private async handleGeneralCheckResponse(event: HeadlessEvent) {
    const state = this.activeGeneralCheck;
    if (!state) return;
    if (this.assessingResponse) {
      await this.store.appendAudit("comprehension_response_observed_busy", "A second response arrived while the first response was being checked; it remained in the event record and did not start another assessment.");
      return;
    }
    this.assessingResponse = true;
    state.attempts += 1;
    let assessment = localAssessment(state.check, event.payload.text ?? "");
    if (!assessment && this.tutorProvider?.assess) {
      try {
        assessment = await this.tutorProvider.assess({
          originalQuestion: state.originalQuestion,
          originalAnswer: state.turn.answer,
          check: state.check,
          studentResponse: event.payload.text ?? "",
          gradeBand: process.env.CC_GRADE_BAND ?? "grades 4-8",
        });
      } catch {
        await this.store.appendAudit("comprehension_assessment_fallback", "The local model could not assess this response, so the tutor used a cautious non-grading fallback.");
      }
    }
    assessment ??= cautiousFallbackAssessment(state.check, event.payload.text ?? "");
    await this.store.appendAudit("comprehension_response_assessed", `The response was treated as ${assessment.status.replace("_", " ")} evidence for this short interaction; no grade or permanent student label was created.`);

    if (assessment.status === "correct") {
      await this.showBoard(coachingFeedbackScene(assessment, state.check, ++this.boardRevision));
      await this.speak(assessment.feedback, "en");
      this.conversation.push({ role: "student", content: event.payload.text ?? "" }, { role: "tutor", content: assessment.feedback });
      this.conversation = this.conversation.slice(-8);
      this.activeGeneralCheck = null;
      this.activeStudentRef = undefined;
      this.assessingResponse = false;
      await this.store.appendAudit("comprehension_check_completed", "The student response matched the expected idea for this moment; the tutor made no lasting mastery claim.");
      return;
    }

    const finalCorrection = state.attempts >= 2;
    await this.showBoard(coachingFeedbackScene(assessment, state.check, ++this.boardRevision, finalCorrection));
    if (finalCorrection) {
      const correction = `Let’s rebuild that idea together. ${state.check.correction}`;
      await this.speak(correction, "en");
      this.conversation.push({ role: "student", content: event.payload.text ?? "" }, { role: "tutor", content: correction });
      this.conversation = this.conversation.slice(-8);
      this.activeGeneralCheck = null;
      this.activeStudentRef = undefined;
      await this.store.appendAudit("comprehension_check_closed_with_correction", "After two attempts, the tutor supplied a supportive correction and returned control without assigning a grade or label.");
    } else {
      await this.speak(assessment.feedback, "en");
      await this.speak(assessment.coachingExplanation || state.check.hint, "en");
      await this.speak(assessment.retryPrompt || state.check.prompt, "en");
      await this.store.appendAudit("comprehension_retry_prompted", "The tutor acknowledged usable thinking, offered one clue, and invited one retry.");
    }
    this.assessingResponse = false;
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
    this.activeSpokenTexts.set(command.id, text);
    try {
      await this.output.deliver(command);
    } finally {
      this.activeSpokenTexts.delete(command.id);
      this.recentSpokenTexts.push({ text, completedAt: Date.now() });
      this.recentSpokenTexts = this.recentSpokenTexts.filter((item) => Date.now() - item.completedAt < 15_000).slice(-6);
    }
  }

  private async beginLessonIfSupported() {
    if (!this.tutorProvider?.beginLesson) return;
    this.processingQuestion = true;
    try {
      const turn = await this.tutorProvider.beginLesson(
        { lessonTitle: this.store.snapshot().lessonTitle },
        this.controller.signal,
      );
      const completed = await this.deliverTutorTurn(turn, true);
      await this.store.appendAudit(
        completed ? "lesson_started" : "lesson_start_interrupted",
        completed
          ? "Teacher Brain produced the opening lesson turn before listening for interruptions."
          : "The opening lesson speech was stopped for a confirmed hand raise.",
      );
    } catch {
      await this.store.appendAudit("lesson_start_failed", "Teacher Brain could not produce the opening lesson turn; sensing remains available.");
    } finally {
      this.processingQuestion = false;
    }
    await this.answerNextQueuedQuestion();
  }

  private async deliverTutorTurn(
    turn: Awaited<ReturnType<TutorAnswerProvider["answer"]>>,
    interruptible: boolean,
  ) {
    const deliveryEpoch = this.speechEpoch;
    this.activeDeliveryInterruptible = interruptible;
    const turnLanguage = turn.language ?? "en";
    try {
      await this.showBoard(
        turn.boardPlan
          ? teacherBrainPlanScene(turn.boardPlan, turn.visual.title, turnLanguage, ++this.boardRevision)
          : genericTutorScene(turn, ++this.boardRevision),
      );
      const spokenSegments = turn.spokenSegments?.length
        ? turn.spokenSegments
        : [{ text: turn.spokenAnswer, language: turnLanguage }];
      for (const segment of spokenSegments) {
        if (deliveryEpoch !== this.speechEpoch) return false;
        await this.speak(segment.text, segment.language);
      }
      if (turn.followUpQuestion && deliveryEpoch === this.speechEpoch) {
        await this.speak(turn.followUpQuestion, turnLanguage);
      }
      return deliveryEpoch === this.speechEpoch;
    } finally {
      this.activeDeliveryInterruptible = false;
    }
  }

  private async answerNextQueuedQuestion() {
    const next = this.deferredQuestions.shift();
    if (next) await this.handleQuestion(next);
  }

  private async prepareStudentText(transcript: string) {
    const now = Date.now();
    this.recentSpokenTexts = this.recentSpokenTexts.filter((item) => now - item.completedAt < 20_000).slice(-8);
    const tutorPhrases = [
      ...this.activeSpokenTexts.values(),
      ...this.recentSpokenTexts.map((item) => item.text),
    ];
    const filtered = stripKnownTutorSpeech(transcript, tutorPhrases);
    if (!filtered.text || (filtered.removedWordCount > 0 && filtered.remainingWordCount <= 2)) {
      await this.store.appendAudit("tutor_audio_echo_ignored", "Recent tutor speech was removed from a microphone transcript and no distinct student question remained.");
      return null;
    }

    const duplicate = !this.activeInteraction && this.recentStudentTexts.some((item) =>
      now - item.acceptedAt < 15_000 && transcriptSimilarity(filtered.text, item.text) >= 0.9,
    );
    if (duplicate) {
      await this.store.appendAudit("duplicate_transcript_ignored", "A repeated rolling Whisper window matched the current student turn and was not queued as another question.");
      return null;
    }
    return filtered.text;
  }

  private captureCalledOnQuestion(fragment: string) {
    const calledOn = this.calledOn;
    if (!calledOn) return fragment;
    if (looksLikeCompleteQuestion(fragment)) return fragment;

    const prior = calledOn.fragments.at(-1);
    if (!prior || transcriptSimilarity(prior, fragment) < 0.8) calledOn.fragments.push(fragment);
    else calledOn.fragments[calledOn.fragments.length - 1] = fragment;
    calledOn.fragments = calledOn.fragments.slice(-3);
    const combined = calledOn.fragments.join(" ").replace(/\s+/g, " ").trim();
    return looksLikeCompleteQuestion(combined) ? combined : null;
  }

  private async showBoard(sceneCandidate: unknown) {
    const scene = this.board.render(sceneCandidate);
    const command: TutorCommand = {
      id: crypto.randomUUID(),
      kind: "hardware_visual",
      toolId: "visual-stage.renderScene",
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
    await this.store.appendAudit("agent_board_scene_rendered", "Rendered a schema-validated public visual scene through the allow-listed board tool.");
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
    this.calledOn = null;
    this.activeStudentRef = undefined;
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
