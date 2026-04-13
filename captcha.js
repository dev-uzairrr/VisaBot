import fetch from "node-fetch";
import { logger } from "./logger.js";

const API_KEY = process.env.API_KEY;

export async function solveTurnstile(params, page) {
  logger.info("Submitting captcha to 2Captcha");

  const request = {
    method: "turnstile",
    key: API_KEY,
    sitekey: params.sitekey,
    pageurl: page.url(),
    data: params.cData,
    pagedata: params.chlPageData,
    action: params.action,
    userAgent: params.userAgent,
    json: 1,
  };

  const res = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    body: new URLSearchParams(request),
  });

  const data = await res.json();

  if (data.status !== 1) {
    throw new Error("2Captcha submit failed: " + JSON.stringify(data));
  }

  const requestId = data.request;
  logger.info({ requestId }, "Captcha submitted");

  const start = Date.now();

  while (true) {
    if (Date.now() - start > 120000) {
      throw new Error("Captcha timeout");
    }

    await new Promise((r) => setTimeout(r, 5000));

    const result = await fetch(
      `https://2captcha.com/res.php?key=${API_KEY}&action=get&id=${requestId}&json=1`,
    ).then((r) => r.json());

    if (result.status === 1) {
      logger.info("Captcha solved");
      return result.request;
    }

    if (result.request !== "CAPCHA_NOT_READY") {
      throw new Error("2Captcha error: " + result.request);
    }

    logger.debug("Waiting for captcha...");
  }
}