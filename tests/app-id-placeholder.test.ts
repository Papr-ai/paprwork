import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_ID_PLACEHOLDER,
  jobOwnedByApp,
  portableAppIdInText,
  primaryAppId,
  substituteAppIdPlaceholder,
} from "../src/gateway/services/jobs/appIdPlaceholder.js";

const OWN = "a3aaa6ce-d306-4b9f-93d7-dabee5c017cc";
const OTHER = "b973ace9-e0f8-4d26-97e3-bc021c8bbec0";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("{{papr.app_id}}", () => {
  it("fills in the job's own app at run time", () => {
    const text = `appId "${APP_ID_PLACEHOLDER}", alias "gtm"`;
    expect(substituteAppIdPlaceholder(text, [OWN])).toBe(`appId "${OWN}", alias "gtm"`);
    expect(substituteAppIdPlaceholder(text, [OTHER])).toBe(`appId "${OTHER}", alias "gtm"`);
  });

  it("replaces every occurrence and leaves other apps' ids alone", () => {
    const text = `${APP_ID_PLACEHOLDER} and ${APP_ID_PLACEHOLDER}; other app ${OTHER}`;
    expect(substituteAppIdPlaceholder(text, [OWN])).toBe(`${OWN} and ${OWN}; other app ${OTHER}`);
  });

  it("skips the standalone sentinel and leaves text alone when there is no app", () => {
    expect(primaryAppId(["__standalone__", OWN])).toBe(OWN);
    expect(substituteAppIdPlaceholder(`x ${APP_ID_PLACEHOLDER}`, ["__standalone__"])).toBe(`x ${APP_ID_PLACEHOLDER}`);
    expect(substituteAppIdPlaceholder("no placeholder here", [OWN])).toBe("no placeholder here");
  });

  it("converts only the exact own id to the placeholder", () => {
    const out = portableAppIdInText(`app ${OWN} then ${OTHER} then ${OWN}`, OWN);
    expect(out.replaced).toBe(2);
    expect(out.text).toBe(`app ${APP_ID_PLACEHOLDER} then ${OTHER} then ${APP_ID_PLACEHOLDER}`);
    expect(portableAppIdInText("nothing", OWN)).toEqual({ text: "nothing", replaced: 0 });
  });
});

describe("jobOwnedByApp", () => {
  const jobDir = (appIds: unknown) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "job-own-"));
    tmp.push(d);
    fs.writeFileSync(path.join(d, "job.json"), JSON.stringify({ id: "j", appIds }));
    return d;
  };

  it("true when the job lists the app", async () => {
    expect(await jobOwnedByApp(jobDir([OWN]), OWN)).toBe(true);
  });
  it("false when the job belongs only to a different app (the Prep-Notes case)", async () => {
    expect(await jobOwnedByApp(jobDir([OTHER]), OWN)).toBe(false);
  });
  it("true when unreadable, so a read error never drops a job", async () => {
    expect(await jobOwnedByApp(path.join(os.tmpdir(), "does-not-exist-xyz"), OWN)).toBe(true);
    expect(await jobOwnedByApp(jobDir("not-an-array"), OWN)).toBe(true);
  });
});
