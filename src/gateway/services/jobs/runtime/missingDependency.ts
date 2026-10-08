import { accessSync, constants, statSync } from "fs";
import path from "path";

/**
 * Structured "this job needs X and X is not here" failure.
 *
 * Why a typed error: before this, a missing ffmpeg / numpy surfaced as a stack
 * trace the agent had to interpret (and then improvised `brew install` or a
 * private venv). A stable `code` lets the UI render an Install button, the
 * retry logic skip pointless retries, and agents stop guessing.
 */
export type MissingDependencyKind = "tool" | "python" | "node";

export interface MissingDependencyItem {
  kind: MissingDependencyKind;
  name: string;
  /** Plain-language install command for this OS, when we know one. */
  installHint?: string;
  /** Why it is missing (e.g. last lines of pip output). */
  detail?: string;
}

export class MissingDependencyError extends Error {
  readonly code = "missing_dependency" as const;
  constructor(readonly items: MissingDependencyItem[]) {
    super(MissingDependencyError.describe(items));
    this.name = "MissingDependencyError";
  }

  private static describe(items: MissingDependencyItem[]): string {
    const lines = items.map((i) => {
      const what = i.kind === "tool" ? i.name : `${i.kind} package ${i.name}`;
      const hint = i.installHint ? ` — install with: ${i.installHint}` : "";
      const detail = i.detail ? ` (${i.detail})` : "";
      return `  • ${what}${hint}${detail}`;
    });
    return `Missing dependency — this job declares requirements that are not installed:\n${lines.join("\n")}`;
  }

  /** One greppable log line the UI / agents can parse. */
  toLogLine(): string {
    return `PAPR_ERROR ${JSON.stringify({ code: this.code, items: this.items })}`;
  }
}

interface ToolSpec {
  bin: string;
  install: Partial<Record<NodeJS.Platform, string>>;
}

/** Tools a job may declare in runtime.json `tools`. Unknown names are looked up by binary name. */
export const KNOWN_TOOLS: Record<string, ToolSpec> = {
  ffmpeg: {
    bin: "ffmpeg",
    install: {
      darwin: "brew install ffmpeg",
      win32: "winget install Gyan.FFmpeg",
      linux: "sudo apt-get install -y ffmpeg",
    },
  },
  node: {
    bin: "node",
    install: {
      darwin: "brew install node@24",
      win32: "winget install OpenJS.NodeJS.LTS",
      linux: "https://nodejs.org/en/download/package-manager",
    },
  },
  python3: {
    bin: process.platform === "win32" ? "python" : "python3",
    install: {
      darwin: "brew install python@3.12",
      win32: "winget install Python.Python.3.12",
      linux: "sudo apt-get install -y python3 python3-venv",
    },
  },
  git: {
    bin: "git",
    install: {
      darwin: "brew install git",
      win32: "winget install Git.Git",
      linux: "sudo apt-get install -y git",
    },
  },
  curl: {
    bin: "curl",
    install: { win32: "winget install cURL.cURL", linux: "sudo apt-get install -y curl" },
  },
};

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Pure-JS `which` over an explicit PATH string (so we test the job's PATH, not the gateway's). */
export function findOnPath(bin: string, pathValue: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function findMissingTools(
  tools: string[],
  pathValue: string,
): MissingDependencyItem[] {
  const missing: MissingDependencyItem[] = [];
  for (const name of tools) {
    const spec = KNOWN_TOOLS[name];
    const bin = spec?.bin ?? name;
    if (findOnPath(bin, pathValue)) continue;
    missing.push({
      kind: "tool",
      name,
      installHint: spec?.install[process.platform],
    });
  }
  return missing;
}
