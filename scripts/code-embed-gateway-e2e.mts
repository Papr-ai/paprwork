// End-to-end, laptop off, through the real agent bash tool in cloud-agent gateway mode (no model on the machine):
//   GATEWAY_MODE=cloud_agent PAPR_HOME=<run>/Papr PAPR_API_KEY=... PAPR_BASE_URL=<memory> tsx scripts/code-embed-gateway-e2e.mts
// A grep in a cloned app gets the hybrid-grep pointers: code graph built from the clone + server-embedded semantic hits.
import * as fs from "fs";
import * as path from "path";
const home = process.env.PAPR_HOME!;
const app = path.join(home, "apps", "7e57c10d-1111-4222-8333-444455556666");
fs.mkdirSync(path.join(app, "lib"), { recursive: true });
fs.writeFileSync(path.join(app, "lib/retry.ts"), "// Retry an HTTP upload with exponential backoff and jitter\nexport async function uploadWithRetry(send: () => Promise<Response>, attempts = 5) {\n  for (let i = 0; i < attempts; i++) {\n    try { const r = await send(); if (r.ok) return r; } catch {}\n    await new Promise((res) => setTimeout(res, 2 ** i * 200 + Math.random() * 100));\n  }\n  throw new Error('upload failed');\n}\n");
fs.writeFileSync(path.join(app, "lib/invoice.ts"), "// Render a PDF invoice with line items, tax and totals\nexport function renderInvoicePdf(o: { items: { price: number; qty: number }[]; taxRate: number }) {\n  const subtotal = o.items.reduce((s, i) => s + i.price * i.qty, 0);\n  return { subtotal, total: subtotal * (1 + o.taxRate) };\n}\n");
fs.writeFileSync(path.join(app, "app.ts"), "import { uploadWithRetry } from './lib/retry';\nimport { renderInvoicePdf } from './lib/invoice';\nexport async function sendInvoice(o: any) { const pdf = renderInvoicePdf(o); return uploadWithRetry(() => fetch('/upload', { method: 'POST', body: JSON.stringify(pdf) })); }\n");
const { executeBashCommand } = await import("../src/core/tools/bash.js");
const { getCodeEmbedRuntime } = await import("../src/core/tools/codeEmbed/runtime.js");
const grep = `grep -rn "backoff when the upload fails" ${app}`;
let r: any = await executeBashCommand({ command: grep } as any);
const rt = await getCodeEmbedRuntime();
console.log("tier", rt?.tier, "status", rt?.status);
for (let i = 0; i < 60 && rt && rt.store.pendingBlobs().some((b) => !rt.store.isCloudIndexed(b)); i++) await new Promise((x) => setTimeout(x, 500));
const stats = await (await fetch(process.env.PAPR_BASE_URL + "/e2e/stats")).json();
console.log("server", JSON.stringify(stats), "model files", fs.existsSync(path.join(home, "data/models/papr-embed-code-1-0.6b/onnx")));
const { deviceHitsForGrep } = await import("../src/core/tools/codeEmbed/runtime.js");
const t0 = Date.now(); const dh = await deviceHitsForGrep(app, "backoff when the upload fails", 10_000);
console.log("deviceHits", Date.now() - t0, "ms", JSON.stringify(dh).slice(0, 600));
for (let k = 0; k < 3; k++) { const t1 = Date.now(); const d2 = await deviceHitsForGrep(app, "backoff when the upload fails"); console.log("budget2s", Date.now() - t1, "ms hits", d2.hits.length); }
const { codePointersForGrep } = await import("../src/core/tools/codeSearchV2.js");
console.log("pointers:", JSON.stringify(await codePointersForGrep(app, grep, "backoff when the upload fails", "backoff when the upload fails", dh.hits, "", "fix the upload backoff")));
r = await executeBashCommand({ command: grep } as any);
const out: string = r?.data?.stdout ?? "";
console.log(JSON.stringify(r).slice(0, 2500));
const ok = rt?.tier === "cloud" && /Code pointers/.test(out) && /lib\/retry\.ts/.test(out.split("=== Grep")[0]) && stats.embed_document >= 3;
console.log(ok ? "PASS gateway hybrid grep (cloud tier, graph + server-embedded hits)" : "FAIL");
process.exit(ok ? 0 : 1);
