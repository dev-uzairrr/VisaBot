import "dotenv/config";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { evaluate } from "mathjs";
import { injectTurnstileInterceptor, handleCloudflare } from "./cloudflare.js";
import { logger } from "./logger.js";
import { closeDb, getActiveAccounts, initDb, seedAccountsIfEmpty } from "./db.js";

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

async function ensureLoginFormVisible(page, emailInput, account, timeoutMs = 30000) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const visible = await emailInput.isVisible().catch(() => false);
    if (visible) return true;

    const title = await page.title().catch(() => "");
    if (title.includes("Just a moment") || title.includes("Verification")) {
      logger.warn("Cloudflare challenge still active, retrying bypass...");
      await handleCloudflare(page, account.api_key, 4);
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

async function selectWorkNationalVisaCategory(page, account) {
  const timeoutMs = Number(account.category_wait_ms || "120000");
  const pollMs = Number(account.category_poll_ms || "2000");
  const started = Date.now();
  let attempt = 0;
  const categoryName = account.category_name || "Schengen VISA";
  const categoryRegex = new RegExp(
    categoryName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
    "i"
  );

  logger.info(
    { timeoutMs, pollMs, categoryName },
    "Waiting for category to become available"
  );

  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const candidates = [
      page
        .locator(
          `a:has-text("${categoryName}"), button:has-text("${categoryName}"), text=${categoryName}`
        )
        .first(),
      page.locator("a, button").filter({ hasText: categoryRegex }).first(),
    ];

    for (const candidate of candidates) {
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;

      const candidateText = (await candidate.innerText().catch(() => "")).trim();
      const candidateHref = await candidate.getAttribute("href").catch(() => null);
      const beforeUrl = page.url();
      logger.info(
        { attempt, categoryName, beforeUrl, candidateText, candidateHref },
        "Category found and attempting click"
      );
      await candidate.click({ timeout: 5000 });
      await page.waitForTimeout(1000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const afterUrl = page.url();
      const urlChanged = afterUrl !== beforeUrl;

      logger.info(
        { attempt, categoryName, beforeUrl, afterUrl, urlChanged },
        "CLICK_CONFIRMED: Category clicked"
      );
      return true;
    }

    const elapsedSec = Math.floor((Date.now() - started) / 1000);
    if (attempt % 5 === 0) {
      logger.info(
        { attempt, elapsedSec, url: page.url() },
        "Category not visible yet, retrying"
      );
    }
    await page.waitForTimeout(pollMs);
  }

  logger.warn(
    { waitedMs: timeoutMs, attempts: attempt, categoryName, url: page.url() },
    "Category not visible yet (likely not live yet)"
  );
  return false;
}

async function selectAvailableView(page, account) {
  const timeoutMs = Number(account.available_view_wait_ms || "60000");
  const pollMs = Number(account.available_view_poll_ms || "1500");
  const started = Date.now();
  let attempt = 0;

  logger.info({ timeoutMs, pollMs }, "Waiting for schedule view dropdown");

  while (Date.now() - started < timeoutMs) {
    attempt += 1;

    const dropdownTriggerCandidates = [
      page.locator("button, a, span, div").filter({ hasText: /^Week$/i }).first(),
      page.locator("button, a, span, div").filter({ hasText: /Month|Week|Day|Agenda|Available/i }).first(),
    ];

    let opened = false;
    for (const trigger of dropdownTriggerCandidates) {
      const visible = await trigger.isVisible().catch(() => false);
      if (!visible) continue;

      const triggerText = (await trigger.innerText().catch(() => "")).trim();
      logger.info({ attempt, triggerText }, "DROPDOWN_CLICKED: Opening schedule view dropdown");
      await trigger.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      opened = true;
      break;
    }

    const availableOption = page
      .locator("li, a, button, span, div")
      .filter({ hasText: /^Available$/i })
      .first();
    const availableVisible = await availableOption.isVisible().catch(() => false);

    if (!opened && !availableVisible) {
      if (attempt % 5 === 0) {
        logger.info({ attempt, url: page.url() }, "View dropdown not ready yet, retrying");
      }
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (availableVisible) {
      await availableOption.click({ timeout: 5000 });
      await page.waitForTimeout(1200);
      logger.info({ attempt, url: page.url() }, "AVAILABLE_SELECTED: Switched schedule view to Available");
      return true;
    }

    await page.waitForTimeout(pollMs);
  }

  logger.warn(
    { waitedMs: timeoutMs, attempts: attempt, url: page.url() },
    "Failed to switch schedule view to Available within wait window"
  );
  return false;
}

async function createAppointmentFromFirstAvailableSlot(page, account) {
  const timeoutMs = Number(account.slot_wait_ms || "120000");
  const pollMs = Number(account.slot_poll_ms || "1500");
  const started = Date.now();
  let attempt = 0;

  logger.info({ timeoutMs, pollMs }, "Waiting for first available appointment slot");

  while (Date.now() - started < timeoutMs) {
    attempt += 1;

    const slotButton = page
      .locator('a, button, [role="button"]')
      .filter({ hasText: /^\+$/ })
      .first();
    const slotVisible = await slotButton.isVisible().catch(() => false);

    if (slotVisible) {
      const slotRow = slotButton.locator("xpath=ancestor::tr[1]").first();
      const slotRowText = (await slotRow.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      logger.info(
        { attempt, slotRowText },
        "PLUS_SLOT_FOUND: Clicking first available slot"
      );
      await slotButton.click({ timeout: 5000 });
      await page.waitForTimeout(1000);

      const created = await fillAndSubmitAppointmentDialog(page, account, { slotRowText });
      if (created) {
        return true;
      }
    }

    if (attempt % 5 === 0) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      logger.info({ attempt, elapsedSec, url: page.url() }, "Available slot not visible yet, retrying");
    }

    await page.waitForTimeout(pollMs);
  }

  logger.warn(
    { waitedMs: timeoutMs, attempts: attempt, url: page.url() },
    "No available slot appeared within wait window"
  );
  return false;
}

async function fillAndSubmitAppointmentDialog(page, account, context = {}) {
  const userFullName = account.user_full_name;
  const userPhone = account.user_phone;
  const userMobile = account.user_mobile;

  if (!userFullName || !userPhone || !userMobile) {
    throw new Error("Missing USER_FULL_NAME, USER_PHONE, or USER_MOBILE in .env #userdata");
  }

  const dialog = page
    .locator('text=New Appointment')
    .locator('xpath=ancestor::*[self::div or self::section][1]')
    .first();
  const dialogVisible = await dialog.isVisible().catch(() => false);
  if (!dialogVisible) {
    logger.warn(
      { slotRowText: context.slotRowText || null },
      "New Appointment dialog did not appear after clicking slot"
    );
    return false;
  }

  const dialogText = (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const timeInputs = dialog.locator('input[readonly], input[disabled]');
  const fromValue = await timeInputs.nth(0).inputValue().catch(() => "");
  const toValue = await timeInputs.nth(1).inputValue().catch(() => "");

  logger.info(
    {
      slotRowText: context.slotRowText || null,
      fromValue,
      toValue,
      dialogPreview: dialogText.slice(0, 250),
    },
    "APPOINTMENT_DIALOG_OPEN: Filling appointment form"
  );

  const textInputs = dialog.locator(
    'input:not([type="hidden"]):not([type="submit"]):not([readonly]):not([disabled])'
  );
  const inputCount = await textInputs.count().catch(() => 0);
  if (inputCount < 3) {
    logger.warn({ inputCount }, "Appointment dialog inputs not found as expected");
    return false;
  }

  const fullNameInput = textInputs.nth(0);
  const phoneInput = textInputs.nth(1);
  const mobileInput = textInputs.nth(2);

  await fullNameInput.fill(userFullName);
  await phoneInput.fill(userPhone);
  await mobileInput.fill(userMobile);

  logger.info(
    {
      slotRowText: context.slotRowText || null,
      fromValue,
      toValue,
      userFullName,
      userPhone,
      userMobile,
    },
    "APPOINTMENT_FORM_FILLED: User data entered into appointment dialog"
  );

  const createButton = dialog
    .locator('button:has-text("Create appointment"), input[type="submit"]')
    .first();
  const createButtonText = (await createButton.innerText().catch(() => "")).trim();
  logger.info(
    {
      slotRowText: context.slotRowText || null,
      fromValue,
      toValue,
      createButtonText,
    },
    "APPOINTMENT_SUBMIT_READY: Clicking create appointment button"
  );
  await createButton.click({ timeout: 5000 });
  await page.waitForTimeout(1500);

  logger.info(
    {
      url: page.url(),
      slotRowText: context.slotRowText || null,
      fromValue,
      toValue,
    },
    "APPOINTMENT_SUBMITTED: Create appointment clicked"
  );
  return true;
}

function envBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return String(value).trim().toLowerCase() === "true";
}

function mask(value, keepStart = 2, keepEnd = 2) {
  const s = String(value ?? "");
  if (s.length <= keepStart + keepEnd) return "*".repeat(Math.max(4, s.length));
  return `${s.slice(0, keepStart)}***${s.slice(-keepEnd)}`;
}

async function fillPostAppointmentDetailsForm(page, account) {
  const timeoutMs = Number(account.post_form_wait_ms || "90000");
  const pollMs = Number(account.post_form_poll_ms || "1500");
  const started = Date.now();
  let attempt = 0;

  const region = account.user_region_employment_in_greece;
  const am = account.user_am;
  const apofasiYear = account.user_apofasi_year;
  const apofasiNumber = account.user_apofasi_number;
  const employerName = account.user_greek_employer_name;
  const passportNumber = account.user_passport_number;
  const declare = envBool(account.user_declare_informative, true);

  if (!region || !am || !apofasiYear || !apofasiNumber || !employerName || !passportNumber) {
    throw new Error(
      "Missing USER_REGION_EMPLOYMENT_IN_GREECE, USER_AM, USER_APOFASI_YEAR, USER_APOFASI_NUMBER, USER_GREEK_EMPLOYER_NAME, or USER_PASSPORT_NUMBER in .env #userdata"
    );
  }

  logger.info({ timeoutMs, pollMs }, "Waiting for post-appointment APOFASI details form");

  const header = page
    .locator("text=APOFASI DETAILS, text=APOFASI Details, text=APOFASI")
    .first();

  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const visible = await header.isVisible().catch(() => false);
    if (visible) break;

    if (attempt % 5 === 0) {
      const elapsedSec = Math.floor((Date.now() - started) / 1000);
      logger.info(
        { attempt, elapsedSec, url: page.url() },
        "Post-appointment form not visible yet, retrying"
      );
    }
    await page.waitForTimeout(pollMs);
  }

  const headerVisible = await header.isVisible().catch(() => false);
  if (!headerVisible) {
    logger.warn({ waitedMs: timeoutMs, attempts: attempt, url: page.url() }, "APOFASI form not detected");
    return false;
  }

  logger.info({ url: page.url() }, "POST_FORM_DETECTED: Filling APOFASI details");

  const rowFor = (labelTextUpper) =>
    page.locator(
      `xpath=//*[contains(translate(normalize-space(.),"abcdefghijklmnopqrstuvwxyz","ABCDEFGHIJKLMNOPQRSTUVWXYZ"),"${labelTextUpper}")]/ancestor::*[self::div or self::tr or self::li][1]`
    ).first();

  const fillSelectInRow = async (row, value, fieldName) => {
    const select = row.locator("select").first();
    await select.waitFor({ state: "visible", timeout: 15000 });
    const normalizedTarget = String(value).replace(/\s+/g, " ").trim().toLowerCase();
    const options = await select.locator("option").allTextContents().catch(() => []);
    const cleanedOptions = options.map((o) => o.replace(/\s+/g, " ").trim());
    const matchedLabel = cleanedOptions.find(
      (opt) => opt.toLowerCase() === normalizedTarget
    ) || cleanedOptions.find((opt) => opt.toLowerCase().includes(normalizedTarget));

    if (matchedLabel) {
      await select.selectOption({ label: matchedLabel }).catch(async () => {
        await select.selectOption({ value: matchedLabel }).catch(async () => {
          await select.selectOption({ label: value }).catch(async () => {
            await select.selectOption({ value }).catch(() => {});
          });
        });
      });
    } else {
      await select.selectOption({ label: value }).catch(async () => {
        await select.selectOption({ value }).catch(async () => {
          await select.selectOption({ index: 1 }).catch(() => {});
        });
      });
    }

    const selected = await select.inputValue().catch(() => "");
    logger.info(
      { field: fieldName, value, matchedLabel: matchedLabel || null, selected, options: cleanedOptions },
      "POST_FORM_FIELD_SET"
    );
  };

  const fillInputInRow = async (row, value, fieldName, maskValue = false) => {
    const input = row.locator('input:not([type="hidden"]):not([type="submit"])').first();
    await input.waitFor({ state: "visible", timeout: 15000 });
    await input.fill(String(value));
    logger.info(
      { field: fieldName, value: maskValue ? mask(value) : String(value) },
      "POST_FORM_FIELD_SET"
    );
  };

  await fillSelectInRow(
    rowFor("REGION OF EMPLOYMENT IN GREECE"),
    region,
    "REGION_OF_EMPLOYMENT_IN_GREECE"
  );
  await fillInputInRow(rowFor("AM("), am, "AM");
  await fillSelectInRow(rowFor("APOFASI YEAR"), apofasiYear, "APOFASI_YEAR");
  await fillInputInRow(rowFor("APOFASI NUMBER ONLY"), apofasiNumber, "APOFASI_NUMBER_ONLY");
  await fillInputInRow(rowFor("GREEK EMPLOYER'S NAME"), employerName, "GREEK_EMPLOYER_NAME");
  await fillInputInRow(rowFor("APPLICANT'S PASSPORT NUMBER"), passportNumber, "PASSPORT_NUMBER", true);

  const declareRow = rowFor("DECLARE THAT ALL ABOVE INFORMATIVE");
  const declareCheckbox = declareRow.locator('input[type="checkbox"]').first();
  const cbVisible = await declareCheckbox.isVisible().catch(() => false);
  if (cbVisible) {
    const checked = await declareCheckbox.isChecked().catch(() => false);
    if (declare && !checked) {
      await declareCheckbox.check().catch(async () => {
        await declareCheckbox.click().catch(() => {});
      });
    }
    const finalChecked = await declareCheckbox.isChecked().catch(() => false);
    logger.info(
      { field: "DECLARE_INFORMATIVE", desired: declare, checked: finalChecked },
      "POST_FORM_FIELD_SET"
    );
  } else {
    logger.warn("Declare checkbox not found/visible");
  }

  logger.info({ url: page.url() }, "POST_FORM_READY: APOFASI details filled");
  return true;
}

async function runSingleAccountFlow(account) {
  const browser = await chromium.launch({
    headless: envBool(account.headless, false),
  });
  try {
    const context = await browser.newContext({
      proxy: account.proxy_server
        ? { server: account.proxy_server }
        : undefined,
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    await injectTurnstileInterceptor(page);

    logger.info({ label: account.label, login: mask(account.login_email) }, "Starting account flow");
    const websiteUrl = account.website_url;
    if (!websiteUrl) {
      throw new Error("Missing website_url in account record");
    }
    await page.goto(
      websiteUrl,
      { waitUntil: "domcontentloaded" }
    );

    await handleCloudflare(page, account.api_key);

    logger.info("Attempting login...");
    const loginEmail = account.login_email;
    const loginPassword = account.login_password;
    if (!loginEmail || !loginPassword) {
      throw new Error("Missing login_email or login_password in account record");
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

    await ensureLoginFormVisible(page, emailInput, account, 60000);
    await emailInput.fill(loginEmail);
    await passwordInput.fill(loginPassword);
    await loginButton.click();

    logger.info("Login submitted");
    await page.waitForLoadState("domcontentloaded");
    await solvePostLoginMathGate(page, 90000);
    await selectWorkNationalVisaCategory(page, account);
    await selectAvailableView(page, account);
    await createAppointmentFromFirstAvailableSlot(page, account);
    await fillPostAppointmentDetailsForm(page, account);
    logger.info({ url: page.url() }, "Current URL after login");
  } finally {
    await browser.close().catch(() => {});
  }
}

(async () => {
  initDb();
  seedAccountsIfEmpty();
  const accounts = getActiveAccounts();
  if (accounts.length === 0) {
    throw new Error("No active accounts found in database");
  }

  for (const account of accounts) {
    try {
      await runSingleAccountFlow(account);
    } catch (error) {
      logger.error(
        { label: account.label, login: mask(account.login_email), error: String(error) },
        "Account flow failed, continuing with next account"
      );
    }
  }
  closeDb();
})();