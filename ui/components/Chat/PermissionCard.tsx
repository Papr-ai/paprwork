/**
 * PermissionCard - Inline permission request card shown in chat.
 *
 * Renders when a tool (browser, bash with custom keys, etc.) needs user approval.
 * Displayed inline in the message stream instead of as a popup modal.
 */

import React, { useState, useEffect } from "react";
import { usePermissionStore } from "../../stores/permissionStore";
import "./PermissionCard.css";

export const PermissionCard: React.FC = () => {
  const { activeRequest, respond, claimForChat } = usePermissionStore();
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  // Claim the request for inline rendering (suppresses the modal fallback)
  useEffect(() => {
    if (activeRequest) {
      claimForChat();
    }
  }, [activeRequest, claimForChat]);

  // Reset checkbox when request changes
  useEffect(() => {
    setAlwaysAllow(false);
  }, [activeRequest?.requestId]);

  if (!activeRequest) return null;

  const handleApprove = () => {
    respond({ approved: true, alwaysAllow: alwaysAllow || undefined });
  };

  const handleDeny = () => {
    respond({ approved: false });
  };

  const toolName = activeRequest.toolContext?.toolName || "Unknown tool";
  const command = activeRequest.toolContext?.command;

  return (
    <div className="permission-card">
      <div className="permission-card-header">
        <svg
          className="permission-card-icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span className="permission-card-title">Permission Required</span>
      </div>

      <div className="permission-card-body">
        <p className="permission-card-desc">{activeRequest.description}</p>

        <div className="permission-card-details">
          <div className="permission-detail">
            <span className="permission-detail-label">Tool</span>
            <code className="permission-detail-value">{toolName}</code>
          </div>
          <div className="permission-detail">
            <span className="permission-detail-label">Key</span>
            <code className="permission-detail-value">
              {activeRequest.keyName}
            </code>
          </div>
          {command && (
            <div className="permission-detail">
              <span className="permission-detail-label">Action</span>
              <code className="permission-detail-value permission-detail-command">
                {command}
              </code>
            </div>
          )}
        </div>

        <label className="permission-card-always">
          <input
            type="checkbox"
            checked={alwaysAllow}
            onChange={(e) => setAlwaysAllow(e.target.checked)}
          />
          <span>Always allow (don't ask again)</span>
        </label>
      </div>

      <div className="permission-card-actions">
        <button className="permission-btn permission-btn-deny" onClick={handleDeny}>
          Deny
        </button>
        <button className="permission-btn permission-btn-allow" onClick={handleApprove}>
          Allow
        </button>
      </div>
    </div>
  );
};
