/**
 * ApiKeyStep — "Use an API key instead" inside onboarding.
 *
 * Previously this link just skipped setup and dropped the user into the
 * workspace with no key and no hint where to add one. Now it collects the key
 * here, stored under the SAME names Settings → AI Models uses, so the rest of
 * the app picks it up with no extra wiring.
 */

import { useState } from "react";
import { useCustomKeys } from "../../hooks/useCustomKeys";
import { trackEvent } from "../../lib/telemetry";

type KeyProvider = "anthropic" | "openai" | "google";

const KEY_PROVIDERS: Array<{
  id: KeyProvider;
  name: string;
  keyName: string;
  placeholder: string;
  hint: string;
}> = [
  {
    id: "anthropic",
    name: "Claude",
    keyName: "ANTHROPIC_API_KEY",
    placeholder: "sk-ant-api03-…",
    hint: "console.anthropic.com → API keys",
  },
  {
    id: "openai",
    name: "ChatGPT",
    keyName: "OPENAI_API_KEY",
    placeholder: "sk-proj-…",
    hint: "platform.openai.com/api-keys",
  },
  {
    id: "google",
    name: "Gemini",
    keyName: "GOOGLE_API_KEY",
    placeholder: "AIza…",
    hint: "aistudio.google.com/apikey",
  },
];

interface ApiKeyStepProps {
  /** Key saved — continue to the next onboarding stage. */
  onSaved: () => void;
}

export function ApiKeyStep({ onSaved }: ApiKeyStepProps) {
  const { keys, addKey, updateKey } = useCustomKeys();
  const [provider, setProvider] = useState<KeyProvider>("anthropic");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = KEY_PROVIDERS.find((p) => p.id === provider)!;

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const existing = keys.find((k) => k.name === spec.keyName);
      const input = { name: spec.keyName, value: trimmed, permission: "always" as const };
      const ok = existing ? await updateKey(existing.id, input) : await addKey(input);
      if (ok === false) throw new Error("save failed");
      trackEvent("paprwork_onboarding_api_key_saved", {
        provider_key_name: spec.keyName,
      } as Record<string, unknown>);
      onSaved();
    } catch {
      setError("Couldn't save that key. Check it and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h1 className="onboarding-h1">Use an API key</h1>
      <p className="onboarding-lede">
        Pick the provider and paste your key. It&apos;s stored securely on this Mac and you
        can change it any time in Settings → AI Models.
      </p>

      <div className="onboarding-keyseg" role="radiogroup" aria-label="Provider">
        {KEY_PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={provider === p.id}
            className={`onboarding-keyseg__btn${provider === p.id ? " is-on" : ""}`}
            onClick={() => {
              setProvider(p.id);
              setError(null);
            }}
          >
            {p.name}
          </button>
        ))}
      </div>

      <label className="onboarding-fld">
        <span>{spec.name} API key</span>
        <input
          type="password"
          className="onboarding-fld-in"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder={spec.placeholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <em>Get one at {spec.hint}</em>
      </label>

      {error && (
        <p className="onboarding-check-msg" role="alert">
          {error}
        </p>
      )}

      <button
        type="button"
        className="onboarding-cta"
        disabled={!value.trim() || saving}
        onClick={() => void save()}
      >
        {saving ? "Saving…" : "Save and continue"}
      </button>
    </>
  );
}
