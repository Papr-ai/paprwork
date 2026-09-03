#!/usr/bin/env node
/**
 * E2E LinkedIn flow via Papr Chrome CDP: feed → profile → messaging.
 * Usage: node scripts/test-linkedin-flow.mjs [--profile-url URL]
 */

import { chromium } from "playwright";

const CDP_URL = process.env.PAPR_PLATFORM_CDP_URL ?? "http://127.0.0.1:9222";
const PROFILE_URL_ARG = process.argv.find((a) => a.startsWith("--profile-url="))?.split("=")[1];

async function pageMetrics(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const mainHtml = main?.innerHTML?.length ?? 0;
    const mainText = main?.innerText?.length ?? 0;
    const bodyText = document.body?.innerText?.length ?? 0;
    const hasAuthwall = /authwall|sign in|join linkedin/i.test(document.body?.innerText?.slice(0, 500) ?? "");
    const unsupportedFlag = [...document.querySelectorAll("*")].some(
      (el) => el.textContent?.includes("unsupported command-line flag") ?? false,
    );
    return {
      url: location.href,
      title: document.title,
      mainHtml,
      mainText,
      bodyText,
      hasAuthwall,
      unsupportedFlag,
    };
  });
}

async function waitStable(page, label, { polls = 6, intervalMs = 3000, minMainHtml = 2000 } = {}) {
  const samples = [];
  for (let i = 0; i < polls; i++) {
    const m = await pageMetrics(page);
    samples.push({ t: i * intervalMs, ...m });
    console.log(`  [${label}] poll ${i + 1}/${polls}: mainHtml=${m.mainHtml} mainText=${m.mainText} url=${m.url.slice(0, 60)}`);
    if (m.hasAuthwall) {
      return { ok: false, reason: "authwall", samples };
    }
    if (m.unsupportedFlag) {
      return { ok: false, reason: "unsupported-flag-banner", samples };
    }
    await page.waitForTimeout(intervalMs);
  }
  const last = samples[samples.length - 1];
  const first = samples[0];
  const grew = last.mainHtml > first.mainHtml + 200;
  const stable = Math.abs(last.mainHtml - first.mainHtml) < 100 && last.mainHtml >= minMainHtml;
  const ok = stable || (grew && last.mainHtml >= minMainHtml);
  return {
    ok,
    reason: ok ? "stable-or-grew" : `mainHtml stuck at ${last.mainHtml} (need >= ${minMainHtml})`,
    samples,
  };
}

async function messagingMetrics(page) {
  return page.evaluate(() => {
    const selectors = [
      '[data-test-messaging-conversation-panel]',
      '.msg-overlay-list-bubble',
      '.msg-overlay-bubble-header',
      '.msg-conversations-container',
      '.msg-thread',
      '[class*="msg-overlay"]',
      'aside[aria-label*="Messaging"]',
    ];
    const hits = selectors
      .map((sel) => ({ sel, count: document.querySelectorAll(sel).length }))
      .filter((h) => h.count > 0);
    const mainText = document.querySelector("main")?.innerText?.length ?? 0;
    return {
      url: location.href,
      messagingHits: hits,
      mainText,
      hasMessagingUi: hits.length > 0,
    };
  });
}

async function findProfileUrlFromFeed(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/in/"]')];
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      if (!href.includes("/in/")) continue;
      if (href.includes("/in/me")) continue;
      if (href.includes("miniProfile")) continue;
      try {
        const u = new URL(href, location.origin);
        const path = u.pathname.replace(/\/$/, "");
        if (/^\/in\/[a-zA-Z0-9-_%]+$/.test(path)) {
          return u.origin + path + "/";
        }
      } catch {
        /* skip */
      }
    }
    return null;
  });
}

async function main() {
  console.log(`Connecting CDP: ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("No browser context on CDP");
  }

  let page = context.pages().find((p) => p.url().includes("linkedin.com") && !p.isClosed());
  if (!page) {
    page = context.pages().find((p) => !p.isClosed()) ?? (await context.newPage());
  }

  const results = { feed: null, profile: null, messaging: null };

  // 1. Feed
  console.log("\n=== STEP 1: Feed ===");
  await page.goto("https://www.linkedin.com/feed/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(4000);
  results.feed = await waitStable(page, "feed", { minMainHtml: 3000, polls: 5 });
  console.log(`Feed: ${results.feed.ok ? "PASS" : "FAIL"} — ${results.feed.reason}`);

  if (!results.feed.ok) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(1);
  }

  // 2. Profile
  console.log("\n=== STEP 2: Profile ===");
  let profileUrl = PROFILE_URL_ARG;
  if (!profileUrl) {
    profileUrl = await findProfileUrlFromFeed(page);
    console.log(`  Picked profile from feed: ${profileUrl ?? "(none)"}`);
  }
  if (!profileUrl) {
    profileUrl = "https://www.linkedin.com/in/linkedin/";
    console.log(`  Fallback profile: ${profileUrl}`);
  }

  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  results.profile = await waitStable(page, "profile", { minMainHtml: 4000, polls: 8, intervalMs: 2500 });

  const profileDetail = await page.evaluate(() => {
    const text = document.querySelector("main")?.innerText ?? "";
    return {
      hasExperience: /experience/i.test(text),
      hasEducation: /education/i.test(text),
      hasAbout: /about/i.test(text),
      sectionCount: document.querySelectorAll("main section").length,
    };
  });
  results.profile.detail = profileDetail;
  results.profile.hasSections =
    profileDetail.sectionCount >= 2 ||
    profileDetail.hasExperience ||
    profileDetail.hasEducation;
  results.profile.ok = results.profile.ok && results.profile.hasSections;

  console.log(
    `Profile: ${results.profile.ok ? "PASS" : "FAIL"} — ${results.profile.reason} sections=${profileDetail.sectionCount} exp=${profileDetail.hasExperience}`,
  );

  // 3. Messaging
  console.log("\n=== STEP 3: Messaging ===");
  await page.goto("https://www.linkedin.com/messaging/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(5000);

  const msgSamples = [];
  for (let i = 0; i < 5; i++) {
    const m = await messagingMetrics(page);
    msgSamples.push(m);
    console.log(
      `  [messaging] poll ${i + 1}/5: ui=${m.hasMessagingUi} hits=${JSON.stringify(m.messagingHits.map((h) => h.sel))}`,
    );
    await page.waitForTimeout(2000);
  }

  const lastMsg = msgSamples[msgSamples.length - 1];
  results.messaging = {
    ok: lastMsg.hasMessagingUi,
    reason: lastMsg.hasMessagingUi ? "messaging-ui-present" : "no messaging overlay/panel found",
    samples: msgSamples,
  };
  console.log(`Messaging: ${results.messaging.ok ? "PASS" : "FAIL"} — ${results.messaging.reason}`);

  console.log("\n=== SUMMARY ===");
  const allOk = results.feed.ok && results.profile.ok && results.messaging.ok;
  console.log(JSON.stringify(results, null, 2));
  console.log(allOk ? "\n✅ ALL PASSED" : "\n❌ SOME STEPS FAILED");

  // Do not browser.close() — that kills Papr Chrome on CDP attach.
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
