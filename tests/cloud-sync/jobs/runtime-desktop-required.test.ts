import { describe, expect, test } from "vitest";
import { parseDesktopRequired } from "../../../src/gateway/services/appRuntime/memoryRuntimeClient.js";

describe("parseDesktopRequired", () => {
  test("reads FastAPI {detail} 409 bodies from memory", () => {
    const body = parseDesktopRequired(
      JSON.stringify({
        detail: {
          error: "desktop_required",
          message: "Studio Engine only runs in Papr Work desktop — reads files on your mac.",
          jobId: "j1",
          jobName: "Studio Engine",
          reason: "Reads files on your Mac",
          downloadUrl: "https://papr.ai/download",
        },
      }),
    );
    expect(body?.jobName).toBe("Studio Engine");
    expect(body?.reason).toBe("Reads files on your Mac");
  });

  test("ignores other errors", () => {
    expect(parseDesktopRequired(JSON.stringify({ detail: "Job not found" }))).toBeNull();
    expect(parseDesktopRequired("not json")).toBeNull();
  });
});
