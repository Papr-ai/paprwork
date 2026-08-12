/**
 * One file row.
 *
 * At rest: a state dot, a name, a size. That is what someone scans a list for.
 * Actions appear on hover — three permanent controls per row is noise that
 * grows with the file count, and the row's own text stops being readable.
 *
 * Privacy is a lock toggle rather than a labelled checkbox. It is a state the
 * file is in, not a form field, and a lock says that in one glyph.
 */

import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema";
import {
  canEvict,
  describeFileState,
  formatBytes,
  glyphForFile,
  uploadPercent,
} from "../../utils/appFilesFormat";

interface AppFileRowItemProps {
  file: AppFileRow;
  busy: boolean;
  onTogglePrivate: (isPrivate: boolean) => void;
  onEvict: () => void;
  onRemove: () => void;
}

/** Four states, four shapes — never colour alone. */
function StateDot({ file }: { file: AppFileRow }) {
  const glyph = glyphForFile(file);
  const label = describeFileState(file);
  return (
    <svg
      className={`app-file__dot app-file__dot--${glyph}`}
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle cx="4" cy="4" r="3" fill={glyph === "filled" ? "currentColor" : "none"} />
      {glyph === "slashed" && <line x1="1.5" y1="6.5" x2="6.5" y2="1.5" />}
    </svg>
  );
}

function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="3" y="6.5" width="8" height="5.5" rx="1.2" />
      {/* Open shackle when unlocked: the shape itself carries the state. */}
      <path d={locked ? "M5 6.5V4.5a2 2 0 0 1 4 0v2" : "M5 6.5V4.5a2 2 0 0 1 4 0"} />
    </svg>
  );
}

export function AppFileRowItem({
  file,
  busy,
  onTogglePrivate,
  onEvict,
  onRemove,
}: AppFileRowItemProps) {
  const isPrivate = file.visibility === "private";
  const percent = uploadPercent(file);

  return (
    <li className={`app-file${busy ? " app-file--busy" : ""}`}>
      <StateDot file={file} />

      <span className="app-file__name" title={file.file_name}>
        {file.file_name}
      </span>

      <span className="app-file__size">
        {percent === null ? formatBytes(file.size_bytes) : `${percent}%`}
      </span>

      <div className="app-file__actions">
        <button
          type="button"
          className={`app-file__icon${isPrivate ? " app-file__icon--on" : ""}`}
          disabled={busy}
          aria-pressed={isPrivate}
          onClick={() => onTogglePrivate(!isPrivate)}
          title={isPrivate ? "Private — never published" : "Published with the app"}
        >
          <LockIcon locked={isPrivate} />
        </button>

        {canEvict(file) && (
          <button
            type="button"
            className="app-file__text-action"
            disabled={busy}
            onClick={onEvict}
            title="Delete the copy on this Mac. The cloud copy is kept."
          >
            Free
          </button>
        )}

        <button
          type="button"
          className="app-file__text-action app-file__text-action--danger"
          disabled={busy}
          onClick={onRemove}
          title="Delete everywhere"
        >
          Remove
        </button>
      </div>

      {/* A hairline that fills. On a multi-GB upload, motion is what says
          "working" — a number alone reads as frozen between updates. */}
      {percent !== null && (
        <span className="app-file__progress" style={{ width: `${percent}%` }} />
      )}
    </li>
  );
}
