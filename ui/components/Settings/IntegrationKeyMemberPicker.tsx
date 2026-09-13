import React, { useMemo } from "react";
import "./IntegrationKeyMemberPicker.css";

export interface WorkspaceMemberOption {
  userId: string;
  displayName: string;
  email: string;
  role: string;
}

interface IntegrationKeyMemberPickerProps {
  members: WorkspaceMemberOption[];
  selectedUserIds: string[];
  onChange: (userIds: string[]) => void;
  disabled?: boolean;
  idPrefix?: string;
}

export function IntegrationKeyMemberPicker({
  members,
  selectedUserIds,
  onChange,
  disabled = false,
  idPrefix = "vault-members",
}: IntegrationKeyMemberPickerProps) {
  const selectedSet = useMemo(
    () => new Set(selectedUserIds.map((id) => id.toLowerCase())),
    [selectedUserIds],
  );

  const toggleMember = (userId: string) => {
    if (disabled) {
      return;
    }
    const normalized = userId.toLowerCase();
    if (selectedSet.has(normalized)) {
      onChange(selectedUserIds.filter((id) => id.toLowerCase() !== normalized));
      return;
    }
    onChange([...selectedUserIds, userId]);
  };

  if (members.length === 0) {
    return (
      <div className="integration-key-member-picker integration-key-member-picker--empty">
        <p className="integration-key-member-picker__hint">
          No workspace members loaded. Sign in with Papr to pick teammates.
        </p>
      </div>
    );
  }

  return (
    <div className="integration-key-member-picker">
      <div className="integration-key-member-picker__header">
        <span className="integration-key-member-picker__label">Selected members</span>
        <span className="integration-key-member-picker__count">
          {selectedUserIds.length} selected
        </span>
      </div>
      <div className="integration-key-member-picker__list" role="list">
        {members.map((member) => {
          const inputId = `${idPrefix}-${member.userId}`;
          const checked = selectedSet.has(member.userId.toLowerCase());
          return (
            <label key={member.userId} className="integration-key-member-picker__item" htmlFor={inputId}>
              <input
                id={inputId}
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggleMember(member.userId)}
              />
              <span className="integration-key-member-picker__item-text">
                <span className="integration-key-member-picker__name">
                  {member.displayName}
                </span>
                <span className="integration-key-member-picker__meta">
                  {member.email}
                  {member.role ? ` · ${member.role}` : ""}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
