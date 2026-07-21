import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { coachingFeedbackScene, decimalComparisonScene, genericTutorScene } from "../../headless/whiteboard/excalidraw-tool";

test("default projector renders a validated decimal scene without serious accessibility violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scene = decimalComparisonScene("explain", "en", 1);
  await page.route("http://127.0.0.1:4317/board", async (route) => {
    await route.fulfill({
      json: scene,
      headers: { "access-control-allow-origin": "*" },
    });
  });

  await page.goto("/board");
  await expect(page.getByRole("img", { name: "Compare decimals by place" })).toBeVisible();
  await expect(page.getByText("Local Visual Stage · reviewed visual")).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});

test("child-friendly reasoning scene exposes a big idea, visual steps, and application question", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scene = genericTutorScene({
    disposition: "answer",
    answer: "Plants use sunlight, water, and carbon dioxide to make sugar. The sugar supplies material and energy for growth.",
    spokenAnswer: "Plants use sunlight, water, and carbon dioxide to make sugar. That sugar helps the plant build new roots, stems, and leaves.",
    visual: {
      title: "Photosynthesis: a plant food factory",
      kind: "sequence",
      keyIdea: "Plants make their own food using sunlight.",
      example: "A sunny leaf turns water and carbon dioxide into sugar.",
      nodes: [
        { label: "Sunlight", detail: "Energy from the sun", symbol: "sun" },
        { label: "Water", detail: "Moves up from roots", symbol: "water" },
        { label: "Sugar", detail: "Food for plant growth", symbol: "plant" },
      ],
      connections: [{ from: 0, to: 1, label: "joins" }, { from: 1, to: 2, label: "helps make" }],
    },
    followUpQuestion: "How could a plant use the sugar it makes?",
    provider: "fixture",
    model: "fixture",
  }, 2);
  await page.route("http://127.0.0.1:4317/board", async (route) => {
    await route.fulfill({ json: scene, headers: { "access-control-allow-origin": "*" } });
  });

  await page.goto("/board");
  await expect(page.getByRole("img", { name: "Photosynthesis: a plant food factory" })).toBeVisible();
  await expect(page.getByText("THE BIG IDEA", { exact: true })).toBeVisible();
  await expect(page.getByText("YOUR TURN", { exact: true })).toBeVisible();
  await expect(page.locator(".visual-stage-symbol")).toHaveCount(3);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});

test("coaching feedback supports a retry without exposing the raw reply", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const scene = coachingFeedbackScene({
    status: "partly_correct",
    feedback: "You showed equal groups, but used two groups instead of three.",
    coachingExplanation: "Three times three needs three equal groups.",
    retryPrompt: "Draw three circles and put three dots in each. How many dots are there?",
    identifiedIdeas: ["equal groups"],
    provider: "fixture",
    model: "fixture",
  }, {
    prompt: "How could you show three times three with dots?",
    expectedIdeas: ["three groups", "three in each", "nine altogether"],
    acceptableAnswers: ["three groups of three"],
    hint: "Draw three circles first.",
    correction: "Three groups with three dots each make nine dots.",
  }, 3);
  await page.route("http://127.0.0.1:4317/board", async (route) => {
    await route.fulfill({ json: scene, headers: { "access-control-allow-origin": "*" } });
  });

  await page.goto("/board");
  await expect(page.getByRole("img", { name: "Good start—add one more idea" })).toBeVisible();
  await expect(page.getByText("ALMOST THERE", { exact: true })).toBeVisible();
  await expect(page.getByText("TRY AGAIN", { exact: true })).toBeVisible();
  await expect(page.getByText("My name is Student A")).toHaveCount(0);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});
