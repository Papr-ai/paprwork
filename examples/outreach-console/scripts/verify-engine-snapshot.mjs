import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
export function verifyEngineSnapshot() {
  const manifest = JSON.parse(readFileSync(join(root, 'SOURCE-SNAPSHOT.json'), 'utf8'));
  assert.equal(manifest.source.commit, '13a7ffb75de3c5be017ce05d15e4115f191252d7');
  assert.equal(manifest.files.length, 272);
  const expected = new Set();
  let bytes = 0;
  for (const file of manifest.files) {
    assert.match(file.path, /^engine\/[A-Za-z0-9._/-]+$/);
    assert(!file.path.split('/').includes('..'));
    assert.equal(file.sourcePath, file.path.replace(/^engine\//, 'outreach-engine/'));
    assert.equal(file.mode, '100644');
    assert(!expected.has(file.path), `Duplicate ${file.path}`);
    expected.add(file.path);
    const path = join(root, file.path);
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), file.path);
    const content = readFileSync(path);
    assert.equal(content.length, file.bytes, file.path);
    assert.equal(digest('sha256', content), file.sha256, file.path);
    const gitBlob = Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]);
    assert.equal(digest('sha1', gitBlob), file.gitBlobSha1, file.path);
    bytes += content.length;
  }
  function walk(dir) {
    return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      assert(!entry.isSymbolicLink(), path);
      return entry.isDirectory() ? walk(path) : [path];
    });
  }
  assert.deepEqual(walk('engine').sort(), [...expected].sort(), 'Unexpected or missing snapshot files');
  assert.equal(bytes, manifest.totalBytes);
  return { files: expected.size, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyEngineSnapshot()));
}
