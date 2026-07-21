import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("decimal misconception → visual bridge → comprehension check → teacher result", async ({ browser, request }) => {
  await request.delete("/api/state");
  const teacher = await browser.newPage();
  const display = await browser.newPage();

  await teacher.goto("/teacher/session/session-demo");
  await teacher.getByTestId("run-scripted-moment").click();
  await expect(teacher.getByTestId("proposal-proposal-decimals")).toBeVisible();
  await display.goto("/display/CC-2048");
  await teacher.getByTestId("launch-proposal-decimals").click();

  await expect(display.getByTestId("bridge-stage-1")).toBeVisible();
  await display.getByRole("button", { name: "Next", exact: true }).click();
  await expect(display.getByTestId("bridge-stage-2")).toBeVisible();
  await display.getByRole("button", { name: "Reveal 35 hundredths" }).click();
  await display.getByRole("button", { name: "Reveal 40 hundredths" }).click();
  await display.getByRole("button", { name: "Next", exact: true }).click();
  await expect(display.getByTestId("bridge-stage-3")).toBeVisible();
  await display.getByRole("button", { name: "Next", exact: true }).click();
  await expect(display.getByTestId("bridge-stage-4")).toBeVisible();
  await display.getByTestId("answer-0.35").click();
  await expect(display.getByText("Hint: compare tenths first.", { exact: false })).toBeVisible();
  await display.getByTestId("answer-0.40").click();
  await expect(display.getByTestId("bridge-stage-5")).toBeVisible();
  await expect(teacher.getByTestId("teacher-result-card")).toBeVisible();
  await teacher.getByRole("button", { name: "Save reviewed evidence" }).click();
  await expect(teacher.getByRole("button", { name: "Evidence saved" })).toBeDisabled();
});

test("critical teacher screen has no serious axe violations", async ({ page }) => {
  await page.goto("/teacher");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});
