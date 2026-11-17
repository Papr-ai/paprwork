// Curation Bench, step 1 of 3: cut every corpus file into the chunks the desktop indexer would embed.
//   tsx scripts/curation-bench/export-chunks.mts <dataDir> <modelRoot>
// Uses the shipped chunker (chunkFile) and the shipped tokenizer, so the vectors built from chunks.jsonl.gz on a GPU
// are the vectors a Mac would have built. Writes <dataDir>/chunks.jsonl.gz: {blob, chunk, line_start, line_end, text}.
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as readline from "readline";
import { chunkFile } from "../../src/core/tools/codeEmbed/chunker.js";
import { isIndexable } from "../../src/core/tools/codeEmbed/codeIndexer.js";
import { modelDir } from "../../src/core/tools/codeEmbed/embedder.js";

const [dataDir, modelRoot] = process.argv.slice(2) as [string, string];
const { Tokenizer }: any = await import("@huggingface/tokenizers");
const md = modelDir(modelRoot);
const tok = new Tokenizer(
  JSON.parse(fs.readFileSync(path.join(md, "tokenizer.json"), "utf8")),
  JSON.parse(fs.readFileSync(path.join(md, "tokenizer_config.json"), "utf8")),
);
const count = (s: string) => tok.encode(s, { add_special_tokens: false }).ids.length;

const out = zlib.createGzip();
out.pipe(fs.createWriteStream(path.join(dataDir, "chunks.jsonl.gz")));
const rl = readline.createInterface({ input: fs.createReadStream(path.join(dataDir, "blobs.jsonl.gz")).pipe(zlib.createGunzip()) });
let blobs = 0, chunks = 0, skipped = 0;
for await (const line of rl) {
  const b = JSON.parse(line) as { blob: string; path: string; text: string };
  if (!isIndexable(b.path, Buffer.byteLength(b.text))) { skipped++; continue; }
  for (const c of chunkFile(b.path, b.text, count)) {
    if (!out.write(JSON.stringify({ blob: b.blob, chunk: c.chunk, line_start: c.lineStart, line_end: c.lineEnd, text: c.text }) + "\n"))
      await new Promise((r) => out.once("drain", r));
    chunks++;
  }
  if (++blobs % 1000 === 0) console.log(`${blobs} blobs, ${chunks} chunks`);
}
out.end();
await new Promise((r) => out.on("end", r));
console.log(JSON.stringify({ blobs, chunks, skipped }));
