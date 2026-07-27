import React, { useMemo } from "react";
import {
  VAULT_AUDIENCE_LABELS,
  type IntegrationKeyVaultAudience,
} from "../../constants/integrationKeyVaultAudience";
import "./IntegrationKeyVaultAudienceSelector.css";
import { IntegrationKeyFieldLabel } from "./IntegrationKeyOptionsRow";

interface IntegrationKeyVaultAudienceSelectorProps {
  value: IntegrationKeyVaultAudience;
  onChange: (value: IntegrationKeyVaultAudience) => void;
  disabled?: boolean;
  compact?: boolean;
  idPrefix?: string;
}

export function IntegrationKeyVaultAudienceSelector({
  value,
  onChange,
  disabled = false,
  compact = false,
  idPrefix = "vault-audience",
}: IntegrationKeyVaultAudienceSelectorProps) {
  const hint = useMemo(() => VAULT_AUDIENCE_LABELS[value].hint, [value]);
  const selectId = `${idPrefix}-select`;

  return (
    <div
      className={`integration-key-vault-audience${compact ? " integration-key-vault-audience--compact" : ""}`}
    >
      {compact ? (
        <IntegrationKeyFieldLabel htmlFor={selectId} label="Audience" info={hint} />
      ) : (
        <label className="form-label" htmlFor={selectId}>
          Who can use this key
        </label>
      )}
      <select
        id={selectId}
        className="form-input integration-key-vault-audience__select"
        value={value}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value as IntegrationKeyVaultAudience)
        }
      >
        {(Object.keys(VAULT_AUDIENCE_LABELS) as IntegrationKeyVaultAudience[]).map(
          (audience) => (
            <option key={audience} value={audience}>
              {VAULT_AUDIENCE_LABELS[audience].label}
            </option>
          ),
        )}
      </select>
      {!compact && <p className="integration-key-vault-audience__hint">{hint}</p>}
    </div>
  );
}

export function formatVaultAudienceLabel(
  audience?: IntegrationKeyVaultAudience | null,
): string {
  if (audience === "namespace" || audience === "org") {
    return VAULT_AUDIENCE_LABELS[audience].label;
  }
  return VAULT_AUDIENCE_LABELS.user.label;
}
