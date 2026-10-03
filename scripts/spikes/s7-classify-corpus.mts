import * as fs from "fs"; import * as path from "path"; import * as os from "os";
import { execSync } from "child_process";
(async () => {
  const { classifyMigrationSql } = await import(path.resolve("src/gateway/services/jobs/migrationBreakingClassifier.ts"));
  const root = path.join(os.homedir(), "Papr/orgs/Y8D4H7Yp3Z/namespaces/85ZIB7mD1V");
  const files = execSync(`find . -path '*/migrations/*.sql' -not -path '*/node_modules/*' -not -path './backups/*'`, { cwd: root, encoding: "utf8" }).trim().split("\n");
  // dedupe identical content (same migration copied into data/ and apps/)
  const seen = new Map<string, string>();
  for (const f of files) { const c = fs.readFileSync(path.join(root, f), "utf8"); if (!seen.has(c)) seen.set(c, f); }
  const kinds: Record<string, number> = {}; let breaking = 0;
  const rawHit = /\bDROP\s+(TABLE|COLUMN|VIEW|TRIGGER)\b|\bRENAME\b/i;
  const disagreements: string[] = []; const samples: string[] = [];
  for (const [sql, f] of seen) {
    const r = classifyMigrationSql(sql);
    if (r.breaking) { breaking++; for (const c of r.changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1; samples.push(`${f}: ${r.changes.map((c: any) => `${c.kind}(${c.table}${c.detail ? " " + c.detail : ""})`).join(", ")}`); }
    if (rawHit.test(sql) && !r.breaking) disagreements.push(`${f}: ${(sql.match(new RegExp(".{0,60}(" + rawHit.source + ").{0,60}", "i")) ?? [""])[0].replace(/\s+/g, " ")}`);
  }
  console.log(`files ${files.length}, unique ${seen.size}, breaking ${breaking}`, kinds);
  console.log("\n-- keyword present but classified additive (check for misses):"); disagreements.forEach((d) => console.log("  " + d));
  console.log("\n-- breaking:"); samples.forEach((s) => console.log("  " + s));
})();
