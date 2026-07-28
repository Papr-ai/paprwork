/**
 * Org scope picker for integration keys — current org, all orgs, or specific org.
 */

import React, { useMemo } from "react";
import type { IntegrationKeyOrgScope } from "../../types/settings";
import "./IntegrationKeyOrgScopeSelector.css";
import { IntegrationKeyFieldLabel } from "./IntegrationKeyOptionsRow";

export interface OrgScopeOption {
  organizationId: string;
  label: string;
}

export type IntegrationKeyScopeMode = "current" | "all" | "specific";

export interface IntegrationKeyOrgScopeValue {
  mode: IntegrationKeyScopeMode;
  organizationId?: string;
}

interface IntegrationKeyOrgScopeSelectorProps {
  value: IntegrationKeyOrgScopeValue;
  onChange: (value: IntegrationKeyOrgScopeValue) => void;
  currentOrganizationId?: string | null;
  /** Display name for the active Papr organization (e.g. Myadvice) */
  currentOrganizationLabel?: string | null;
  /** @deprecated Use currentOrganizationLabel */
  currentWorkspaceLabel?: string | null;
  organizations: OrgScopeOption[];
  disabled?: boolean;
  compact?: boolean;
  idPrefix?: string;
}

export function toOrgScopeInput(value: IntegrationKeyOrgScopeValue): {
  orgScope: IntegrationKeyOrgScope;
  organizationId?: string;
} {
  if (value.mode === "all") {
    return { orgScope: "all" };
  }
  return {
    orgScope: "organization",
    organizationId: value.organizationId,
  };
}

export function orgScopeValueFromKey(input: {
  orgScope?: IntegrationKeyOrgScope | "global";
  organizationId?: string;
  activeOrganizationId?: string | null;
}): IntegrationKeyOrgScopeValue {
  if (input.orgScope === "all") {
    return { mode: "all" };
  }
  const keyOrgId = input.organizationId;
  const activeOrgId = input.activeOrganizationId ?? undefined;
  if (keyOrgId && activeOrgId && keyOrgId !== activeOrgId) {
    return { mode: "specific", organizationId: keyOrgId };
  }
  return {
    mode: "current",
    organizationId: keyOrgId ?? activeOrgId,
  };
}

const MODE_HINTS: Record<IntegrationKeyScopeMode, string> = {
  current: "Key is available only in this organization's vault.",
  all: "Shared key — available in every organization you switch to.",
  specific: "Pick one organization vault even while viewing another.",
};

export function IntegrationKeyOrgScopeSelector({
  value,
  onChange,
  currentOrganizationId,
  currentOrganizationLabel,
  currentWorkspaceLabel,
  organizations,
  disabled = false,
  compact = false,
  idPrefix = "org-scope",
}: IntegrationKeyOrgScopeSelectorProps) {
  const currentLabel =
    currentOrganizationLabel?.trim() ||
    currentWorkspaceLabel?.trim() ||
    "This organization";

  const handleModeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const mode = event.target.value as IntegrationKeyScopeMode;
    if (mode === "all") {
      onChange({ mode: "all" });
      return;
    }
    if (mode === "current") {
      onChange({
        mode: "current",
        organizationId: currentOrganizationId ?? undefined,
      });
      return;
    }
    onChange({
      mode: "specific",
      organizationId:
        value.organizationId ??
        organizations.find((org) => org.organizationId !== currentOrganizationId)
          ?.organizationId ??
        organizations[0]?.organizationId,
    });
  };

  const hint = useMemo(() => MODE_HINTS[value.mode], [value.mode]);

  const modeSelectId = `${idPrefix}-mode`;

  return (
    <div className={`integration-key-org-scope${compact ? " integration-key-org-scope--compact" : ""}`}>
      {compact ? (
        <IntegrationKeyFieldLabel
          htmlFor={modeSelectId}
          label="Org scope"
          info={hint}
        />
      ) : (
        <label className="form-label" htmlFor={modeSelectId}>
          Organization scope
        </label>
      )}
      <select
        id={modeSelectId}
        className="form-input integration-key-org-scope__mode"
        value={value.mode}
        disabled={disabled}
        onChange={handleModeChange}
      >
        <option value="current" disabled={!currentOrganizationId}>
          {currentLabel} only
        </option>
        <option value="all">All organizations</option>
        <option value="specific" disabled={organizations.length === 0}>
          Specific organization
        </option>
      </select>

      {value.mode === "specific" && organizations.length > 0 && (
        <select
          className="form-input integration-key-org-scope__select"
          value={value.organizationId ?? ""}
          disabled={disabled}
          aria-label="Select organization"
          onChange={(event) =>
            onChange({
              mode: "specific",
              organizationId: event.target.value,
            })
          }
        >
          {organizations.map((org) => (
            <option key={org.organizationId} value={org.organizationId}>
              {org.label}
            </option>
          ))}
        </select>
      )}

      {!compact && <p className="integration-key-org-scope__hint">{hint}</p>}
    </div>
  );
}

export function formatOrgScopeLabel(input: {
  orgScope?: IntegrationKeyOrgScope | "global";
  organizationId?: string;
  activeOrganizationId?: string | null;
  organizations: OrgScopeOption[];
  currentOrganizationLabel?: string | null;
  /** @deprecated Use currentOrganizationLabel */
  currentWorkspaceLabel?: string | null;
}): string {
  if (input.orgScope === "all") {
    return "All organizations";
  }
  if (input.orgScope === "global") {
    return "Global";
  }
  const match = input.organizations.find(
    (org) => org.organizationId === input.organizationId,
  );
  if (match) {
    return match.label;
  }
  const currentLabel =
    input.currentOrganizationLabel?.trim() ||
    input.currentWorkspaceLabel?.trim() ||
    "This organization";
  if (
    input.organizationId &&
    input.activeOrganizationId &&
    input.organizationId === input.activeOrganizationId
  ) {
    return currentLabel;
  }
  return input.organizationId ?? currentLabel;
}
