/**
 * Import FIRST (before anything from dist/) in E2E scripts that create apps or
 * jobs. Points HOME, PAPR_HOME and PAPR_USER_DATA at a throwaway temp dir so
 * the script can never read or write the developer's real ~/Papr workspace
 * (the active-workspace pointer there otherwise wins over PAPR_HOME).
 *
 * Opt out only for deliberate live runs: PAPR_E2E_REAL_HOME=1.
 */
import fs from "fs";
import os from "os";
import path from "path";

if (process.env.PAPR_E2E_REAL_HOME !== "1") {
  // Keychain helpers (scripts/lib/testEnv.mjs) read the key from the real
  // home read-only; they spawn with this instead of the temp HOME.
  process.env.PAPR_E2E_ORIGINAL_HOME ??= os.homedir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "papr-e2e-home-"));
  fs.mkdirSync(path.join(home, "Papr"), { recursive: true });
  fs.mkdirSync(path.join(home, ".paprwork-v2"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PAPR_HOME = path.join(home, "Papr");
  process.env.PAPR_USER_DATA = path.join(home, ".paprwork-v2");
  os.homedir = () => home;
  process.on("exit", () => {
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  console.log(`[isolateHome] Using temp workspace ${home}`);
}
