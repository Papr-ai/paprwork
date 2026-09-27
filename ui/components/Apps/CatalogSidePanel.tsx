/**
 * Team / Community app side panel. Replaces the inline "Details" toggle and the
 * install pop-up: everything needed to decide — who shared it, who can open it,
 * what keys it needs (and which you already saved), copies you already have —
 * sits next to the install choices, so choosing doesn't hide the context.
 */
import { useEffect } from "react";
import type {
  CommunityCatalogEntry,
  CommunityCatalogScope,
} from "../../../src/core/types/communityCatalog";
import { normalizeRequirements } from "../../../src/core/types/bundles";
import { lookupService } from "../../../src/core/data/knownServices";
import {
  cloudCatalogInstallOptionKey,
  getCloudCatalogInstallModeOptions,
  requiresInstallModeChoice,
} from "../../../src/core/utils/cloudCatalogInstallPolicy";
import type { CloudCatalogInstallSelection } from "../../utils/cloudCatalogInstall";
import { getCatalogByline } from "../../utils/communityCatalogDisplay";
import { shareGlyphForCatalogEntry } from "../../utils/shareGlyph";
import { shareAudienceShortLabel } from "../../utils/shareAudienceGlyphs";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { ShareAudienceIcon } from "./WebSyncPopover";
import "./CatalogSidePanel.css";

interface CatalogSidePanelProps {
  entry: CommunityCatalogEntry;
  scope: CommunityCatalogScope;
  localAppId: string | null;
  installedForkCount: number;
  canInstall: boolean;
  installing: boolean;
  onClose: () => void;
  onOpen?: () => void;
  onInstall: (selection: CloudCatalogInstallSelection) => void;
  onOssImport: () => void;
}

export function CatalogSidePanel(props: CatalogSidePanelProps) {
  const { entry, scope, localAppId, installing } = props;
  // Key names only (never values). Mounting the panel is what triggers the
  // keychain read, so browsing the grid never pays for it.
  const { keys } = useCustomKeys();
  const saved = new Set(keys.map((k) => k.name));
  const requirements = normalizeRequirements(entry.requirements ?? []);
  const share = shareGlyphForCatalogEntry(entry);
  const choice = requiresInstallModeChoice({
    catalogScope: scope,
    visibility: entry.visibility,
    codeInstallable: entry.codeInstallable === true,
  });
  const options = choice
    ? getCloudCatalogInstallModeOptions({
        catalogScope: scope,
        visibility: entry.visibility,
        codeInstallable: entry.codeInstallable === true,
      })
    : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <>
      <div className="catalog-panel__scrim" onClick={props.onClose} />
      <aside className="catalog-panel" role="dialog" aria-label={entry.name}>
        <button
          type="button"
          className="catalog-panel__close"
          aria-label="Close"
          onClick={props.onClose}
        >
          ×
        </button>
        <h2 className="catalog-panel__title">{entry.name}</h2>
        <div className="catalog-panel__byline">
          <span className="community-card__share">
            <ShareAudienceIcon
              audience={share.audience}
              loginAccess={null}
              codeAccess={share.codeAccess}
            />
          </span>
          <span>
            {getCatalogByline(entry)} ·{" "}
            {shareAudienceShortLabel(share.audience)}
            {share.codeAccess === "install" ? " · can copy the code" : ""}
          </span>
        </div>
        {entry.description ? (
          <p className="catalog-panel__desc">{entry.description}</p>
        ) : null}
        {entry.catalogAutomation?.cardLine ? (
          <p className="catalog-panel__automation">
            {entry.catalogAutomation.cardLine}
          </p>
        ) : null}

        {props.installedForkCount > 0 || localAppId ? (
          <div className="catalog-panel__note">
            {localAppId ? "Already in your library." : null}
            {props.installedForkCount > 0
              ? ` You have ${props.installedForkCount} ${props.installedForkCount === 1 ? "copy" : "copies"}.`
              : null}
          </div>
        ) : null}

        <h3 className="catalog-panel__section">What it needs</h3>
        {requirements.length === 0 ? (
          <p className="catalog-panel__ok">No API keys needed</p>
        ) : (
          <ul className="catalog-panel__keys">
            {requirements.map((r) => {
              const have = saved.has(r.name);
              return (
                <li key={r.name}>
                  <span>{lookupService(r.name)?.service ?? r.name}</span>
                  <span
                    className={
                      have ? "catalog-panel__ok" : "catalog-panel__todo"
                    }
                  >
                    {have ? "Saved" : "You'll add this"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        <div className="catalog-panel__actions">
          {props.onOpen ? (
            <button
              type="button"
              className="catalog-panel__btn catalog-panel__btn--primary"
              onClick={props.onOpen}
            >
              {localAppId ? "Open" : "Open in web"}
            </button>
          ) : null}
          {entry.source !== "cloud" ? (
            <button
              type="button"
              className="catalog-panel__btn"
              onClick={props.onOssImport}
            >
              Import
            </button>
          ) : props.canInstall && !choice ? (
            <button
              type="button"
              className="catalog-panel__btn"
              disabled={installing}
              onClick={() =>
                props.onInstall({ mode: "fork", installDbPolicy: "fork_empty" })
              }
            >
              {installing ? "Installing…" : "Personalize"}
            </button>
          ) : null}
        </div>

        {entry.source === "cloud" && props.canInstall && choice ? (
          <>
            <h3 className="catalog-panel__section">Personalize</h3>
            {options.map((option) => (
              <button
                key={cloudCatalogInstallOptionKey(option)}
                type="button"
                className="community-install-modal__option"
                disabled={installing}
                onClick={() =>
                  props.onInstall({
                    mode: option.mode,
                    installDbPolicy: option.installDbPolicy,
                  })
                }
              >
                <strong>{option.label}</strong>
                <span>{option.description}</span>
              </button>
            ))}
            {installing ? (
              <p className="catalog-panel__ok">Installing…</p>
            ) : null}
          </>
        ) : null}
      </aside>
    </>
  );
}
