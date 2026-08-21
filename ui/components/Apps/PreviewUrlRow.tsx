/**
 * URL row with refresh / open / copy — shared by publish bar and catalog preview.
 */

function OpenExternalIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M10.5 2.5H13.5V5.5M8.5 7.5L13 3M6.5 3H3.5C2.95 3 2.5 3.45 2.5 4V12.5C2.5 13.05 2.95 13.5 3.5 13.5H12C12.55 13.5 13 13.05 13 12.5V9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 10.5H3.5C2.95 10.5 2.5 10.05 2.5 9.5V3.5C2.5 2.95 2.95 2.5 3.5 2.5H9.5C10.05 2.5 10.5 2.95 10.5 3.5V4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg className="share-sheet__icon" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M13.5 8a5.5 5.5 0 01-9.2 4M2.5 8a5.5 5.5 0 019.2-4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M11.5 2.5V5.5H8.5M4.5 13.5V10.5H7.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface PreviewUrlRowProps {
  displayUrl: string;
  refreshTitle?: string;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  onOpenInBrowser: () => void;
  onCopyLink: () => void;
}

export function PreviewUrlRow({
  displayUrl,
  refreshTitle = "Refresh preview",
  onRefresh,
  refreshDisabled = false,
  onOpenInBrowser,
  onCopyLink,
}: PreviewUrlRowProps) {
  return (
    <div className="mini-app-publish-bar__url-row">
      <span className="mini-app-publish-bar__url" title={displayUrl}>
        {displayUrl}
      </span>
      <button
        type="button"
        className="mini-app-publish-bar__icon-button"
        title={refreshTitle}
        aria-label="Refresh preview"
        disabled={refreshDisabled || !onRefresh}
        onClick={() => onRefresh?.()}
      >
        <RefreshIcon />
      </button>
      <button
        type="button"
        className="mini-app-publish-bar__icon-button"
        title="Open in browser"
        aria-label="Open in browser"
        onClick={onOpenInBrowser}
      >
        <OpenExternalIcon />
      </button>
      <button
        type="button"
        className="mini-app-publish-bar__icon-button"
        title="Copy link"
        aria-label="Copy link"
        onClick={onCopyLink}
      >
        <CopyIcon />
      </button>
    </div>
  );
}
