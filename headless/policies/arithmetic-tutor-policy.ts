import { sanitizeTranscript } from "../../domain/schemas";
import type { HeadlessEvent } from "../core/types";
import type { TutorTurn } from "../reasoning/tutor-provider";

const smallNumbers: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const tens: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const numberPhrase = /\b(?:(negative|minus)\s+)?(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s]+(one|two|three|four|five|six|seven|eight|nine))?\b/g;

function normalizeNumberWords(value: string) {
  return value.replace(numberPhrase, (_match, sign: string | undefined, head: string, tail: string | undefined) => {
    const magnitude = (smallNumbers[head] ?? tens[head] ?? 0) + (tail ? smallNumbers[tail] : 0);
    return String(sign ? -magnitude : magnitude);
  });
}

function displayNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function negativeRuleTurn(): TutorTurn {
  return {
    disposition: "answer",
    answer: "A negative multiplier reverses a number’s direction. Follow the pattern: 2 × −3 = −6, 1 × −3 = −3, and 0 × −3 = 0. Each time the first number drops by 1, the product rises by 3, so the next line must be −1 × −3 = +3. This is why a negative times a negative is positive: continuing the multiplication pattern requires it.",
    spokenAnswer: "A negative multiplier reverses a number’s direction. Watch a pattern: two times negative three is negative six, one times negative three is negative three, and zero times negative three is zero. Each time the first number drops by one, the answer rises by three. So the next line has to be negative one times negative three equals positive three. That is why two negative factors make a positive product: it keeps multiplication patterns consistent.",
    visual: {
      title: "Why two negatives make a positive",
      kind: "sequence",
      keyIdea: "The products must keep increasing by 3 as the first factor drops by 1.",
      example: "2 × −3 = −6  →  1 × −3 = −3  →  0 × −3 = 0  →  −1 × −3 = +3",
      nodes: [
        { label: "Start the pattern", detail: "2 × −3 = −6", symbol: "number" },
        { label: "Move one step", detail: "1 × −3 = −3", symbol: "number" },
        { label: "Reach zero", detail: "0 × −3 = 0", symbol: "number" },
        { label: "Keep it going", detail: "−1 × −3 = +3", symbol: "plus" },
      ],
      connections: [
        { from: 0, to: 1, label: "+3" },
        { from: 1, to: 2, label: "+3" },
        { from: 2, to: 3, label: "+3" },
      ],
    },
    followUpQuestion: "Using the same pattern, what should −1 × −4 equal?",
    comprehensionCheck: {
      prompt: "Using the same pattern, what should −1 × −4 equal?",
      expectedIdeas: ["The product rises by 4 after 0 × −4 = 0.", "−1 × −4 equals positive 4."],
      acceptableAnswers: ["4", "+4", "positive 4", "negative one times negative four is four"],
      hint: "Write 1 × −4, then 0 × −4. Notice how much the product changes each step.",
      correction: "The products go −4, 0, +4 as the first factor goes 1, 0, −1. Therefore −1 × −4 = +4.",
    },
    provider: "reviewed-arithmetic-tool@1.0.0",
    model: "deterministic-pattern",
  };
}

type Operation = "add" | "subtract" | "multiply" | "divide";

function operationTurn(left: number, right: number, operation: Operation): TutorTurn | null {
  if (operation === "divide" && right === 0) {
    return {
      disposition: "clarify",
      answer: "Division asks how many equal groups can be made. A group cannot have size zero, so division by zero does not produce a number.",
      spokenAnswer: "Division asks how many equal groups can be made. If the group size is zero, no number of those groups can build the starting amount. That is why division by zero is undefined instead of having a numerical answer.",
      visual: { title: "Why division by zero is undefined", kind: "groups", keyIdea: "Groups of size zero can never build a nonzero amount.", example: `${displayNumber(left)} ÷ 0 has no numerical result`, nodes: [], connections: [] },
      followUpQuestion: "Why can groups of zero never add up to the starting number?",
      comprehensionCheck: {
        prompt: "Why can groups of zero never add up to the starting number?",
        expectedIdeas: ["Adding any number of zero-sized groups still gives zero."],
        acceptableAnswers: ["zero plus zero always stays zero", "groups of zero cannot make a nonzero number"],
        hint: "Imagine adding 0 + 0 + 0. What total do you keep getting?",
        correction: "Any number of zero-sized groups totals zero, so they cannot build a nonzero starting amount.",
      },
      provider: "reviewed-arithmetic-tool@1.0.0",
      model: "deterministic-arithmetic",
    };
  }

  const result = operation === "add" ? left + right : operation === "subtract" ? left - right : operation === "multiply" ? left * right : left / right;
  if (!Number.isFinite(result)) return null;
  const leftText = displayNumber(left);
  const rightText = displayNumber(right);
  const resultText = displayNumber(result);
  const symbol = operation === "add" ? "+" : operation === "subtract" ? "−" : operation === "multiply" ? "×" : "÷";
  const equation = `${leftText} ${symbol} ${rightText} = ${resultText}`;

  if (operation === "multiply" && Number.isInteger(left) && Number.isInteger(right) && left >= 0 && right >= 0) {
    const repeated = left <= 8 ? Array.from({ length: left }, () => rightText).join(" + ") : `${leftText} equal groups of ${rightText}`;
    return {
      disposition: "answer",
      answer: `${leftText} × ${rightText} means ${leftText} equal groups of ${rightText}. Those groups can be combined as ${repeated}, which totals ${resultText}. So ${equation}.`,
      spokenAnswer: `${leftText} times ${rightText} means ${leftText} equal groups with ${rightText} in each group. Combining those equal groups gives ${resultText}. So ${leftText} times ${rightText} equals ${resultText}.`,
      visual: {
        title: `${leftText} groups of ${rightText}`,
        kind: "groups",
        keyIdea: `Multiplication combines ${leftText} equal groups of ${rightText}.`,
        example: `${repeated} = ${resultText}`,
        nodes: [
          { label: `${leftText} groups`, detail: "Count the equal groups", symbol: "groups" },
          { label: `${rightText} in each`, detail: "Every group has the same size", symbol: "number" },
          { label: `${resultText} altogether`, detail: equation, symbol: "plus" },
        ],
        connections: [{ from: 0, to: 1, label: "of" }, { from: 1, to: 2, label: "combine" }],
      },
      followUpQuestion: `How could you show ${leftText} × ${rightText} with dots or counters?`,
      comprehensionCheck: {
        prompt: `How could you show ${leftText} × ${rightText} with dots or counters?`,
        expectedIdeas: [`Make ${leftText} equal groups.`, `Put ${rightText} dots in each group.`, `There are ${resultText} dots altogether.`],
        acceptableAnswers: [`${leftText} groups of ${rightText}`, `${resultText} dots`, repeated],
        hint: `Draw ${leftText} circles first. Then place ${rightText} dots inside every circle.`,
        correction: `${leftText} × ${rightText} can be shown as ${leftText} equal groups with ${rightText} dots in each, giving ${resultText} dots altogether.`,
      },
      provider: "reviewed-arithmetic-tool@1.0.0",
      model: "deterministic-arithmetic",
    };
  }

  const operationMeaning = operation === "add"
    ? `start with ${leftText} and combine ${rightText} more`
    : operation === "subtract"
      ? `start with ${leftText} and remove or compare ${rightText}`
      : operation === "multiply"
        ? "multiply the magnitudes, then use the sign pattern"
        : `ask how many groups of ${rightText} fit into ${leftText}`;
  return {
    disposition: "answer",
    answer: `${equation}. This operation means to ${operationMeaning}. Following that meaning gives ${resultText}.`,
    spokenAnswer: `${equation}. To work it out, ${operationMeaning}. That gives ${resultText}.`,
    visual: {
      title: `Reason through ${equation}`,
      kind: operation === "divide" ? "groups" : "sequence",
      keyIdea: `The ${operation} operation tells us to ${operationMeaning}.`,
      example: equation,
      nodes: [
        { label: "Start", detail: leftText, symbol: "number" },
        { label: "Use the operation", detail: `${symbol} ${rightText}`, symbol: operation === "divide" ? "divide" : operation === "add" ? "plus" : "number" },
        { label: "Result", detail: resultText, symbol: "idea" },
      ],
      connections: [{ from: 0, to: 1, label: symbol }, { from: 1, to: 2, label: "gives" }],
    },
    followUpQuestion: "What intermediate step would you use to check that result?",
    comprehensionCheck: {
      prompt: "What intermediate step would you use to check that result?",
      expectedIdeas: [operationMeaning, equation],
      acceptableAnswers: [equation, resultText],
      hint: `Use the meaning of ${operation} and write one step before the result.`,
      correction: `A useful check is to ${operationMeaning}; that leads to ${equation}.`,
    },
    provider: "reviewed-arithmetic-tool@1.0.0",
    model: "deterministic-arithmetic",
  };
}

export class ArithmeticTutorPolicy {
  readonly id = "reviewed-arithmetic-tool";
  readonly version = "1.0.0";

  evaluate(event: HeadlessEvent): TutorTurn | null {
    if (event.kind !== "question_transcribed") return null;
    const transcript = sanitizeTranscript(event.payload.text ?? "").toLocaleLowerCase().replace(/[−–—]/g, "-");
    const asksAboutTwoNegatives = /two negative|negative numbers|negative.*negative/.test(transcript);
    if (asksAboutTwoNegatives && /multipl|times|positive/.test(transcript)) return negativeRuleTurn();

    const normalized = normalizeNumberWords(transcript);
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*(plus|added to|minus|subtract(?:ed from)?|times|multiplied by|x|divided by|over|[+\-×÷*/])\s*(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const left = Number(match[1]);
    const right = Number(match[3]);
    const operator = match[2];
    const operation: Operation = /plus|added|\+/.test(operator) ? "add" : /minus|subtract|^-/.test(operator) ? "subtract" : /times|multipl|x|×|\*/.test(operator) ? "multiply" : "divide";
    return operationTurn(left, right, operation);
  }
}
