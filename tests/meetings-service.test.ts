import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MeetingsService } from "../src/gateway/services/MeetingsService.js";

const tmpRoots: string[] = [];

afterEach(async () => {
  for (const root of tmpRoots.splice(0, tmpRoots.length)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function setupService(): Promise<MeetingsService> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-meetings-test-"));
  tmpRoots.push(root);

  // Point HOME to the temp dir so MeetingsService creates data there
  vi.stubEnv("HOME", root);

  const service = new MeetingsService();
  // Need to override private dbPath since constructor already ran with real HOME
  // Re-create with overridden env
  const svc = new (class extends MeetingsService {
    constructor() {
      super();
      // Access and override private field via Object.defineProperty
      Object.defineProperty(this, "dbPath", {
        value: path.join(root, "Papr", "data", "meetings.json"),
        writable: true,
      });
    }
  })();
  await svc.initialize();
  return svc;
}

describe("MeetingsService", () => {
  test("creates and lists meetings", async () => {
    const service = await setupService();
    const meeting = await service.createMeeting({
      title: "Weekly Standup",
      date: new Date().toISOString(),
      participants: ["Alice", "Bob"],
    });

    expect(meeting.id).toBeTruthy();
    expect(meeting.title).toBe("Weekly Standup");
    expect(meeting.status).toBe("scheduled");
    expect(meeting.participants).toEqual(["Alice", "Bob"]);

    const all = await service.listMeetings();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(meeting.id);
  });

  test("updates a meeting", async () => {
    const service = await setupService();
    const meeting = await service.createMeeting({
      title: "Team Sync",
      date: new Date().toISOString(),
    });

    // Small delay to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await service.updateMeeting(meeting.id, {
      title: "Team Sync v2",
      notes: "Discuss roadmap",
    });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Team Sync v2");
    expect(updated!.notes).toBe("Discuss roadmap");
    // Verify updatedAt is a valid ISO timestamp (may or may not differ depending on timing)
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(meeting.createdAt).getTime(),
    );
  });

  test("deletes a meeting", async () => {
    const service = await setupService();
    const meeting = await service.createMeeting({
      title: "Delete Me",
      date: new Date().toISOString(),
    });

    const deleted = await service.deleteMeeting(meeting.id);
    expect(deleted).toBe(true);

    const all = await service.listMeetings();
    expect(all).toHaveLength(0);
  });

  test("returns null when updating non-existent meeting", async () => {
    const service = await setupService();
    const result = await service.updateMeeting("non-existent", { title: "Nope" });
    expect(result).toBeNull();
  });

  test("returns false when deleting non-existent meeting", async () => {
    const service = await setupService();
    const result = await service.deleteMeeting("non-existent");
    expect(result).toBe(false);
  });

  test("lists upcoming meetings only", async () => {
    const service = await setupService();

    // Past meeting
    await service.createMeeting({
      title: "Past Meeting",
      date: new Date(Date.now() - 86400000).toISOString(),
    });

    // Future meeting
    const future = await service.createMeeting({
      title: "Future Meeting",
      date: new Date(Date.now() + 86400000).toISOString(),
    });

    // Completed meeting (future date but completed)
    const completed = await service.createMeeting({
      title: "Completed Meeting",
      date: new Date(Date.now() + 86400000 * 2).toISOString(),
    });
    await service.updateMeeting(completed.id, { status: "completed" });

    const upcoming = await service.listUpcoming();
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].id).toBe(future.id);
  });

  test("recording lifecycle: start and stop", async () => {
    const service = await setupService();
    const meeting = await service.createMeeting({
      title: "Recorded Meeting",
      date: new Date().toISOString(),
    });

    const recording = await service.startRecording(meeting.id);
    expect(recording!.status).toBe("recording");

    const stopped = await service.stopRecording(meeting.id, 300);
    expect(stopped!.status).toBe("completed");
    expect(stopped!.duration).toBe(300);
  });

  test("sets transcript and summary", async () => {
    const service = await setupService();
    const meeting = await service.createMeeting({
      title: "Transcription Test",
      date: new Date().toISOString(),
    });

    await service.setTranscript(meeting.id, "Hello world transcription");
    const withTranscript = await service.getMeeting(meeting.id);
    expect(withTranscript!.transcript).toBe("Hello world transcription");

    await service.setSummary(meeting.id, "Brief summary");
    const withSummary = await service.getMeeting(meeting.id);
    expect(withSummary!.summary).toBe("Brief summary");
  });

  test("persists data to disk", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "papr-meetings-persist-"));
    tmpRoots.push(root);
    const dbPath = path.join(root, "Papr", "data", "meetings.json");

    // Create and populate
    const svc1 = new (class extends MeetingsService {
      constructor() {
        super();
        Object.defineProperty(this, "dbPath", { value: dbPath, writable: true });
      }
    })();
    await svc1.initialize();
    await svc1.createMeeting({ title: "Persist Me", date: new Date().toISOString() });

    // Verify file exists
    const raw = await fs.readFile(dbPath, "utf-8");
    const data = JSON.parse(raw) as unknown[];
    expect(data).toHaveLength(1);

    // New instance should load persisted data
    const svc2 = new (class extends MeetingsService {
      constructor() {
        super();
        Object.defineProperty(this, "dbPath", { value: dbPath, writable: true });
      }
    })();
    await svc2.initialize();
    const all = await svc2.listMeetings();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Persist Me");
  });

  test("meetings sorted by date descending", async () => {
    const service = await setupService();

    await service.createMeeting({
      title: "Oldest",
      date: new Date(Date.now() - 86400000 * 3).toISOString(),
    });
    await service.createMeeting({
      title: "Newest",
      date: new Date(Date.now() + 86400000).toISOString(),
    });
    await service.createMeeting({
      title: "Middle",
      date: new Date().toISOString(),
    });

    const all = await service.listMeetings();
    expect(all[0].title).toBe("Newest");
    expect(all[1].title).toBe("Middle");
    expect(all[2].title).toBe("Oldest");
  });
});
