type WordToken = { raw: string; normalized: string };

function words(text: string): WordToken[] {
  return [...text.matchAll(/-?(?:\d+\.\d+|\.\d+)|[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu)].map((match) => ({
    raw: match[0],
    normalized: match[0].toLocaleLowerCase(),
  }));
}

/**
 * Remove complete, recently spoken tutor phrases from a rolling microphone
 * transcript while preserving any student words that followed the prompt.
 */
export function stripKnownTutorSpeech(transcript: string, tutorPhrases: string[]) {
  const remaining = words(transcript);
  let removedWordCount = 0;
  const fullCandidates = tutorPhrases
    .map(words)
    .filter((candidate) => candidate.length >= 3)
    .sort((left, right) => right.length - left.length);

  const removeCandidate = (candidate: WordToken[]) => {
    let removed = false;
    for (let index = remaining.length - candidate.length; index >= 0; index -= 1) {
      const matches = candidate.every((token, offset) => token.normalized === remaining[index + offset]?.normalized);
      if (!matches) continue;
      remaining.splice(index, candidate.length);
      removedWordCount += candidate.length;
      removed = true;
    }
    return removed;
  };

  for (const candidate of fullCandidates) {
    if (removeCandidate(candidate)) continue;
    // A rolling Whisper window can begin or end in the middle of loudspeaker
    // output. Remove only sufficiently long boundary fragments, never an
    // arbitrary middle fragment of a tutor phrase.
    const minimumFragment = Math.max(3, Math.ceil(candidate.length * 0.35));
    for (let size = candidate.length - 1; size >= minimumFragment; size -= 1) {
      const prefix = candidate.slice(0, size);
      const suffix = candidate.slice(-size);
      if (removeCandidate(prefix) || removeCandidate(suffix)) break;
    }
  }

  return {
    text: removedWordCount === 0 ? transcript.trim() : remaining.map((token) => token.raw).join(" ").trim(),
    removedWordCount,
    remainingWordCount: remaining.length,
  };
}

/** Similarity for recognizing a repeated rolling-window transcript. */
export function transcriptSimilarity(left: string, right: string) {
  const leftWords = words(left).map((word) => word.normalized);
  const rightWords = words(right).map((word) => word.normalized);
  if (leftWords.length === 0 || rightWords.length === 0) return 0;
  if (leftWords.join(" ") === rightWords.join(" ")) return 1;

  const counts = new Map<string, number>();
  for (const word of leftWords) counts.set(word, (counts.get(word) ?? 0) + 1);
  let intersection = 0;
  for (const word of rightWords) {
    const available = counts.get(word) ?? 0;
    if (available > 0) {
      intersection += 1;
      counts.set(word, available - 1);
    }
  }
  return intersection / Math.max(leftWords.length, rightWords.length);
}

const acousticAnnotation = /(?:\[|\()\s*(?:door|music|noise|silence|multiple voices?|blank audio|laughter|inaudible)[^\])]*(?:\]|\))/i;
const tutorPromptEcho = /\b(?:go ahead(?: with your question)?|ahead with your question|te escucho|adelante con tu pregunta|please (?:state|restate) your question|did not hear (?:a|your) question|did not hear a thing|heard the door open|do you have a question|should we continue|cannot accurately determine)\b/i;
const questionOpening = /^(?:what|why|how|when|where|which|who|can|could|would|will|do|does|did|is|are|was|were|explain|show|tell|help|qué|que|por qué|por que|cómo|como|cuándo|cuando|dónde|donde|cuál|cual|quién|quien|puede|puedes|explica|explícame|explicame|muéstrame|muestrame|ayúdame|ayudame)\b/i;
const learningStatement = /\b(?:i (?:do not|don't) understand|i am confused|i'm confused|no entiendo|tengo una pregunta|necesito ayuda)\b/i;
const classroomRequest = /\b(?:i (?:have|need) to (?:use|go to) (?:the )?(?:bathroom|restroom)|may i (?:use|go to) (?:the )?(?:bathroom|restroom)|necesito ir al baño|puedo ir al baño)\b/i;

/**
 * Keep a called-on listening window open across acoustic captions, garbled IDs,
 * and recognizable loudspeaker echoes. This is only turn validation; it does
 * not infer ability, identity, accent, or emotion.
 */
export function screenCalledOnUtterance(text: string) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const tokens = words(trimmed);
  if (!trimmed || acousticAnnotation.test(trimmed)) {
    return { usable: false, reason: "acoustic_annotation" as const };
  }
  if (tutorPromptEcho.test(trimmed)) {
    return { usable: false, reason: "tutor_prompt_echo" as const };
  }
  const digitHeavy = tokens.length > 0
    && tokens.filter((token) => /\d/.test(token.normalized)).length / tokens.length >= 0.4;
  if (digitHeavy) return { usable: false, reason: "garbled_identifier" as const };
  if (tokens.length < 2) return { usable: false, reason: "too_short" as const };
  if (
    trimmed.endsWith("?")
    || questionOpening.test(trimmed)
    || learningStatement.test(trimmed)
    || classroomRequest.test(trimmed)
  ) {
    return { usable: true, reason: "question_candidate" as const };
  }
  return { usable: false, reason: "incomplete_fragment" as const };
}
