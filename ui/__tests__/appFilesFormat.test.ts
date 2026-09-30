/**
 * Tests for App Files display logic.
 *
 * These cover the honesty rules: progress that reads as moving, an ETA that
 * refuses to guess, and a "free space" figure that can never include a file
 * whose only copy is local.
 */

import { describe, expect, it } from "vitest";
import type { AppFileRow } from "../../src/gateway/services/appFiles/appFilesSchema";
import {
  canEvict,
  describeFileState,
  formatBytes,
  formatEta,
  formatProgressLine,
  formatRate,
  glyphForFile,
  reclaimableBytes,
  totalBytes,
  uploadPercent,
} from "../utils/appFilesFormat";

const GB = 1024 ** 3;

function row(over: Partial<AppFileRow> = {}): AppFileRow {
  return {
    id: "f1",
    app_id: "app-1",
    object_key: "namespaces/n/apps/a/files/sha",
    sha256: "sha",
    size_bytes: 6.7 * GB,
    mime: "video/mp4",
    file_name: "standup.mp4",
    scope: "app",
    local_path: "/Users/x/standup.mp4",
    upload_state: "verified",
    visibility: "inherit",
    upload_session_uri: null,
    bytes_uploaded: 0,
    session_expires_at: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  } as AppFileRow;
}

describe("formatBytes", () => {
  it("uses the unit a human would say", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(6.7 * GB)).toBe("6.7 GB");
  });

  it("drops the decimal once it stops carrying information", () => {
    // "137.0 GB" is noise; "137 GB" is the same fact, read faster.
    expect(formatBytes(137 * GB)).toBe("137 GB");
  });
});

describe("formatEta", () => {
  it("scales the unit to the wait", () => {
    expect(formatEta(45)).toBe("~45 sec");
    expect(formatEta(480)).toBe("~8 min");
    expect(formatEta(9000)).toBe("~2.5 h");
  });

  it("returns null rather than inventing a number", () => {
    // An ETA from too few samples swings between 2 min and 4 h, which reads as
    // a broken upload. No number is more honest than a wrong one.
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0)).toBeNull();
    expect(formatEta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatProgressLine", () => {
  it("shows bytes moved, rate and ETA together", () => {
    // The requirement's example line: enough to answer "is it moving, and when
    // does it end" without doing arithmetic.
    const line = formatProgressLine(4.2 * GB, 6.7 * GB, 5.3 * 1024 * 1024, 480);
    expect(line).toBe("4.2 GB / 6.7 GB · 5.3 MB/s · ~8 min");
  });

  it("omits rate and ETA before they are known", () => {
    // At the very start there is no honest rate to show, so the line is just
    // the byte counts rather than "0 B/s", which reads as stalled.
    expect(formatProgressLine(0, 6.7 * GB, 0, null)).toBe("0 B / 6.7 GB");
  });
});

describe("formatRate", () => {
  it("renders a dash rather than a misleading zero", () => {
    expect(formatRate(0)).toBe("—");
  });
});

describe("glyphForFile", () => {
  it("distinguishes all four states by shape, not colour", () => {
    expect(glyphForFile(row())).toBe("filled");
    expect(glyphForFile(row({ local_path: null }))).toBe("hollow");
    expect(glyphForFile(row({ upload_state: "uploading" }))).toBe("ring");
    expect(glyphForFile(row({ upload_state: "failed" }))).toBe("slashed");
  });
});

describe("describeFileState", () => {
  it("says where the bytes are in plain language", () => {
    expect(describeFileState(row())).toBe("On this Mac and in the cloud");
    expect(describeFileState(row({ local_path: null }))).toBe("In the cloud");
  });

  it("frames a failed upload as recoverable, because it is", () => {
    // The session URI survives for 7 days, so "failed" really does mean
    // "will resume" — saying otherwise would invite a needless re-upload.
    expect(describeFileState(row({ upload_state: "failed" }))).toBe(
      "Upload failed — will resume",
    );
  });
});

describe("reclaimableBytes", () => {
  it("counts only files with a verified cloud copy", () => {
    const rows = [
      row({ id: "a", size_bytes: 2 * GB }),
      row({ id: "b", size_bytes: 3 * GB }),
    ];
    expect(reclaimableBytes(rows)).toBe(5 * GB);
  });

  it("never offers to free a file whose only copy is local", () => {
    // The unforgivable bug: reporting space as reclaimable when freeing it
    // would destroy the user's only copy.
    const rows = [
      row({ id: "a", upload_state: "uploading", size_bytes: 9 * GB }),
      row({ id: "b", upload_state: "failed", size_bytes: 9 * GB }),
      row({ id: "c", upload_state: "pending", size_bytes: 9 * GB }),
    ];
    expect(reclaimableBytes(rows)).toBe(0);
  });

  it("ignores files already evicted", () => {
    expect(reclaimableBytes([row({ local_path: null })])).toBe(0);
  });
});

describe("totalBytes", () => {
  it("sums everything stored, whatever its state", () => {
    // The header number answers "how much is here", which includes files
    // still uploading — excluding them would make the total shrink as an
    // upload finishes, which is nonsense.
    const rows = [
      row({ id: "a", size_bytes: 2 * GB }),
      row({ id: "b", size_bytes: 3 * GB, upload_state: "uploading" }),
    ];
    expect(totalBytes(rows)).toBe(5 * GB);
  });

  it("is zero for an empty app", () => {
    expect(totalBytes([])).toBe(0);
  });
});

describe("uploadPercent", () => {
  it("reports whole percent while uploading", () => {
    expect(
      uploadPercent(
        row({ upload_state: "uploading", size_bytes: 100, bytes_uploaded: 42 }),
      ),
    ).toBe(42);
  });

  it("never shows 100% while bytes are still in flight", () => {
    // The most common way a progress bar lies: sitting at 100% through
    // verification, making the last seconds feel broken.
    expect(
      uploadPercent(
        row({ upload_state: "uploading", size_bytes: 100, bytes_uploaded: 100 }),
      ),
    ).toBe(99);
  });

  it("returns null for anything not uploading, so the row shows its size", () => {
    expect(uploadPercent(row())).toBeNull();
    expect(uploadPercent(row({ upload_state: "failed" }))).toBeNull();
  });

  it("does not divide by zero on an empty file", () => {
    expect(
      uploadPercent(row({ upload_state: "uploading", size_bytes: 0 })),
    ).toBe(0);
  });
});

describe("canEvict", () => {
  it("permits eviction only when a verified cloud copy exists", () => {
    expect(canEvict(row())).toBe(true);
    expect(canEvict(row({ upload_state: "uploading" }))).toBe(false);
    expect(canEvict(row({ local_path: null }))).toBe(false);
  });
});
