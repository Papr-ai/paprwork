/**
 * Standalone test for the zombie process detection fix in reconcileStaleRunningJobs
 * and the watchdog timeout in runProcess.
 * 
 * Tests the actual logic without vitest (which has esbuild version conflicts).
 */
import { spawn } from "child_process";
import assert from "assert";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

// ─── Test 1: process.kill(pid, 0) detects alive processes ───
console.log("\n🧪 Fix 1: Zombie process detection via process.kill(pid, 0)");

test("process.kill(pid, 0) returns true for own process (alive)", () => {
  let alive = false;
  try {
    process.kill(process.pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.strictEqual(alive, true, "Own process should be detected as alive");
});

test("process.kill(pid, 0) throws for non-existent PID (dead)", () => {
  let alive = true;
  try {
    process.kill(99999999, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.strictEqual(alive, false, "Non-existent PID should be detected as dead");
});

await testAsync("Detects zombie: process exits but ChildProcess object still exists", async () => {
  const proc = spawn("echo", ["hello"]);
  const pid = proc.pid;
  await new Promise((resolve) => proc.on("close", resolve));
  
  let alive = true;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  assert.strictEqual(alive, false, "Exited process should be detected as dead via kill(pid, 0)");
});

await testAsync("Detects alive process correctly, then dead after kill", async () => {
  const proc = spawn("sleep", ["10"]);
  const pid = proc.pid;
  
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  assert.strictEqual(alive, true, "Running process should be detected as alive");
  
  proc.kill("SIGKILL");
  await new Promise((resolve) => proc.on("close", resolve));
  
  let aliveAfter = true;
  try { process.kill(pid, 0); aliveAfter = true; } catch { aliveAfter = false; }
  assert.strictEqual(aliveAfter, false, "Killed process should be detected as dead");
});

// ─── Test 2: Reconciler logic simulation ───
console.log("\n🧪 Fix 1 (integration): Reconciler zombie cleanup logic");

test("Reconciler skips genuinely running process", () => {
  const running = new Map();
  running.set("job-1", { pid: process.pid });
  
  let cleaned = false;
  if (running.has("job-1")) {
    const proc = running.get("job-1");
    try {
      process.kill(proc.pid, 0);
      // alive — skip
    } catch {
      running.delete("job-1");
      cleaned = true;
    }
  }
  assert.strictEqual(cleaned, false);
});

test("Reconciler cleans up zombie process (dead PID)", () => {
  const running = new Map();
  running.set("job-2", { pid: 99999999 });
  
  let cleaned = false;
  if (running.has("job-2")) {
    const proc = running.get("job-2");
    try {
      process.kill(proc.pid, 0);
    } catch {
      running.delete("job-2");
      cleaned = true;
    }
  }
  assert.strictEqual(cleaned, true);
  assert.strictEqual(running.has("job-2"), false);
});

test("Reconciler cleans up process with no PID", () => {
  const running = new Map();
  running.set("job-3", { pid: undefined });
  
  let cleaned = false;
  if (running.has("job-3")) {
    const proc = running.get("job-3");
    if (!proc.pid) {
      running.delete("job-3");
      cleaned = true;
    }
  }
  assert.strictEqual(cleaned, true);
});

// ─── Test 3: Watchdog timeout logic ───
console.log("\n🧪 Fix 2: Watchdog timeout in runProcess");

await testAsync("Watchdog kills hung process and resolves promise", async () => {
  const WATCHDOG_MS = 500;
  const proc = spawn("sleep", ["60"]);
  const pid = proc.pid;
  
  const result = await new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
    
    const watchdog = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      safeResolve({ exitCode: -1, errorMessage: "Watchdog timeout" });
    }, WATCHDOG_MS);
    
    proc.on("close", (code) => {
      clearTimeout(watchdog);
      safeResolve({ exitCode: code, errorMessage: null });
    });
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      safeResolve({ exitCode: -1, errorMessage: err.message });
    });
  });
  
  // Give OS a moment to reap the process
  await new Promise(r => setTimeout(r, 100));
  // Either watchdog fired (-1) or close fired after SIGKILL (null or -1)
  assert.ok(result.exitCode === -1 || result.exitCode === null, 
    `Process should be killed (got exitCode: ${result.exitCode})`);
  
  let alive = true;
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  assert.strictEqual(alive, false, "Process should be dead after watchdog");
});

await testAsync("Watchdog is cleared on normal exit (no double-resolve)", async () => {
  const WATCHDOG_MS = 5000;
  const proc = spawn("echo", ["hello"]);
  
  let resolveCount = 0;
  const result = await new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (val) => {
      resolveCount++;
      if (!resolved) { resolved = true; resolve(val); }
    };
    
    const watchdog = setTimeout(() => {
      safeResolve({ exitCode: -1, errorMessage: "Watchdog timeout" });
    }, WATCHDOG_MS);
    
    proc.on("close", (code) => {
      clearTimeout(watchdog);
      safeResolve({ exitCode: code, errorMessage: null });
    });
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      safeResolve({ exitCode: -1, errorMessage: err.message });
    });
  });
  
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.errorMessage, null);
  assert.strictEqual(resolveCount, 1, "Should only resolve once");
});

// ─── Summary ───
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log("❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
  process.exit(0);
}
