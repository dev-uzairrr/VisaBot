import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { evaluate } from "mathjs";
import { injectTurnstileInterceptor, handleCloudflare } from "./cloudflare.js";
import { logger } from "./logger.js";

chromium.use(StealthPlugin());
const MATH_EXPRESSION_REGEX = /(\d+)\s*([+\-*/xX×÷＋－])\s*(\d+)\s*=?/;

function solveMathExpression(expression) {
  const match = expression.match(MATH_EXPRESSION_REGEX);
  if (!match) return null;

  const left = match[1];
  const operator = match[2];
  const right = match[3];
  const normalizedOperator =
    operator === "＋"
      ? "+"
      : operator === "－"
      ? "-"
      : operator === "×"
      ? "*"
      : operator === "÷"
      ? "/"
      : operator;

  const op =
    normalizedOperator === "x" || normalizedOperator === "X"
      ? "*"
      : normalizedOperator;
  const safeExpression = `${left}${op}${right}`;
  try {
    return Number(evaluate(safeExpression));
  } catch {
    return null;
  }
}

function extractMathExpression(text) {
  if (!text) return null;
  const normalized = text
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8")
    .replace(/[—–]/g, "-")
    .replace(/[=~]/g, " = ")
    .replace(/[^\d+\-*/xX×÷＝= ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(MATH_EXPRESSION_REGEX);
  return match ? `${match[1]} ${match[2]} ${match[3]}` : null;
}

async function solveStandaloneMathGate(page, options = {}) {
  const { logNoMatch = true } = options;
  const frames = page.frames();
  let extractionFailedLogged = false;
  for (const frame of frames) {
    try {
      const heading = frame.locator("text=Please answer this question").first();
      const card = heading.locator(
        'xpath=ancestor::*[.//input and (.//button[contains(normalize-space(),"Submit")] or .//input[@type="submit"])][1]'
      );
      if ((await card.count().catch(() => 0)) === 0) continue;

      const input = card
        .locator('input:not([type="hidden"]):not([type="email"]):not([type="password"]):not([type="submit"]):not([type="button"])')
        .first();
      const submit = card
        .locator('button:has-text("Submit"), button[type="submit"], input[type="submit"]')
        .first();
      if ((await input.count().catch(() => 0)) === 0 || (await submit.count().catch(() => 0)) === 0) {
        logger.warn("Captcha card found but input/submit controls missing");
        continue;
      }

      const expression = await card.evaluate((el) => {
        const regex = /(\d+)\s*([+\-*/xX×÷＋－])\s*(\d+)\s*=?/;
        const opClassMap = {
          op_p: "+",
          op_m: "-",
          op_mul: "*",
          op_x: "*",
          op_div: "/",
        };

        // Fast path for known captcha markup:
        // <span>2 <span class="op_p"></span> 4 =</span><input id="captcha"...>
        const captchaInput = el.querySelector("#captcha");
        if (captchaInput) {
          const holder = captchaInput.parentElement || el;
          const span = holder.querySelector("span");
          if (span) {
            const numbers = (span.textContent || "").match(/\d+/g) || [];
            let operator = null;
            const opNode = span.querySelector("span");
            if (opNode) {
              const classes = Array.from(opNode.classList || []);
              for (const cls of classes) {
                if (opClassMap[cls]) {
                  operator = opClassMap[cls];
                  break;
                }
              }
              if (!operator) {
                const before = getComputedStyle(opNode, "::before").content || "";
                const after = getComputedStyle(opNode, "::after").content || "";
                const opText = `${before} ${after}`.replace(/["'\s]/g, "");
                const opMatch = opText.match(/[+\-*/xX×÷]/);
                if (opMatch) operator = opMatch[0];
              }
            }

            if (numbers.length >= 2 && operator) {
              return `${numbers[0]} ${operator} ${numbers[1]}`;
            }
          }
        }

        const parts = [];
        const add = (value) => {
          if (typeof value === "string" && value.trim()) parts.push(value);
        };

        add(el.textContent || "");
        const descendants = Array.from(el.querySelectorAll("*"));
        for (const node of descendants) {
          add(node.textContent || "");
          add(node.getAttribute("value") || "");
          add(node.getAttribute("placeholder") || "");
          add(node.getAttribute("aria-label") || "");
          add(node.getAttribute("title") || "");

          for (const attr of Array.from(node.attributes || [])) {
            if (attr.name.startsWith("data-")) add(attr.value);
          }

          const before = getComputedStyle(node, "::before").content || "";
          const after = getComputedStyle(node, "::after").content || "";
          add(before.replace(/^["']|["']$/g, ""));
          add(after.replace(/^["']|["']$/g, ""));
        }

        const joined = parts.join(" ").replace(/\s+/g, " ");
        const match = joined.match(regex);
        return match ? `${match[1]} ${match[2]} ${match[3]}` : null;
      });
      if (!expression) {
        if (!extractionFailedLogged) {
          logger.warn("Captcha card found but inspect-element expression extraction failed");
          extractionFailedLogged = true;
        }
        continue;
      }

      const answer = solveMathExpression(expression);
      if (answer === null) {
        logger.warn({ expression }, "Captcha expression parse failed");
        continue;
      }

      await input.fill(String(answer));
      await submit.click();
      await page.waitForTimeout(1200);
      logger.info({ expression, answer }, "Solved standalone math gate");
      if (!(await page.title()).includes("Captcha")) {
        return true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("Execution context was destroyed")) {
        logger.warn("Math gate frame changed during check, retrying...");
      }
    }
  }

  if (logNoMatch) {
    const title = await page.title().catch(() => "");
    if (title.includes("Captcha")) {
      const sample = await page
        .locator("body")
        .innerText()
        .then((t) => t.replace(/\s+/g, " ").slice(0, 180))
        .catch(() => "");
      logger.warn({ title, sample }, "Captcha page visible but math expression not parsed");
    } else {
      logger.info("Math gate check: not on standalone math page");
    }
  }
  return false;
}

async function ensureLoginFormVisible(page, emailInput, timeoutMs = 30000) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const visible = await emailInput.isVisible().catch(() => false);
    if (visible) return true;

    const title = await page.title().catch(() => "");
    if (title.includes("Just a moment") || title.includes("Verification")) {
      logger.warn("Cloudflare challenge still active, retrying bypass...");
      await handleCloudflare(page, 4);
      continue;
    }

    if (attempt % 5 === 0) {
      logger.info(
        { url: page.url(), title: title || "unknown" },
        "Waiting for login form or math gate"
      );
    }

    await page.waitForTimeout(1500);
  }

  const title = await page.title();
  logger.warn({ url: page.url(), title }, "Login form still not visible after retries");
  await page.screenshot({ path: "debug-login-form-missing.png", fullPage: true });
  throw new Error(
    "Login form not found. Saved screenshot: cf-bot/debug-login-form-missing.png"
  );
}

async function solvePostLoginMathGate(page, timeoutMs = 90000) {
  const started = Date.now();
  let attempt = 0;
  let waitingLoggedAt = -1;
  logger.info("Checking post-login math gate...");
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const solved = await solveStandaloneMathGate(page, { logNoMatch: false });
    if (solved) {
      logger.info("Post-login math gate solved and submitted");
      return true;
    }

    const title = await page.title().catch(() => "");
    if (attempt % 5 === 0) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      if (elapsedSec !== waitingLoggedAt) {
        waitingLoggedAt = elapsedSec;
      logger.info(
        {
          url: page.url(),
          title: title || "unknown",
            elapsedSec,
        },
        "Waiting for post-login math gate or next page"
      );
      }
    }
    await page.waitForTimeout(1500);
  }

  logger.info("Post-login math gate not detected within wait window");
  return false;
}

async function selectWorkNationalVisaCategory(page) {
  const target = page
    .locator('a:has-text("WORK National VISA"), text=WORK National VISA')
    .first();
  const found = (await target.count().catch(() => 0)) > 0;
  if (!found) {
    logger.warn("category not found");
    return false;
  }

  await target.click();
  await page.waitForLoadState("domcontentloaded");
  logger.info({ url: page.url() }, "Selected WORK National VISA category");
  return true;
}

(async () => {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS === "true",
  });

  const context = await browser.newContext({
    proxy: process.env.PROXY_SERVER
      ? { server: process.env.PROXY_SERVER }
      : undefined,
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  await injectTurnstileInterceptor(page);

  logger.info("Navigating...");
  await page.goto(
    "https://schedule.cf-grcon-isl-pakistan.com/schedule/grcon-isl-pakistan",
    { waitUntil: "domcontentloaded" }
  );

  await handleCloudflare(page);

  logger.info("Attempting login...");
  const loginEmail = process.env.LOGIN_EMAIL;
  const loginPassword = process.env.LOGIN_PASSWORD;
  if (!loginEmail || !loginPassword) {
    throw new Error("Missing LOGIN_EMAIL or LOGIN_PASSWORD in .env");
  }

  await page.waitForLoadState("domcontentloaded");
  const emailInput = page
    .locator(
      'input[type="email"]:visible, input[name*="mail" i]:visible, input[id*="mail" i]:visible, input[autocomplete="username"]:visible'
    )
    .first();
  const passwordInput = page
    .locator(
      'input[type="password"]:visible, input[name*="pass" i]:visible, input[id*="pass" i]:visible'
    )
    .first();
  const loginButton = page
    .locator('button:has-text("Log in"), input[type="submit"], button[type="submit"]')
    .first();

  await ensureLoginFormVisible(page, emailInput, 60000);
  await emailInput.fill(loginEmail);
  await passwordInput.fill(loginPassword);
  await loginButton.click();

  logger.info("Login submitted");
  await page.waitForLoadState("domcontentloaded");
  await solvePostLoginMathGate(page, 90000);
  await selectWorkNationalVisaCategory(page);
  logger.info({ url: page.url() }, "Current URL after login");

  logger.info("Browser left open for manual verification");
})();