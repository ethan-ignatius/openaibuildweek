import { sanitizeTranscript } from "../../domain/schemas";
import type { HeadlessEvent, InteractionState } from "../core/types";

export type PolicyDecision =
  | { action: "ignore"; reason: string }
  | { action: "start_decimal_bridge"; interaction: InteractionState; language: "en" | "es" };

const wordDigits: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

function normalizeSpokenDecimals(text: string) {
  return text
    .replace(
      /\b(?:(?:zero|oh)\s+)?point\s+(zero|one|two|three|four|five|six|seven|eight|nine)(?:\s+(zero|one|two|three|four|five|six|seven|eight|nine))?\b/g,
      (_, first: string, second?: string) => `0.${wordDigits[first]}${second ? wordDigits[second] : ""}`,
    )
    .replace(/\bcero punto (?:treinta y cinco|tres cinco)\b/g, "0.35")
    .replace(/\bcero punto (?:cuatro cero|cuatro)\b/g, "0.40");
}

function extractDecimalValues(text: string): number[] {
  const matches = text.match(/(?<!\d)(?:0?\.\d{1,2}|1(?:\.0{1,2})?)(?!\d)/g) ?? [];
  return matches.map(Number).filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}

function sameValue(left: number, right: number) {
  return Math.abs(left - right) < 0.000_001;
}

function decimal(value: number) {
  return value.toFixed(2);
}

function hundredths(value: number) {
  return Math.round(value * 100);
}

export class DecimalTutorPolicy {
  readonly id = "reviewed-decimal-tutor";
  readonly version = "1.1.0";

  evaluate(event: HeadlessEvent): PolicyDecision {
    if (event.kind !== "question_transcribed") return { action: "ignore", reason: "Not a student question." };
    const text = normalizeSpokenDecimals(sanitizeTranscript(event.payload.text ?? "").toLowerCase());
    const parsed = extractDecimalValues(text);
    const hasMagnitudeLanguage = /bigger|greater|larger|smaller|less|more|compare|mayor|menor|más grande/.test(text);
    if (parsed.length < 2 || !hasMagnitudeLanguage) {
      return { action: "ignore", reason: "Outside the reviewed decimal-comparison lesson policy." };
    }
    const values: [number, number] = [parsed[0], parsed[1]];
    if (sameValue(values[0], values[1])) {
      return { action: "ignore", reason: "The current reviewed bridge expects two different decimal values." };
    }
    const language = /por qué|mayor|menor|cero punto/.test(text) ? "es" : "en";
    return {
      action: "start_decimal_bridge",
      language,
      interaction: {
        id: crypto.randomUUID(),
        studentRef: event.studentRef,
        concept: "decimal comparison",
        status: "explaining",
        evidenceEventIds: [event.id],
        attempts: 0,
        startedAt: new Date().toISOString(),
        hypothesis: "The student may be comparing decimal notation without aligning place values; this is an ephemeral instructional hypothesis, not a saved diagnosis.",
        values,
      },
    };
  }

  parseCheckResponse(text: string, values: [number, number]) {
    const normalized = normalizeSpokenDecimals(sanitizeTranscript(text).toLowerCase());
    const mentioned = extractDecimalValues(normalized);
    if (mentioned.length === 0) return "unclear" as const;
    const greater = Math.max(...values);
    const lesser = Math.min(...values);
    const first = mentioned[0];
    const describesLesser = /\b(?:less|smaller|menor)\b/.test(normalized);
    const describesGreater = /\b(?:greater|bigger|larger|more|mayor)\b/.test(normalized);
    if (describesLesser && sameValue(first, lesser)) return "correct" as const;
    if (describesGreater && sameValue(first, greater)) return "correct" as const;
    if (sameValue(first, greater)) return "correct" as const;
    if (values.some((value) => sameValue(value, first))) return "incorrect" as const;
    return "unclear" as const;
  }

  explanation(language: "en" | "es", values: [number, number]) {
    const [left, right] = values;
    const greater = Math.max(left, right);
    const lesser = Math.min(left, right);
    return language === "es"
      ? [
          `Alineemos los valores por posición. ${decimal(left)} tiene ${hundredths(left)} centésimos y ${decimal(right)} tiene ${hundredths(right)} centésimos.`,
          `${hundredths(greater)} centésimos son más que ${hundredths(lesser)} centésimos. Por eso ${decimal(greater)} es mayor.`,
          `Comprobación rápida: ¿cuál es mayor, ${decimal(left)} o ${decimal(right)}?`,
        ]
      : [
          `Let’s align the values by place. ${decimal(left)} has ${hundredths(left)} hundredths and ${decimal(right)} has ${hundredths(right)} hundredths.`,
          `${hundredths(greater)} hundredths is more than ${hundredths(lesser)} hundredths. So ${decimal(greater)} is greater.`,
          `Quick check: which is greater, ${decimal(left)} or ${decimal(right)}?`,
        ];
  }

  hint(language: "en" | "es", values: [number, number]) {
    const [left, right] = values;
    const leftTenths = Math.floor(left * 10);
    const rightTenths = Math.floor(right * 10);
    if (leftTenths !== rightTenths) {
      return language === "es"
        ? `Pista: compara primero los décimos. ${decimal(left)} tiene ${leftTenths} y ${decimal(right)} tiene ${rightTenths}. Inténtalo otra vez.`
        : `Hint: compare the tenths first. ${decimal(left)} has ${leftTenths} and ${decimal(right)} has ${rightTenths}. Try once more.`;
    }
    return language === "es"
      ? `Pista: los décimos son iguales, así que compara los centésimos: ${hundredths(left)} y ${hundredths(right)}. Inténtalo otra vez.`
      : `Hint: the tenths are equal, so compare the hundredths: ${hundredths(left)} and ${hundredths(right)}. Try once more.`;
  }

  checkPrompt(language: "en" | "es", values: [number, number]) {
    return language === "es"
      ? `¿Cuál es mayor, ${decimal(values[0])} o ${decimal(values[1])}?`
      : `Which is greater, ${decimal(values[0])} or ${decimal(values[1])}?`;
  }

  success(language: "en" | "es", values: [number, number]) {
    const greater = Math.max(...values);
    const lesser = Math.min(...values);
    const difference = Math.round((greater - lesser) * 100);
    return language === "es"
      ? `Sí. ${decimal(greater)} es ${difference} centésimos mayor que ${decimal(lesser)}. Lo comprobaremos de manera independiente más tarde.`
      : `Yes. ${decimal(greater)} is ${difference} hundredths greater than ${decimal(lesser)}. We’ll check it independently again later.`;
  }
}
