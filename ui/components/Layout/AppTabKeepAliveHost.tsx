import type { ReactNode } from "react";
import type { Tab } from "../../types/tabs";
import { MiniAppView } from "../Apps/MiniAppView";
import { CatalogPreviewTabView } from "../Apps/CatalogPreviewTabView";
import {
  readCloudCatalogPreviewTabMetadata,
  isCatalogPreviewEntityId,
} from "../../types/cloudCatalogPreviewTab";
import "./AppTabKeepAliveHost.css";

/** Where a kept-alive app preview is shown within ContentArea. */
export type AppTabKeepAlivePlacement = "full" | "left" | "right" | "hidden";

function renderAppTabContent(tab: Tab, previewTabVisible: boolean): ReactNode {
  if (
    readCloudCatalogPreviewTabMetadata(tab) ||
    isCatalogPreviewEntityId(tab.entityId)
  ) {
    return (
      <CatalogPreviewTabView tab={tab} previewTabVisible={previewTabVisible} />
    );
  }
  return <MiniAppView appId={tab.entityId} previewTabVisible={previewTabVisible} />;
}

interface AppTabKeepAliveHostProps {
  tab: Tab;
  placement: AppTabKeepAlivePlacement;
  /** False when the Paprwork window is backgrounded (alt-tab, minimize). */
  documentVisible?: boolean;
}

/**
 * One React instance per app tab for the lifetime of LRU mount.
 * Placement toggles visibility only — iframe never remounts on tab switch.
 */
export function AppTabKeepAliveHost({
  tab,
  placement,
  documentVisible = true,
}: AppTabKeepAliveHostProps) {
  const previewTabVisible = placement !== "hidden" && documentVisible;

  return (
    <div
      className={`content-pane__keep-alive content-pane__keep-alive--app content-pane__keep-alive--placement-${placement}`}
    >
      {renderAppTabContent(tab, previewTabVisible)}
    </div>
  );
}
