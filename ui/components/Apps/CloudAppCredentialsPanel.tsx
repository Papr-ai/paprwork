/**
 * Share sheet — configure which API keys are owner vs visitor-provided.
 */

import { useCallback, useEffect, useState } from "react";
import type { RequiredKeySpec } from "../../../src/core/types/bundles";
import type { CredentialScope } from "../../../src/core/types/bundles";
import {
  fetchAppRequirements,
  saveAppRequirements,
} from "../../utils/cloudAppRequirementsApi";

interface CloudAppCredentialsPanelProps {
  appId: string;
  appTitle: string;
  busy?: boolean;
  onSaved?: () => void;
}

interface DraftRow {
  name: string;
  service: string;
  description: string;
  credentialScope: CredentialScope;
}

function toDraft(spec: RequiredKeySpec): DraftRow {
  return {
    name: spec.name,
    service: spec.service,
    description: spec.description ?? "",
    credentialScope: spec.credentialScope === "owner" ? "owner" : "user",
  };
}

function toSpec(row: DraftRow): RequiredKeySpec {
  return {
    name: row.name.trim(),
    service: row.service.trim() || row.name.trim(),
    category: "other",
    description: row.description.trim(),
    required: true,
    credentialScope: row.credentialScope,
  };
}

export function CloudAppCredentialsPanel({
  appId,
  appTitle,
  busy = false,
  onSaved,
}: CloudAppCredentialsPanelProps) {
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const requirements = await fetchAppRequirements(appId);
      setRows(requirements.map(toDraft));
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setLoading(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        name: "",
        service: "",
        description: "",
        credentialScope: "user",
      },
    ]);
  };

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    const normalized = rows
      .map(toSpec)
      .filter((spec) => spec.name.length > 0);

    for (const spec of normalized) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(spec.name)) {
        setError(`Key name must be UPPER_SNAKE_CASE: ${spec.name || "(empty)"}`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await saveAppRequirements(appId, normalized);
      setMessage("Saved. Republish to update the live app catalog.");
      onSaved?.();
    } catch (err) {
      setError((err as Error).message.slice(0, 160));
    } finally {
      setSaving(false);
    }
  };

  const hasUserKeys = rows.some((row) => row.credentialScope === "user" && row.name.trim());

  return (
    <div className="share-sheet__section share-sheet__credentials">
      <p className="share-sheet__section-title">API credentials</p>
      <p className="share-sheet__section-desc">
        Choose which keys <strong>you</strong> provide vs keys each visitor must
        bring for <strong>{appTitle}</strong>. User keys require Papr sign-in and
        a setup step before the live app loads.
      </p>

      {loading ? (
        <p className="share-sheet__footnote">Loading requirements…</p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="share-sheet__footnote">
              No keys configured. Add keys your app uses via{" "}
              <code>${"{KEY_NAME}"}</code> in jobs or bash.
            </p>
          ) : null}

          <ul className="share-sheet__cred-list">
            {rows.map((row, index) => (
              <li key={`${row.name}-${index}`} className="share-sheet__cred-row">
                <div className="share-sheet__cred-fields">
                  <input
                    className="share-sheet__cred-input"
                    placeholder="KEY_NAME"
                    value={row.name}
                    onChange={(e) => updateRow(index, { name: e.target.value.toUpperCase() })}
                    aria-label="Key name"
                  />
                  <input
                    className="share-sheet__cred-input"
                    placeholder="Service (e.g. X / Twitter)"
                    value={row.service}
                    onChange={(e) => updateRow(index, { service: e.target.value })}
                    aria-label="Service name"
                  />
                  <select
                    className="share-sheet__cred-select"
                    value={row.credentialScope}
                    onChange={(e) =>
                      updateRow(index, {
                        credentialScope: e.target.value as CredentialScope,
                      })
                    }
                    aria-label="Credential scope"
                  >
                    <option value="user">Visitor provides</option>
                    <option value="owner">I provide (owner)</option>
                  </select>
                </div>
                <input
                  className="share-sheet__cred-input share-sheet__cred-input--wide"
                  placeholder="Short description for setup wizard"
                  value={row.description}
                  onChange={(e) => updateRow(index, { description: e.target.value })}
                  aria-label="Description"
                />
                <button
                  type="button"
                  className="share-sheet__link-btn"
                  onClick={() => removeRow(index)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>

          <div className="share-sheet__community-actions">
            <button
              type="button"
              className="share-sheet__secondary-btn"
              disabled={busy || saving}
              onClick={addRow}
            >
              Add key
            </button>
            <button
              type="button"
              className="share-sheet__primary-btn"
              disabled={busy || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save credentials"}
            </button>
          </div>

          {hasUserKeys ? (
            <p className="share-sheet__footnote">
              Live visitors with user-scoped keys will sign in, complete setup, then
              use the app. Sandbox jobs (coming soon) inject the right keys for bash /
              Playwright automation.
            </p>
          ) : null}
        </>
      )}

      {error ? <p className="share-sheet__error">{error}</p> : null}
      {message ? (
        <p className="share-sheet__notice share-sheet__notice--success">{message}</p>
      ) : null}
    </div>
  );
}
