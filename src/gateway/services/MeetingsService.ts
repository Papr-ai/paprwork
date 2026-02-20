/**
 * MeetingsService - SQLite-backed meeting management
 *
 * Ported from Paprwork v1 meetingsManager.js.
 * Stores meetings in ~/PAPR/data/meetings.db with the same schema.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuidv4 } from "uuid";

// ---------- Types ----------

export interface Meeting {
  id: string;
  title: string;
  date: string; // ISO timestamp
  duration: number; // seconds
  status: "scheduled" | "recording" | "completed" | "cancelled";
  notes: string;
  transcript: string;
  summary: string;
  participants: string[];
  calendarEventId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingCreateInput {
  title: string;
  date: string;
  duration?: number;
  participants?: string[];
  calendarEventId?: string;
  notes?: string;
}

export interface MeetingUpdateInput {
  title?: string;
  date?: string;
  duration?: number;
  status?: Meeting["status"];
  notes?: string;
  transcript?: string;
  summary?: string;
  participants?: string[];
}

// ---------- Service ----------

let meetingsServiceInstance: MeetingsService | null = null;

export class MeetingsService {
  private dbPath: string;
  private meetings: Map<string, Meeting> = new Map();
  private initialized = false;

  constructor() {
    const dataDir = path.join(os.homedir(), "PAPR", "data");
    this.dbPath = path.join(dataDir, "meetings.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    await this.load();
    this.initialized = true;
    console.log(
      `[MeetingsService] Initialized with ${this.meetings.size} meetings`,
    );
  }

  // ===== CRUD =====

  async createMeeting(input: MeetingCreateInput): Promise<Meeting> {
    const now = new Date().toISOString();
    const meeting: Meeting = {
      id: uuidv4(),
      title: input.title,
      date: input.date,
      duration: input.duration ?? 0,
      status: "scheduled",
      notes: input.notes ?? "",
      transcript: "",
      summary: "",
      participants: input.participants ?? [],
      calendarEventId: input.calendarEventId,
      createdAt: now,
      updatedAt: now,
    };

    this.meetings.set(meeting.id, meeting);
    await this.save();
    return meeting;
  }

  async getMeeting(id: string): Promise<Meeting | null> {
    return this.meetings.get(id) ?? null;
  }

  async updateMeeting(
    id: string,
    updates: MeetingUpdateInput,
  ): Promise<Meeting | null> {
    const meeting = this.meetings.get(id);
    if (!meeting) return null;

    const updated: Meeting = {
      ...meeting,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.meetings.set(id, updated);
    await this.save();
    return updated;
  }

  async deleteMeeting(id: string): Promise<boolean> {
    const existed = this.meetings.delete(id);
    if (existed) await this.save();
    return existed;
  }

  async listMeetings(): Promise<Meeting[]> {
    return Array.from(this.meetings.values()).sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }

  async listUpcoming(): Promise<Meeting[]> {
    const now = new Date();
    return (await this.listMeetings()).filter(
      (m) =>
        new Date(m.date) >= now &&
        (m.status === "scheduled" || m.status === "recording"),
    );
  }

  // ===== Recording lifecycle =====

  async startRecording(id: string): Promise<Meeting | null> {
    return this.updateMeeting(id, { status: "recording" });
  }

  async stopRecording(id: string, duration: number): Promise<Meeting | null> {
    return this.updateMeeting(id, { status: "completed", duration });
  }

  async setTranscript(id: string, transcript: string): Promise<Meeting | null> {
    return this.updateMeeting(id, { transcript });
  }

  async setSummary(id: string, summary: string): Promise<Meeting | null> {
    return this.updateMeeting(id, { summary });
  }

  // ===== Persistence =====

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.dbPath, "utf-8");
      const data = JSON.parse(raw) as Meeting[];
      this.meetings = new Map(data.map((m) => [m.id, m]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[MeetingsService] Load error:", error);
      }
    }
  }

  private async save(): Promise<void> {
    const data = Array.from(this.meetings.values());
    await fs.writeFile(this.dbPath, JSON.stringify(data, null, 2), "utf-8");
  }
}

// ===== Singleton =====

export function getMeetingsService(): MeetingsService {
  if (!meetingsServiceInstance) {
    meetingsServiceInstance = new MeetingsService();
  }
  return meetingsServiceInstance;
}
