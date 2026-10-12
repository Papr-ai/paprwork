/** Small building blocks for ShareAccessPanel (role dropdown, labelled row). */

import React from "react";
import { ROLE_COPY, type AccessVisibility, type AppRole } from "../../utils/appRolesModel";

export const VISIBILITY_CHOICES: { value: AccessVisibility; label: string }[] = [
  { value: "private", label: "Only Admins and people added" },
  { value: "team", label: "Workspace" },
  { value: "link_read", label: "Anyone with the link" },
  { value: "public_read", label: "Community" },
];

export function RoleSelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: AppRole;
  options: AppRole[];
  disabled?: boolean;
  onChange: (role: AppRole) => void;
}) {
  // A stored role above this audience's cap still shows (read-only label).
  const shown = options.includes(value) ? options : [...options, value];
  return (
    <select
      className="ss6-role"
      value={value}
      disabled={disabled}
      title={ROLE_COPY[value].sub}
      onChange={(e) => onChange(e.target.value as AppRole)}
    >
      {shown.map((r) => (
        <option key={r} value={r}>
          {ROLE_COPY[r].label} — {ROLE_COPY[r].sub}
        </option>
      ))}
    </select>
  );
}

export function AccessRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="ss6-access-row">
      <span className="ss6-opt-text">
        <b>{label}</b>
        {sub ? <em>{sub}</em> : null}
      </span>
      {children ? <span className="ss6-access-ctl">{children}</span> : null}
    </div>
  );
}
