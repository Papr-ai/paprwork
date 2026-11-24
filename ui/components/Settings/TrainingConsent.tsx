/**
 * Internal training beta — Settings → Privacy only. Feature-flagged OFF.
 *
 * Renders nothing unless the server marks this account `available` (internal
 * allowlist on the memory server). Customers never see it. Allowlisted users
 * start OFF and must opt in here themselves. There is no popup or prompt.
 */
import { useCallback, useEffect, useState } from "react";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export const TRAINING_LABEL = "Join the internal training beta";
export const TRAINING_HINT =
  "We don't train on your data. This beta is invite-only: turning it on lets Papr use your chats, the searches and tool calls in them, and how your apps run to improve its models. Off by default; turn it off any time.";

interface ConsentState {
  signedIn: boolean;
  available: boolean;
  optedIn: boolean;
}

function useTrainingConsent() {
  const [state, setState] = useState<ConsentState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${GATEWAY}/api/training/consent`)
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => live && s && setState(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(async (optedIn: boolean) => {
    setSaving(true);
    try {
      const r = await fetch(`${GATEWAY}/api/training/consent`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optedIn }),
      });
      if (r.ok) setState(await r.json());
    } finally {
      setSaving(false);
    }
  }, []);

  return { state, saving, save };
}

/** Settings → Privacy row. Hidden for everyone not on the internal allowlist. */
export function TrainingConsentRow() {
  const { state, saving, save } = useTrainingConsent();
  if (!state || !state.signedIn || state.available !== true) return null;
  return (
    <SettingRow
      label={TRAINING_LABEL}
      hint={TRAINING_HINT}
      tooltip="Internal beta. Stored on your Papr account; applies to every device and cloud agent."
    >
      <Toggle
        checked={state.optedIn}
        disabled={saving}
        onChange={(v) => void save(v)}
        ariaLabel={TRAINING_LABEL}
      />
    </SettingRow>
  );
}
