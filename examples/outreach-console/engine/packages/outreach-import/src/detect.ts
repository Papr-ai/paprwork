export type ImportFormat = 'csv' | 'xlsx' | 'html' | 'json';

export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
}

export const DEFAULT_LIMITS: ImportLimits = { maxBytes: 25 * 1024 * 1024, maxRows: 100_000 };

export class ImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
  }
}

/** Detects the format from magic bytes first, then the file name, then content sniffing. */
export function detectFormat(bytes: Uint8Array, fileName: string, declared?: ImportFormat): ImportFormat {
  if (declared) return declared;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  const extension = fileName.toLowerCase().split('.').pop() ?? '';
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'json' || extension === 'jsonl' || extension === 'ndjson') return 'json';
  if (extension === 'csv' || extension === 'tsv') return 'csv';
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith('<')) return 'html';
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  return 'csv';
}

export interface DecodedText {
  readonly text: string;
  readonly encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
  readonly warnings: string[];
}

/** BOM, then strict UTF-8, then Windows-1252 (never fails, so it is the fallback; flagged as a warning). */
export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', warnings: [] };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', warnings: [] };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', warnings: [] };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', warnings: [] };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      encoding: 'windows-1252',
      warnings: ['File is not valid UTF-8; decoded as Windows-1252. Check accented names in the preview.'],
    };
  }
}

/** One source row as column name -> raw string, plus where it came from. */
export interface RawRow {
  readonly locator: string;
  readonly values: Readonly<Record<string, string>>;
}
