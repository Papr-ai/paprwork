import React from "react";
import "./IntegrationKeyOptionsRow.css";

interface IntegrationKeyOptionsRowProps {
  children: React.ReactNode;
}

export function IntegrationKeyOptionsRow({ children }: IntegrationKeyOptionsRowProps) {
  return <div className="integration-key-options-row">{children}</div>;
}

interface IntegrationKeyFieldLabelProps {
  htmlFor?: string;
  label: string;
  info: string;
}

export function IntegrationKeyFieldLabel({
  htmlFor,
  label,
  info,
}: IntegrationKeyFieldLabelProps) {
  return (
    <div className="integration-key-field-label">
      {htmlFor ? (
        <label className="integration-key-field-label__text" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="integration-key-field-label__text">{label}</span>
      )}
      <span
        className="integration-key-field-label__info"
        tabIndex={0}
        role="button"
        aria-label={`About ${label}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
          <path
            d="M12 10v6M12 7h.01"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
        <span className="integration-key-field-label__tooltip" role="tooltip">
          {info}
        </span>
      </span>
    </div>
  );
}

interface IntegrationKeySelectFieldProps {
  id: string;
  label: string;
  info: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}

export function IntegrationKeySelectField({
  id,
  label,
  info,
  value,
  onChange,
  options,
}: IntegrationKeySelectFieldProps) {
  return (
    <div className="integration-key-options-row__field">
      <IntegrationKeyFieldLabel htmlFor={id} label={label} info={info} />
      <select
        id={id}
        className="form-input integration-key-options-row__select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export const INTEGRATION_KEY_PERMISSION_OPTIONS = [
  { value: "always", label: "Always allow" },
  { value: "ask", label: "Ask each time" },
] as const;

export const INTEGRATION_KEY_CLIENT_ACCESS_OPTIONS = [
  { value: "server", label: "Server only" },
  { value: "client", label: "Browser-safe" },
] as const;

export const INTEGRATION_KEY_PERMISSION_INFO =
  "Always allow: jobs and automations can use this key without prompting. Ask each time: you approve before each use.";

export const INTEGRATION_KEY_CLIENT_ACCESS_INFO =
  "Server only: substituted in jobs, bash, and backend routes — never exposed to mini-app bundles. Browser-safe: publishable keys allowed in client-side app code.";
