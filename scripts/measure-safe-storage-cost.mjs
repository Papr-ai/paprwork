/**
 * What does one `safeStorage.decryptString` actually cost?
 *
 * The gateway's key IPC does five of them per request (the requested key, plus
 * both OAuth tokens unconditionally, each of which is an access + refresh pair),
 * and requests were timing out at 15s. Whether that matters depends entirely on
 * a number nobody had measured: if Chromium caches the Keychain-derived key per
 * process, a decrypt is AES over a few dozen bytes and five of them are free. If
 * it round-trips the Keychain every call, five of them are not.
 *
 * Runs as a real Electron main process — `safeStorage` is unavailable under
 * ELECTRON_RUN_AS_NODE. Uses an isolated userData dir and encrypts its own test
 * value, so it never reads the user's stored keys.
 *
 *   npx electron scripts/measure-safe-storage-cost.mjs
 */
import { app, safeStorage } from "electron";
import os from "node:os";
import path from "node:path";

app.setPath("userData", path.join(os.tmpdir(), `papr-safestorage-probe-${process.pid}`));

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  console.log(
    `${label.padEnd(26)} n=${String(samples.length).padStart(4)}  ` +
      `mean=${(total / samples.length).toFixed(4)}ms  ` +
      `p50=${percentile(sorted, 0.5).toFixed(4)}ms  ` +
      `p99=${percentile(sorted, 0.99).toFixed(4)}ms  ` +
      `max=${sorted[sorted.length - 1].toFixed(4)}ms`,
  );
}

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.log("safeStorage unavailable — nothing to measure");
    app.quit();
    return;
  }

  // Sized like a real OAuth token (the log shows 108 chars for the Claude one).
  const plaintext = "sk-ant-oat01-" + "x".repeat(95);

  // The first call is the one that can hit the Keychain. Time it alone: if the
  // key is cached per-process, only this one is expensive and the "five
  // decrypts per request" concern evaporates.
  let t = performance.now();
  const encrypted = safeStorage.encryptString(plaintext);
  const firstEncrypt = performance.now() - t;

  t = performance.now();
  safeStorage.decryptString(encrypted);
  const firstDecrypt = performance.now() - t;

  console.log(`first encryptString      ${firstEncrypt.toFixed(4)}ms`);
  console.log(`first decryptString      ${firstDecrypt.toFixed(4)}ms`);

  const decrypts = [];
  for (let i = 0; i < 2000; i++) {
    const start = performance.now();
    safeStorage.decryptString(encrypted);
    decrypts.push(performance.now() - start);
  }
  summarize("steady-state decrypt", decrypts);

  // What the IPC handler does per request, as a unit.
  const perRequest = [];
  for (let i = 0; i < 500; i++) {
    const start = performance.now();
    for (let k = 0; k < 5; k++) safeStorage.decryptString(encrypted);
    perRequest.push(performance.now() - start);
  }
  summarize("5 decrypts (one request)", perRequest);

  app.quit();
});
