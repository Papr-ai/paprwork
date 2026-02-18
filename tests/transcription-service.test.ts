import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { TranscriptionService } from "../src/gateway/services/TranscriptionService.js";
import type { TranscriptionResult } from "../src/gateway/services/TranscriptionService.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function createService(root: string): TranscriptionService {
  const svc = new TranscriptionService();
  // Override private tempDir to use temp dir
  Object.defineProperty(svc, "tempDir", {
    value: path.join(root, "transcriptions"),
    writable: true,
  });
  return svc;
}

describe("TranscriptionService", () => {
  test("initializes and creates temp directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trans-test-"));
    tmpRoots.push(root);

    const service = createService(root);
    await service.initialize();

    const stat = await fs.stat(path.join(root, "transcriptions"));
    expect(stat.isDirectory()).toBe(true);
  });

  test("saves and loads transcription", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trans-save-"));
    tmpRoots.push(root);

    const service = createService(root);
    await service.initialize();

    const result: TranscriptionResult = {
      text: "Hello, this is a test transcription.",
      segments: [{ start: 0, end: 5, text: "Hello, this is a test transcription." }],
      duration: 5.2,
      language: "en",
    };

    const filePath = await service.saveTranscription("meeting-123", result);
    expect(filePath).toContain("meeting-123.json");

    const loaded = await service.loadTranscription("meeting-123");
    expect(loaded).not.toBeNull();
    expect(loaded!.text).toBe("Hello, this is a test transcription.");
    expect(loaded!.segments).toHaveLength(1);
    expect(loaded!.duration).toBe(5.2);
    expect(loaded!.language).toBe("en");
  });

  test("returns null for non-existent transcription", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trans-miss-"));
    tmpRoots.push(root);

    const service = createService(root);
    await service.initialize();

    const result = await service.loadTranscription("non-existent");
    expect(result).toBeNull();
  });

  test("generateQuickSummary truncates long text", () => {
    const root = "/tmp/unused";
    const service = createService(root);

    const shortText = "Short text.";
    expect(service.generateQuickSummary(shortText)).toBe("Short text.");

    const longText = "A".repeat(600);
    const summary = service.generateQuickSummary(longText);
    expect(summary.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  test("transcribeBuffer calls Whisper API correctly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trans-api-"));
    tmpRoots.push(root);

    const service = createService(root);
    await service.initialize();

    // Mock fetch
    const mockResponse = {
      ok: true,
      json: async () => ({
        text: "Hello world",
        duration: 2.5,
        language: "en",
        segments: [{ start: 0, end: 2.5, text: "Hello world" }],
      }),
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse as unknown as Response,
    );

    const buffer = Buffer.from("fake audio data");
    const result = await service.transcribeBuffer(buffer, "test.mp3", "sk-test-key");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((options as RequestInit).method).toBe("POST");
    expect(
      ((options as RequestInit).headers as Record<string, string>).Authorization,
    ).toBe("Bearer sk-test-key");

    expect(result.text).toBe("Hello world");
    expect(result.duration).toBe(2.5);
    expect(result.language).toBe("en");
  });

  test("transcribeBuffer throws on API error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-trans-err-"));
    tmpRoots.push(root);

    const service = createService(root);
    await service.initialize();

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as unknown as Response);

    const buffer = Buffer.from("fake audio data");
    await expect(
      service.transcribeBuffer(buffer, "test.mp3", "bad-key"),
    ).rejects.toThrow("Whisper API error (401): Unauthorized");
  });
});
