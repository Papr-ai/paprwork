/**
 * One file row: glyph, name, state, and the actions that need a deliberate tap.
 *
 * Split from the panel because the row carries the two destructive actions,
 * and they deserve to be read in isolation. Both are explicit and neither is
 * ever triggered by a background process.
 */

import type { AppFileRow } from "../../../src/gateway/services/appFiles/appFilesSchema";
import {
  canEvict,
  describeFileState,
  formatBytes,
  glyphForFile,
  formatProgressLine,
} from "../../utils/appFilesFormat";

interface AppFileRowItemProps {
  file: AppFileRow;
  busy: boolean;
  onTogglePrivate: (isPrivate: boolean) => void;
  onEvict: () => void;
  onRemove: () => void;
}

/** Four states, four shapes — never colour alone. */
function StateGlyph({ file }: { file: AppFileRow }) {
  const glyph = glyphForFile(file);
  const label = describeFileState(file);
  return (
    <svg
      className={`app-file__glyph app-file__glyph--${glyph}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <circle
        cx="7"
        cy="7"
        r="5"
        fill={glyph === "filled" ? "currentColor" : "none"}
      />
      {glyph === "slashed" && <line x1="3" y1="11" x2="11" y2="3" />}
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
  const uploading = file.upload_state === "uploading";

  return (
    <li className="app-file">
      <StateGlyph file={file} />

      <div className="app-file__body">
        <span className="app-file__name">{file.file_name}</span>
        <span className="app-file__meta">
          {uploading
            ? // Bytes moved, not a bare percentage: on a multi-GB upload the
              // absolute numbers are what tell the user it is still moving.
              formatProgressLine(file.bytes_uploaded, file.size_bytes, 0, null)
            : `${formatBytes(file.size_bytes)} · ${describeFileState(file)}`}
        </span>
      </div>

      <label className="app-file__private" title="Never publish this file, even if the app is public">
        <input
          type="checkbox"
          checked={isPrivate}
          disabled={busy}
          onChange={(e) => onTogglePrivate(e.target.checked)}
        />
        Keep private
      </label>

      {canEvict(file) && (
        <button
          type="button"
          className="app-file__action"
          disabled={busy}
          onClick={onEvict}
          title="Delete the copy on this Mac. The cloud copy is kept."
        >
          Free space
        </button>
      )}

      <button
        type="button"
        className="app-file__action app-file__action--danger"
        disabled={busy}
        onClick={onRemove}
        title="Delete this file everywhere"
      >
        Remove
      </button>
    </li>
  );
}
