/**
 * Fork vs collaborate modal for installing a cloud catalog app locally.
 */

import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../../src/core/types/communityCatalog";
import { getCloudCatalogInstallModeOptions } from "../../../src/core/utils/cloudCatalogInstallPolicy";
import type { CloudInstallMode } from "../../utils/cloudCatalogInstall";
import "./CommunityAppsView.css";

interface CloudCatalogInstallModalProps {
  entry: CommunityCatalogEntry;
  catalogScope?: CommunityCatalogScope;
  installing: boolean;
  onClose: () => void;
  onSelectMode: (mode: CloudInstallMode) => void;
}

export function CloudCatalogInstallModal({
  entry,
  catalogScope = "namespace",
  installing,
  onClose,
  onSelectMode,
}: CloudCatalogInstallModalProps) {
  const teamTab = catalogScope === "namespace";
  const options = getCloudCatalogInstallModeOptions({
    catalogScope,
    visibility: entry.visibility,
    codeInstallable: entry.codeInstallable === true,
  });
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
          Personalize {entry.name}
        </h3>
        <p className="community-install-modal__desc">
          {teamTab
            ? "Install this team app locally. Choose whether you want your own database or the shared team database."
            : "Install an independent copy in your workspace. You get the app code and schema — not the publisher's live data."}
        </p>
        {options.map((option) => (
          <button
            key={option.mode}
            type="button"
            className="community-install-modal__option"
            disabled={installing}
            onClick={() => onSelectMode(option.mode)}
          >
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        ))}
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
