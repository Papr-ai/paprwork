import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECT_CHROME_BASE_ARGS,
  buildDirectChromeSpawnArgs,
  buildPlatformCdpUrl,
  classifyCdpPortHolder,
  describeBlockedCdpPort,
  getPidsListeningOnPort,
  isCdpAttachUnsupportedError,
  isChromeUsingUserDataDir,
  killChromeListeningOnPort,
  looksLikeChromeCommandLine,
  ownProcessPids,
  planCdpPortTakeover,
  resolvePlatformCdpPort,
} from "../src/gateway/services/platforms/platformDirectChromeSpawn.js";

const SPAWN_SOURCE = fileURLToPath(
  new URL("../src/gateway/services/platforms/platformDirectChromeSpawn.ts", import.meta.url),
);

describe("platformDirectChromeSpawn", () => {
  it("builds minimal Chrome Manager-style args", () => {
    const args = buildDirectChromeSpawnArgs({
      userDataDir: "/tmp/papr-linkedin",
      cdpPort: 9222,
      startUrl: "https://www.linkedin.com/login",
    });
    expect(args).toContain("--user-data-dir=/tmp/papr-linkedin");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toEqual(
      expect.arrayContaining([...DIRECT_CHROME_BASE_ARGS]),
    );
    expect(args).toContain("https://www.linkedin.com/login");
    expect(args.some((arg) => arg.includes("no-sandbox"))).toBe(false);
    expect(args.some((arg) => arg.includes("AutomationControlled"))).toBe(false);
    expect(args).toContain("--disable-extensions");
  });

  it("defaults CDP port to 9222", () => {
    expect(resolvePlatformCdpPort()).toBe(9222);
    expect(buildPlatformCdpUrl()).toBe("http://127.0.0.1:9222");
  });

  it("detects CDP attach unsupported errors", () => {
    expect(
      isCdpAttachUnsupportedError(
        new Error(
          "browserType.connectOverCDP: Protocol error (Browser.setDownloadBehavior): Browser context management is not supported.",
        ),
      ),
    ).toBe(true);
    expect(isCdpAttachUnsupportedError(new Error("timeout"))).toBe(false);
  });

  it("isChromeUsingUserDataDir returns false when port is free", () => {
    expect(isChromeUsingUserDataDir(59999, "/tmp/no-such-profile")).toBe(false);
  });
});

const CHROME_CMD =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9333 --user-data-dir=/tmp/other";
const ELECTRON_CMD =
  "/Users/me/paprwork/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --remote-debugging-port=9333";

describe("CDP port takeover never signals Paprwork itself", () => {
  const own = new Set([100, 200]);

  it("classifies the gateway and its Electron parent as own, even with a Chrome-like command", () => {
    expect(classifyCdpPortHolder({ pid: 200, commandLine: CHROME_CMD }, own)).toBe("own_process");
    expect(classifyCdpPortHolder({ pid: 100, commandLine: ELECTRON_CMD }, own)).toBe(
      "own_process",
    );
  });

  it("does not mistake Electron for Chrome", () => {
    expect(looksLikeChromeCommandLine(ELECTRON_CMD)).toBe(false);
    expect(
      looksLikeChromeCommandLine(`${ELECTRON_CMD} --disable-features=ChromeWhatsNewUI`),
    ).toBe(false);
    expect(looksLikeChromeCommandLine(CHROME_CMD)).toBe(true);
    expect(looksLikeChromeCommandLine("")).toBe(false);
  });

  it("plans to stop only a separate Chrome", () => {
    const plan = planCdpPortTakeover([{ pid: 300, commandLine: CHROME_CMD }], own);
    expect(plan).toEqual({ killable: [300], blockedBy: [] });
  });

  it("blocks when Electron holds the port — the reported crash", () => {
    const plan = planCdpPortTakeover([{ pid: 200, commandLine: ELECTRON_CMD }], own);
    expect(plan.killable).toEqual([]);
    expect(plan.blockedBy).toEqual([
      { pid: 200, commandLine: ELECTRON_CMD, kind: "own_process" },
    ]);
    expect(describeBlockedCdpPort(9333, plan.blockedBy)).toMatch(
      /own DevTools endpoint.*PAPR_PLATFORM_EMBEDDED_CDP/,
    );
  });

  it("blocks unknown or non-Chrome holders instead of killing them", () => {
    const plan = planCdpPortTakeover(
      [
        { pid: 400, commandLine: "node server.js" },
        { pid: 500, commandLine: "" },
      ],
      own,
    );
    expect(plan.killable).toEqual([]);
    expect(plan.blockedBy.map((h) => h.kind)).toEqual(["other", "other"]);
    expect(describeBlockedCdpPort(9333, plan.blockedBy)).toMatch(/not Chrome \(pid 400: node/);
  });

  it("stops nothing when any holder is blocked, since killing Chrome would not free the port", () => {
    const plan = planCdpPortTakeover(
      [
        { pid: 300, commandLine: CHROME_CMD },
        { pid: 200, commandLine: ELECTRON_CMD },
      ],
      own,
    );
    expect(plan.blockedBy).toHaveLength(1);
    const source = readFileSync(SPAWN_SOURCE, "utf8");
    const kill = source.slice(source.indexOf("export async function killChromeListeningOnPort"));
    expect(kill.indexOf("throw new Error(describeBlockedCdpPort")).toBeGreaterThan(-1);
    expect(kill.indexOf("throw new Error(describeBlockedCdpPort")).toBeLessThan(
      kill.indexOf('"SIGTERM"'),
    );
  });

  it("escalates to SIGKILL only for the Chrome it chose to stop", () => {
    const source = readFileSync(SPAWN_SOURCE, "utf8");
    const kill = source.slice(source.indexOf("export async function killChromeListeningOnPort"));
    const sigkill = kill.slice(0, kill.indexOf('"SIGKILL"'));
    expect(sigkill.slice(sigkill.lastIndexOf("for (const pid of"))).toContain("stillListening()");
  });

  it("names the gateway's parent as own", () => {
    expect(ownProcessPids().has(process.pid)).toBe(true);
    expect(ownProcessPids().has(process.ppid)).toBe(true);
  });
});

const lsofAvailable = spawnSync("which", ["lsof"]).status === 0;

describe.runIf(lsofAvailable && process.platform !== "win32")(
  "port holders against real sockets",
  () => {
    let listener: ChildProcess | undefined;
    let client: Socket | undefined;

    afterEach(() => {
      client?.destroy();
      listener?.kill();
      listener = undefined;
      client = undefined;
    });

    async function startListener(): Promise<number> {
      listener = spawn(process.execPath, [
        "-e",
        'require("net").createServer(()=>{}).listen(0,"127.0.0.1",function(){console.log(this.address().port)})',
      ]);
      return new Promise((resolve) => {
        listener?.stdout?.once("data", (chunk) => resolve(Number(String(chunk).trim())));
      });
    }

    it("reports only the listener, not a process holding a client connection", async () => {
      const port = await startListener();
      await new Promise<void>((resolve) => {
        client = connect(port, "127.0.0.1", () => resolve());
      });
      const pids = getPidsListeningOnPort(port);
      expect(pids).toEqual([listener?.pid]);
      expect(pids).not.toContain(process.pid);
    });

    it("refuses to stop a non-Chrome listener and leaves it running", async () => {
      const port = await startListener();
      await expect(killChromeListeningOnPort(port)).rejects.toThrow(/not Chrome/);
      expect(listener?.exitCode).toBeNull();
      expect(getPidsListeningOnPort(port)).toEqual([listener?.pid]);
    });

    it("refuses when this process holds the port", async () => {
      const server: Server = createServer();
      const port = await new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      });
      try {
        await expect(killChromeListeningOnPort(port)).rejects.toThrow(/own DevTools endpoint/);
      } finally {
        server.close();
      }
    });
  },
);
