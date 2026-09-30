#!/usr/bin/env node
/**
 * E2E: profile photo upload → Parse cloud → display merge + pending retry semantics.
 *
 * Uses live Parse APIs (same path as Settings → upload photo).
 * Does NOT require cloud app host or gateway — only Papr login session.
 *
 * Credentials (first match wins):
 *   1. PAPR_SESSION_TOKEN + PAPR_USER_ID env vars
 *   2. Papr Work secure storage via Electron (session token + user id)
 *
 * Usage:
 *   npm run test:profile-photo-sync-e2e
 *   npm run test:profile-photo-sync-e2e -- --no-restore
 *
 * Prerequisites:
 *   - Logged into Papr in Papr Work
 *   - Network access to Parse (server.papr.ai)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal, resolvePaprSessionCredentials } from "./lib/testEnv.mjs";

const {
  fetchParseUserProfile,
  syncProfileToParse,
} = await import("../src/electron/ipc/paprProfileSync.ts");
const {
  isProfileImagePendingSync,
  resolveDisplayProfileImage,
} = await import("../ui/utils/profileImageSyncCore.ts");

const args = process.argv.slice(2);
const restoreOriginal = !args.includes("--no-restore");

const GREEN = "\x1b[92m";
const RED = "\x1b[91m";
const YELLOW = "\x1b[93m";
const CYAN = "\x1b[96m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/** 1×1 PNG (test marker — not a real user photo). */
const TEST_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function readGatewayProfileImageUrl() {
  try {
    const raw = readFileSync(
      join(process.env.HOME ?? "", "Papr", "data", "settings.json"),
      "utf8",
    );
    const settings = JSON.parse(raw);
    return {
      imageUrl: settings.profile?.imageUrl?.trim() ?? "",
      syncPending: settings.profile?.profileImageSyncPending === true,
    };
  } catch {
    return { imageUrl: "", syncPending: false };
  }
}

async function main() {
  loadEnvLocal();

  console.log(`\n${BOLD}${CYAN}Profile photo sync E2E${RESET}\n`);

  const creds = await resolvePaprSessionCredentials();
  if (!creds) {
    console.log(
      `${RED}Cannot run E2E:${RESET} no Papr session found.\n` +
        "  Log into Papr in Papr Work, or set PAPR_SESSION_TOKEN + PAPR_USER_ID in .env.local\n",
    );
    process.exit(1);
  }

  console.log(`  Session source: ${creds.source}\n`);

  let originalImageUrl = creds.profileImage ?? "";
  let originalDisplayName = creds.displayName ?? "";

  let liveTestsRan = false;

  try {
    console.log(`${BOLD}1) Fetch current Parse profile${RESET}`);
    let before;
    try {
      before = await fetchParseUserProfile(creds.sessionToken, creds.userId);
      originalImageUrl = before.profileImageUrl?.trim() ?? originalImageUrl;
      originalDisplayName =
        before.displayName?.trim() ?? before.fullname?.trim() ?? originalDisplayName;
      check("Parse profile fetch", Boolean(before.userId));
      console.log(
        `     userId=${before.userId} image=${originalImageUrl ? originalImageUrl.slice(0, 60) + "…" : "(none)"}`,
      );
    } catch (err) {
      check(
        "Parse profile fetch",
        false,
        err instanceof Error ? err.message : String(err),
      );
      console.log(
        `\n${YELLOW}Skipping live upload checks — Parse API unreachable.${RESET}`,
      );
      before = null;
    }

    console.log(`\n${BOLD}2) Merge logic (unit-style in E2E harness)${RESET}`);
    check(
      "pending data URL beats stale cloud",
      resolveDisplayProfileImage(
        TEST_PNG_DATA_URL,
        "https://example.com/old.jpg",
        true,
      ) === TEST_PNG_DATA_URL,
    );
    check(
      "cloud wins when not pending",
      resolveDisplayProfileImage(
        "https://example.com/local.jpg",
        "https://example.com/cloud.jpg",
        false,
      ) === "https://example.com/cloud.jpg",
    );
    check(
      "data URL treated as pending",
      isProfileImagePendingSync(TEST_PNG_DATA_URL, false),
    );

    if (before) {
      liveTestsRan = true;

    console.log(`\n${BOLD}3) Upload test PNG to Parse${RESET}`);
    try {
      const syncResult = await syncProfileToParse({
        sessionToken: creds.sessionToken,
        userId: creds.userId,
        name: originalDisplayName || "Paprwork E2E",
        imageUrl: TEST_PNG_DATA_URL,
      });
      check(
        "syncProfileToParse success",
        Boolean(syncResult.syncedImageUrl?.startsWith("http")),
      );
      const uploadedUrl = syncResult.syncedImageUrl ?? syncResult.profileImageUrl ?? "";
      console.log(`     synced=${uploadedUrl.slice(0, 72)}…`);

      console.log(`\n${BOLD}4) Re-fetch Parse profile (cloud is source of truth)${RESET}`);
      await new Promise((r) => setTimeout(r, 1500));
      const after = await fetchParseUserProfile(creds.sessionToken, creds.userId);
      const cloudImage = after.profileImageUrl?.trim() ?? "";
      check("Parse profileImage updated", cloudImage.startsWith("http"));
      check(
        "Cloud URL matches sync result",
        Boolean(uploadedUrl) && cloudImage === uploadedUrl,
        `cloud=${cloudImage.slice(0, 64)} synced=${uploadedUrl.slice(0, 64)}`,
      );
      check(
        "Display merge uses cloud after sync",
        resolveDisplayProfileImage(TEST_PNG_DATA_URL, cloudImage, false) === cloudImage,
      );

      console.log(`\n${BOLD}5) Pending flag semantics${RESET}`);
      check(
        "While pending, UI keeps local data URL",
        resolveDisplayProfileImage(TEST_PNG_DATA_URL, originalImageUrl, true) ===
          TEST_PNG_DATA_URL,
      );
      check(
        "After sync (pending cleared), UI uses cloud",
        resolveDisplayProfileImage(uploadedUrl, cloudImage, false) === cloudImage,
      );

      const gatewayProfile = readGatewayProfileImageUrl();
      if (gatewayProfile.imageUrl) {
        console.log(`\n${BOLD}6) Local gateway settings snapshot (informational)${RESET}`);
        console.log(
          `     imageUrl=${gatewayProfile.imageUrl.slice(0, 64)}… pending=${gatewayProfile.syncPending}`,
        );
      }
    } catch (err) {
      check(
        "syncProfileToParse success",
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
    }
  } finally {
    if (restoreOriginal && creds && liveTestsRan) {
      console.log(`\n${BOLD}7) Restore original profile photo${RESET}`);
      try {
        if (originalImageUrl) {
          await syncProfileToParse({
            sessionToken: creds.sessionToken,
            userId: creds.userId,
            name: originalDisplayName || undefined,
            imageUrl: originalImageUrl,
          });
          console.log(`  ${GREEN}Restored previous cloud photo${RESET}`);
        } else {
          console.log(
            `  ${YELLOW}No original photo — left test PNG on account (use --no-restore intentionally)${RESET}`,
          );
        }
      } catch (err) {
        console.log(
          `  ${RED}Restore failed:${RESET} ${err instanceof Error ? err.message : String(err)}`,
        );
        failed++;
      }
    } else if (!restoreOriginal) {
      console.log(`\n${YELLOW}Skipped restore (--no-restore)${RESET}`);
    }
  }

  console.log(
    `\n${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : GREEN}${failed} failed${RESET}\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err);
  process.exit(1);
});
