import { solveTurnstile } from "./captcha.js";
import { logger } from "./logger.js";

export async function injectTurnstileInterceptor(page) {
  await page.addInitScript(() => {
    const i = setInterval(() => {
      if (window.turnstile) {
        clearInterval(i);

        const originalRender = window.turnstile.render;

        window.turnstile.render = (a, b) => {
          window.cfParams = {
            sitekey: b.sitekey,
            action: b.action,
            cData: b.cData,
            chlPageData: b.chlPageData,
            userAgent: navigator.userAgent,
          };

          window.tsCallback = b.callback;
          return originalRender(a, b);
        };
      }
    }, 50);
  });
}

async function getParams(page) {
  return await page
    .waitForFunction(() => window.cfParams, { timeout: 20000 })
    .then((res) => res.jsonValue());
}

async function applySolution(page, token) {
  await page.evaluate((token) => {
    if (window.tsCallback) {
      window.tsCallback(token);
    }
  }, token);
}

export async function handleCloudflare(page, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const title = await page.title();

    if (!title.includes("Just a moment") && !title.includes("Verification")) {
      logger.info("No Cloudflare challenge detected");
      return true;
    }

    logger.warn(`Cloudflare detected (attempt ${i + 1})`);

    try {
      const params = await getParams(page);
      logger.info("Params extracted");

      const token = await solveTurnstile(params, page);
      await applySolution(page, token);

      await page.waitForNavigation({ timeout: 60000 });

      logger.info("Challenge passed");
      return true;
    } catch (err) {
      logger.error(err, "Failed attempt");
      await page.reload();
    }
  }

  throw new Error("Cloudflare bypass failed after retries");
}