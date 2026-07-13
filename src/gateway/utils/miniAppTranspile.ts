import path from "path";

export interface MiniAppTranspileResult {
  success: boolean;
  code?: string;
  message?: string;
  line?: number;
  column?: number;
}

const MINI_APP_TS_EXTENSIONS = new Set([".ts", ".tsx"]);

export function isMiniAppTypeScriptFile(filename: string): boolean {
  return MINI_APP_TS_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

/** True when esbuild failed due to missing native binary / install — not app source code. */
export function isEsbuildInfrastructureError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    (lower.includes("@esbuild/") && lower.includes("could not be found")) ||
    (lower.includes("esbuild") &&
      lower.includes("platform") &&
      lower.includes("binary")) ||
    lower.includes("failed to install esbuild") ||
    lower.includes("cannot find module 'esbuild'")
  );
}

/** Surface infra failures distinctly so agents don't treat them as TS syntax bugs. */
export function formatEsbuildErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!isEsbuildInfrastructureError(trimmed)) {
    return trimmed;
  }
  return (
    `[esbuild infrastructure error — NOT an app code bug] ${trimmed}\n\n` +
    `Fix in the Paprwork project root (NOT ~/Papr/apps): run \`npm install\` then \`npx esbuild --version\`. ` +
    `Do NOT npm install esbuild inside ~/Papr or individual app folders.`
  );
}

function parseEsbuildLocation(
  errorText: string,
): Pick<MiniAppTranspileResult, "line" | "column" | "message"> {
  const locationMatch = errorText.match(
    /<stdin>:(\d+):(\d+):\s*ERROR:\s*(.+)/,
  );
  if (locationMatch) {
    return {
      line: Number.parseInt(locationMatch[1], 10),
      column: Number.parseInt(locationMatch[2], 10),
      message: locationMatch[3].trim(),
    };
  }

  const messageMatch = errorText.match(/ERROR:\s*(.+)/);
  return {
    message: messageMatch?.[1]?.trim() ?? errorText.trim(),
  };
}

const MINI_APP_SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

/**
 * Syntax-validate any mini-app script (TS or JS) using esbuild — the same
 * compiler the iframe uses. Unlike naive delimiter counting, esbuild is
 * string/comment/regex-aware, so literals like indexOf('(') never produce
 * false "mismatched parentheses" errors.
 */
export async function validateMiniAppScriptSyntax(
  content: string,
  filename: string,
): Promise<MiniAppTranspileResult> {
  const ext = path.extname(filename).toLowerCase();
  if (!MINI_APP_SCRIPT_EXTENSIONS.has(ext)) {
    return { success: true };
  }

  const loader =
    ext === ".tsx" ? "tsx" : ext === ".ts" ? "ts" : ext === ".jsx" ? "jsx" : "js";

  try {
    const esbuild = await import("esbuild");
    await esbuild.transform(content, {
      loader,
      format: "esm",
      target: "es2020",
      platform: "browser",
    });
    return { success: true };
  } catch (transpileError) {
    const errorText =
      transpileError instanceof Error
        ? transpileError.message
        : String(transpileError);
    const parsed = parseEsbuildLocation(formatEsbuildErrorMessage(errorText));
    return {
      success: false,
      ...parsed,
    };
  }
}

/**
 * Transpile mini-app TypeScript the same way the Gateway does at request time.
 * Returns build errors the agent can act on before the iframe loads.
 */
export async function transpileMiniAppTypeScript(
  content: string,
  filename: string,
): Promise<MiniAppTranspileResult> {
  if (!isMiniAppTypeScriptFile(filename)) {
    return { success: true };
  }

  const ext = path.extname(filename).toLowerCase();

  try {
    const esbuild = await import("esbuild");
    const result = await esbuild.transform(content, {
      loader: ext === ".tsx" ? "tsx" : "ts",
      format: "esm",
      target: "es2020",
      platform: "browser",
      sourcemap: "inline",
    });
    return { success: true, code: result.code };
  } catch (transpileError) {
    const errorText =
      transpileError instanceof Error
        ? transpileError.message
        : String(transpileError);
    const parsed = parseEsbuildLocation(formatEsbuildErrorMessage(errorText));
    return {
      success: false,
      ...parsed,
    };
  }
}
