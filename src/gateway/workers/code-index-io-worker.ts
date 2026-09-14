/**
 * Worker thread for synchronous code-index file I/O (read + hash).
 * Keeps fs.readFileSync off the gateway main event loop.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { parentPort } from "node:worker_threads";

export interface CodeIndexIoRequest {
  id: number;
  type: "read-utf8-with-hash";
  filePath: string;
  maxBytes: number;
}

export interface CodeIndexIoReadResult {
  content: string;
  hash: string;
  lineCount: number;
}

export interface CodeIndexIoResponse {
  id: number;
  success: boolean;
  data?: CodeIndexIoReadResult;
  error?: string;
}

function readUtf8WithHash(
  filePath: string,
  maxBytes: number,
): CodeIndexIoReadResult {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error("Not a file");
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `File too large for code index read (${stat.size} > ${maxBytes} bytes)`,
    );
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");
  const lineCount = content.length === 0 ? 0 : content.split("\n").length;
  return { content, hash, lineCount };
}

parentPort?.on("message", (req: CodeIndexIoRequest) => {
  const respond = (res: CodeIndexIoResponse): void => {
    parentPort?.postMessage(res);
  };
  try {
    if (req.type === "read-utf8-with-hash") {
      const data = readUtf8WithHash(req.filePath, req.maxBytes);
      respond({ id: req.id, success: true, data });
      return;
    }
    respond({ id: req.id, success: false, error: `Unknown request: ${req.type}` });
  } catch (err) {
    respond({
      id: req.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
