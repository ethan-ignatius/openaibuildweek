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
