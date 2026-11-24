/**
 * The one training switch, used in two places:
 *   - Settings → Privacy (always available)
 *   - a one-time card after Papr sign-in (asked once per wording version)
 *
 * The choice lives on the Papr account, so it applies to every device, cloud
 * agent and job. Copy is deliberately plain; the legal text is linked.
 */
import { useCallback, useEffect, useState } from "react";
import { SettingRow } from "./SettingRow";
import { Toggle } from "./Toggle";
import "./TrainingConsent.css";

const GATEWAY =
  typeof import.meta !== "undefined" && import.meta.env?.VITE_GATEWAY_PORT
    ? `http://${import.meta.env.VITE_GATEWAY_HOST || "localhost"}:${import.meta.env.VITE_GATEWAY_PORT || "18789"}`
    : "http://localhost:18789";

export const TRAINING_LABEL = "Help improve Papr with my chats";
export const TRAINING_HINT =
  "Lets Papr use your chats, the searches and tool calls in them, and how your apps run to train its models. Off by default. You can turn it off any time.";
const PRIVACY_URL = "https://papr.ai/privacy";

interface ConsentState {
  signedIn: boolean;
  optedIn: boolean;
  asked: boolean;
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

/** Settings → Privacy row. */
export function TrainingConsentRow() {
  const { state, saving, save } = useTrainingConsent();
  if (!state) return null;
  return (
    <SettingRow
      label={TRAINING_LABEL}
      hint={state.signedIn ? TRAINING_HINT : "Sign in to Papr to choose."}
      tooltip="Stored on your Papr account. Applies to every device and cloud agent."
    >
      <Toggle
        checked={state.optedIn}
        disabled={saving || !state.signedIn}
        onChange={(v) => void save(v)}
        ariaLabel={TRAINING_LABEL}
      />
    </SettingRow>
  );
}

/** One-time card after sign-in. Renders nothing once the user has chosen. */
export function TrainingConsentPrompt() {
  const { state, saving, save } = useTrainingConsent();
  if (!state || !state.signedIn || state.asked) return null;
  return (
    <div className="training-consent-card" role="dialog" aria-label={TRAINING_LABEL}>
      <div className="training-consent-card__title">{TRAINING_LABEL}?</div>
      <p className="training-consent-card__body">
        {TRAINING_HINT}{" "}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
          Privacy policy
        </a>
      </p>
      <div className="training-consent-card__actions">
        <button type="button" className="training-consent-card__btn" disabled={saving} onClick={() => void save(false)}>
          Not now
        </button>
        <button type="button" className="training-consent-card__btn training-consent-card__btn--primary" disabled={saving} onClick={() => void save(true)}>
          Yes, help improve Papr
        </button>
      </div>
    </div>
  );
}
