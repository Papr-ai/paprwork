/**
 * Key Permission Modal
 * 
 * Shows permission request to user when a tool tries to use an API key.
 * Allows user to approve/deny and optionally set "always allow".
 */

import React, { useState } from "react";
import type {
  KeyPermissionRequest,
  KeyPermissionResponse,
} from "../../types/permissions";
import "./KeyPermissionModal.css";

interface Props {
  request: KeyPermissionRequest & { requestId: string };
  onResponse: (response: KeyPermissionResponse) => void;
}

export function KeyPermissionModal({ request, onResponse }: Props) {
  const [alwaysAllow, setAlwaysAllow] = useState(false);

  const handleApprove = () => {
    onResponse({
      approved: true,
      alwaysAllow: request.isEnvKey ? alwaysAllow : undefined,
    });
  };

  const handleDeny = () => {
    onResponse({
      approved: false,
    });
  };

  return (
    <div className="key-permission-overlay" onClick={handleDeny}>
      <div
        className="key-permission-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="key-permission-header">
          <h2>🔑 API Key Permission</h2>
        </div>

        <div className="key-permission-content">
          <p className="key-permission-description">{request.description}</p>

          <div className="key-permission-details">
            <div className="detail-row">
              <span className="detail-label">Tool:</span>
              <code className="detail-value">
                {request.toolContext?.toolName || "Unknown"}
              </code>
            </div>
            <div className="detail-row">
              <span className="detail-label">Key:</span>
              <code className="detail-value">{request.keyName}</code>
            </div>
            {request.toolContext?.command && (
              <div className="detail-row">
                <span className="detail-label">Command:</span>
                <code className="detail-value command-preview">
                  {request.toolContext.command}
                </code>
              </div>
            )}
          </div>

          {request.isEnvKey && (
            <label className="always-allow-checkbox">
              <input
                type="checkbox"
                checked={alwaysAllow}
                onChange={(e) => setAlwaysAllow(e.target.checked)}
              />
              <span>Always allow this key (don't ask again)</span>
            </label>
          )}
        </div>

        <div className="key-permission-actions">
          <button className="btn btn-secondary" onClick={handleDeny}>
            Deny
          </button>
          <button className="btn btn-primary" onClick={handleApprove}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
