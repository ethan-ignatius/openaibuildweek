import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const API_URL = process.env.TEACHER_BRAIN_API_URL ?? "http://127.0.0.1:8000";
const BOARD_URL = process.env.TEACHER_BRAIN_BOARD_URL ?? "http://127.0.0.1:5173";

function postAction(action) {
  const response = execFileSync(
    "curl",
    [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--header",
      "Content-Type: application/json",
      "--data",
      JSON.stringify(action),
      `${API_URL}/api/board/actions`,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(response);
}

async function inspectPage(browser, viewport, screenshotPath) {
  const page = await browser.newPage({ viewport });
  await page.goto(BOARD_URL, { waitUntil: "domcontentloaded" });
  await page.locator(".connection-connected").waitFor({ timeout: 5000 });
  await page.locator('[data-element-id="curl-equation"] .katex').waitFor({
    timeout: 5000,
  });

  const equation = page.locator('[data-element-id="curl-equation"]');
  const highlightApplied = await equation.evaluate((element) =>
    element.classList.contains("highlight-pulse"),
  );
  const layout = await page.evaluate(() => ({
    horizontalOverflow:
      document.documentElement.scrollWidth > document.documentElement.clientWidth,
    viewportWidth: window.innerWidth,
    boardWidth: document.querySelector(".smartboard")?.getBoundingClientRect().width,
  }));

  if (!highlightApplied) {
    throw new Error("Injected board.highlight did not apply to curl-equation");
  }
  if (layout.horizontalOverflow) {
    throw new Error(`Board has horizontal overflow at ${viewport.width}px`);
  }

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();
  return { viewport, highlightApplied, ...layout, screenshotPath };
}

postAction({ type: "board.clear", region: "all" });

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const livePage = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await livePage.goto(BOARD_URL, { waitUntil: "domcontentloaded" });
  await livePage.locator(".connection-connected").waitFor({ timeout: 5000 });

  const writeResponse = postAction({
    type: "board.write_math",
    region: "center",
    latex: String.raw`\frac{x}{3} + 4 = 9`,
    element_id: "curl-equation",
  });
  const highlightResponse = postAction({
    type: "board.highlight",
    element_id: "curl-equation",
    style: "pulse",
  });

  if (!writeResponse.accepted || !highlightResponse.accepted) {
    throw new Error("FastAPI did not accept the M0 board actions");
  }

  await livePage.locator('[data-element-id="curl-equation"] .katex').waitFor({
    timeout: 5000,
  });
  await livePage
    .locator('[data-element-id="curl-equation"].highlight-pulse')
    .waitFor({ timeout: 5000 });
  await livePage.screenshot({ path: "/tmp/teacher-brain-m0-desktop.png" });

  const desktop = {
    viewport: { width: 1440, height: 900 },
    highlightApplied: true,
    horizontalOverflow: await livePage.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    screenshotPath: "/tmp/teacher-brain-m0-desktop.png",
  };
  await livePage.close();

  const mobile = await inspectPage(
    browser,
    { width: 390, height: 844 },
    "/tmp/teacher-brain-m0-mobile.png",
  );

  console.log(
    JSON.stringify(
      {
        acceptedActions: [writeResponse.action.type, highlightResponse.action.type],
        desktop,
        mobile,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
