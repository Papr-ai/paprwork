/**
 * Fork vs collaborate modal for installing a cloud catalog app locally.
 */

import type { CommunityCatalogEntry } from "../../../src/core/types/communityCatalog";
import type { CloudInstallMode } from "../../utils/cloudCatalogInstall";
import "./CommunityAppsView.css";

interface CloudCatalogInstallModalProps {
  entry: CommunityCatalogEntry;
  installing: boolean;
  onClose: () => void;
  onSelectMode: (mode: CloudInstallMode) => void;
}

export function CloudCatalogInstallModal({
  entry,
  installing,
  onClose,
  onSelectMode,
}: CloudCatalogInstallModalProps) {
  return (
    <div
      className="community-install-modal__backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="community-install-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-catalog-install-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="cloud-catalog-install-title" className="community-install-modal__title">
          Customize {entry.name}
        </h3>
        <p className="community-install-modal__desc">
          Install this app in your Papr Work workspace to edit locally or contribute
          changes back to the owner.
        </p>
        <button
          type="button"
          className="community-install-modal__option"
          disabled={installing}
          onClick={() => onSelectMode("fork")}
        >
          <strong>Fork</strong>
          <span>Independent copy — edit freely, send changes back to owner.</span>
        </button>
        <button
          type="button"
          className="community-install-modal__option"
          disabled={installing}
          onClick={() => onSelectMode("track")}
        >
          <strong>Collaborate and get updates</strong>
          <span>
            Stay connected to the publisher and pull their updates when you&apos;re
            ready.
          </span>
        </button>
        <button
          type="button"
          className="community-install-modal__cancel"
          onClick={onClose}
          disabled={installing}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
