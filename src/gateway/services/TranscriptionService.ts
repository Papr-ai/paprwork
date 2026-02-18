/**
 * TranscriptionService - Audio transcription using provider APIs
 *
 * Supports OpenAI Whisper and potentially other providers.
 * Ported from Paprwork v1 meeting transcription pipeline.
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";

// ---------- Types ----------

export interface TranscriptionResult {
  text: string;
  segments?: TranscriptionSegment[];
  duration?: number;
  language?: string;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionOptions {
  language?: string;
  prompt?: string;
  /** "json" | "verbose_json" | "text" */
  responseFormat?: string;
}

// ---------- Service ----------

let transcriptionServiceInstance: TranscriptionService | null = null;

export class TranscriptionService {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(os.homedir(), "PAPR", "data", "transcriptions");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true });
    console.log("[TranscriptionService] Initialized");
  }

  /**
   * Transcribe audio from a file path using the OpenAI Whisper API.
   * Requires an OpenAI API key.
   */
  async transcribeFile(
    filePath: string,
    apiKey: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const audioBuffer = await fs.readFile(filePath);
    return this.transcribeBuffer(audioBuffer, path.basename(filePath), apiKey, options);
  }

  /**
   * Transcribe audio from a buffer using the OpenAI Whisper API.
   */
  async transcribeBuffer(
    buffer: Buffer,
    filename: string,
    apiKey: string,
    options?: TranscriptionOptions,
  ): Promise<TranscriptionResult> {
    const formData = new FormData();
    const arrayBuf = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const blob = new Blob([arrayBuf], { type: this.mimeTypeFromFilename(filename) });
    formData.append("file", blob, filename);
    formData.append("model", "whisper-1");

    if (options?.language) formData.append("language", options.language);
    if (options?.prompt) formData.append("prompt", options.prompt);
    formData.append("response_format", options?.responseFormat ?? "verbose_json");

    const response = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as Record<string, unknown>;
    return this.parseWhisperResponse(data);
  }

  /**
   * Save a transcription result to a file for archiving.
   */
  async saveTranscription(
    meetingId: string,
    result: TranscriptionResult,
  ): Promise<string> {
    const filePath = path.join(this.tempDir, `${meetingId}.json`);
    await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
    return filePath;
  }

  /**
   * Load a previously saved transcription.
   */
  async loadTranscription(
    meetingId: string,
  ): Promise<TranscriptionResult | null> {
    const filePath = path.join(this.tempDir, `${meetingId}.json`);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as TranscriptionResult;
    } catch {
      return null;
    }
  }

  /**
   * Generate a brief summary of the transcription text.
   * In production this would call a summarization API;
   * for now it returns the first ~500 chars as a preview.
   */
  generateQuickSummary(text: string): string {
    if (text.length <= 500) return text;
    return text.slice(0, 500).trimEnd() + "...";
  }

  // ===== Private helpers =====

  private parseWhisperResponse(
    data: Record<string, unknown>,
  ): TranscriptionResult {
    const text = (data.text as string) ?? "";
    const duration = (data.duration as number | undefined);
    const language = (data.language as string | undefined);
    const rawSegments = data.segments as Array<Record<string, unknown>> | undefined;

    const segments: TranscriptionSegment[] | undefined = rawSegments?.map((s) => ({
      start: s.start as number,
      end: s.end as number,
      text: s.text as string,
    }));

    return { text, segments, duration, language };
  }

  private mimeTypeFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".mp3": "audio/mpeg",
      ".mp4": "audio/mp4",
      ".m4a": "audio/mp4",
      ".wav": "audio/wav",
      ".webm": "audio/webm",
      ".ogg": "audio/ogg",
      ".flac": "audio/flac",
    };
    return mimeMap[ext] ?? "application/octet-stream";
  }
}

// ===== Singleton =====

export function getTranscriptionService(): TranscriptionService {
  if (!transcriptionServiceInstance) {
    transcriptionServiceInstance = new TranscriptionService();
  }
  return transcriptionServiceInstance;
}
