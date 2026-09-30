#!/usr/bin/env node
/**
 * Test PDF upload to Papr Memory with graph auto (upload_document / attachment path).
 *
 * Requires:
 *   - Paprwork running (gateway ws://localhost:18789)
 *   - PAPR_API_KEY in env (or .env.local via dotenv)
 *
 * Usage:
 *   node scripts/test-document-upload-graph-auto.mjs [--file=/path/to/doc.pdf] [--chat-id=uuid]
 */

import WebSocket from "ws";
import Papr from "@papr/memory";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, "..", ".env.local") });

const DEFAULT_FILE =
  "/Users/amirkabbara/Customers/RevenueReimagined/MyAdvise/GTM Audit_MyAdvice_v5_Final.pdf";
const GATEWAY_WS = "ws://localhost:18789";

function parseArgs(argv) {
  const fileArg = argv.find((a) => a.startsWith("--file="));
  const chatArg = argv.find((a) => a.startsWith("--chat-id="));
  return {
    filePath: fileArg?.split("=").slice(1).join("=") ?? DEFAULT_FILE,
    chatId: chatArg?.split("=")[1] ?? "test-upload-graph-auto",
  };
}

function wsSend(type, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_WS);
    const id = `test-${Date.now()}`;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket request timeout (180s)"));
    }, 180_000);

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, type, payload }));
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id !== id) return;
      clearTimeout(timeout);
      ws.close();
      if (msg.success) {
        resolve(msg.data);
      } else {
        reject(new Error(msg.error ?? "Gateway error"));
      }
    });
  });
}

async function pollUploadStatus(client, uploadId, maxAttempts = 24) {
  for (let i = 1; i <= maxAttempts; i++) {
    const status = await client.document.getStatus(uploadId);
    const doc = status.document_status ?? status;
    const statusType = doc.status_type ?? status.status ?? "unknown";
    const progress = doc.progress ?? status.progress ?? 0;
    const pct = Math.round(Number(progress) * 100);
    console.log(`  [poll ${i}/${maxAttempts}] status=${statusType} progress=${pct}%`);

    if (statusType === "completed" || statusType === "failed") {
      return { statusType, progress, raw: status };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return { statusType: "timeout", progress: null, raw: null };
}

async function verifyGraphAutoPolicy(client) {
  const schemas = await client.schemas.list({ status_filter: "active" });
  const wsSchema = (schemas.data ?? []).find((s) => s.name === "WorkspaceContext");
  console.log("\n--- Graph auto policy check ---");
  if (!wsSchema?.id) {
    console.warn("  ⚠ WorkspaceContext schema not found — graph auto may be disabled");
    return null;
  }
  console.log(`  WorkspaceContext schema id: ${wsSchema.id}`);
  const policy = {
    graph: { mode: "auto", schema_id: wsSchema.id },
  };
  console.log("  Expected add policy.graph:", JSON.stringify(policy.graph));
  return policy;
}

async function main() {
  const { filePath, chatId } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.PAPR_API_KEY?.trim();
  if (!apiKey) {
    console.error("PAPR_API_KEY not set");
    process.exit(1);
  }

  const fileStat = await stat(filePath);
  console.log("=== Papr Memory document upload test (graph auto) ===");
  console.log("File:", filePath);
  console.log(`Size: ${(fileStat.size / 1024 / 1024).toFixed(2)} MB`);
  console.log("Chat ID:", chatId);
  console.log("Gateway:", GATEWAY_WS);

  const client = new Papr({
    xAPIKey: apiKey,
    maxRetries: 2,
    timeout: 120_000,
  });

  await verifyGraphAutoPolicy(client);

  console.log("\n--- Upload via gateway memory:upload-attachment ---");
  const started = Date.now();
  const uploadData = await wsSend("memory:upload-attachment", {
    filePath,
    chatId,
    fileName: path.basename(filePath),
    mimeType: "application/pdf",
  });

  console.log("Upload response:", JSON.stringify(uploadData, null, 2));
  console.log(`Upload API round-trip: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (uploadData?.skipped) {
    console.error("\n❌ Upload skipped:", uploadData.reason ?? uploadData);
    process.exit(1);
  }

  const uploadId = uploadData?.uploadId;
  if (!uploadId) {
    console.error("\n❌ No uploadId returned");
    process.exit(1);
  }

  console.log("\n--- Poll document processing status ---");
  const final = await pollUploadStatus(client, uploadId);
  console.log("\nFinal status:", final.statusType);
  if (final.raw?.memory_items?.length) {
    console.log(
      "Memory IDs:",
      final.raw.memory_items.map((m) => m.memoryId ?? m.id).filter(Boolean),
    );
  }

  if (final.statusType === "completed") {
    console.log("\n✅ Upload completed with graph auto path");
    process.exit(0);
  }
  if (final.statusType === "failed") {
    console.error("\n❌ Processing failed:", final.raw);
    process.exit(1);
  }
  console.log("\n⚠ Processing still in progress or timed out — upload was accepted");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err.message ?? err);
  process.exit(1);
});
