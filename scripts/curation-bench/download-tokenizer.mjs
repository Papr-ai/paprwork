// Fetch only the tokenizer files of the pinned papr-embed-code-1-0.6b revision (export-chunks needs them, not the model).
//   node scripts/curation-bench/download-tokenizer.mjs <modelRoot>
import * as fs from "fs";
import * as path from "path";
const [root] = process.argv.slice(2);
const src = fs.readFileSync("src/core/tools/codeEmbed/embedder.ts", "utf8");
const rev = src.match(/HF_REVISION = "([0-9a-f]+)"/)[1];
const dir = path.join(root, "models", "papr-embed-code-1-0.6b");
fs.mkdirSync(dir, { recursive: true });
for (const f of ["tokenizer.json", "tokenizer_config.json"]) {
  const r = await fetch(`https://huggingface.co/papr-ai/papr-embed-code-1-0.6b/resolve/${rev}/${f}`);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  fs.writeFileSync(path.join(dir, f), Buffer.from(await r.arrayBuffer()));
}
console.log(`tokenizer ${rev.slice(0, 8)} -> ${dir}`);
