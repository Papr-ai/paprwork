/**
 * Publish-bar layout for live web / catalog preview tabs (URL row + primary action).
 */

import { PreviewUrlRow } from "./PreviewUrlRow";
import "./MiniAppPublishBar.css";

export interface MiniAppPreviewUrlBarPrimaryAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface MiniAppPreviewUrlBarProps {
  title: string;
  statusLabel: string;
  displayUrl?: string;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  refreshTitle?: string;
  onOpenInBrowser?: () => void;
  onCopyLink?: () => void;
  primaryAction?: MiniAppPreviewUrlBarPrimaryAction;
  toast?: string | null;
}

export function MiniAppPreviewUrlBar({
  title,
  statusLabel,
  displayUrl,
  onRefresh,
  refreshDisabled,
  refreshTitle,
  onOpenInBrowser,
  onCopyLink,
  primaryAction,
  toast,
}: MiniAppPreviewUrlBarProps) {
  const showUrlRow = Boolean(displayUrl && onOpenInBrowser && onCopyLink);

  return (
    <div className="mini-app-publish-bar">
      <div className="mini-app-publish-bar__left">
        <div className="mini-app-publish-bar__meta">
          <span className="mini-app-publish-bar__title">{title}</span>
          <span className="mini-app-publish-bar__status">{statusLabel}</span>
        </div>
      </div>

      {showUrlRow ? (
        <PreviewUrlRow
          displayUrl={displayUrl!}
          refreshTitle={refreshTitle}
          onRefresh={onRefresh}
          refreshDisabled={refreshDisabled}
          onOpenInBrowser={onOpenInBrowser!}
          onCopyLink={onCopyLink!}
        />
      ) : null}

      <div className="mini-app-publish-bar__actions">
        {toast ? (
          <span className="mini-app-publish-bar__toast">{toast}</span>
        ) : null}
        {primaryAction ? (
          <button
            type="button"
            className="mini-app-publish-bar__button mini-app-publish-bar__button--primary"
            disabled={primaryAction.disabled}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
