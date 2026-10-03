import * as path from "path"; import * as os from "os"; import * as fs from "fs";
(async () => {
  const paprDir = path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");
  const appId = "7d31c757-faac-46af-8047-1d9503f45070";
  const dir = path.join(paprDir, "apps", appId);
  const files: { path: string; content: string }[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.statSync(p).size < 2e6) files.push({ path: path.relative(dir, p), content: fs.readFileSync(p).toString("base64") }); } };
  walk(dir);
  const bytes = files.reduce((a, f) => a + f.content.length, 0);
  let t = performance.now(); const body = JSON.stringify({ appId, files }); const ms = performance.now() - t;
  const crypto = await import("crypto"); t = performance.now(); for (const f of files) crypto.createHash("sha1").update(f.content).digest("hex"); const hms = performance.now() - t;
  console.log(`ALL ${files.length} files, ${(bytes/1e6).toFixed(1)}MB b64 -> stringify ${ms.toFixed(0)}ms (body ${(body.length/1e6).toFixed(1)}MB), sha1 all ${hms.toFixed(0)}ms`);
})();
