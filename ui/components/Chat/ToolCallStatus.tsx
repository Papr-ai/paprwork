import React from "react";
import type { ToolCallStatus } from "../../../src/core/utils/interruptedToolResult";
import { getToolResultFeedback } from "../../../src/core/utils/interruptedToolResult";

interface ToolCallStatusProps {
  status: ToolCallStatus;
  result?: unknown;
  toolError?: string;
}

export function ToolCallStatusIcon({ status }: { status: ToolCallStatus }): React.ReactNode {
  if (status === "calling") {
    return (
      <span className="exploring-tool-loading">
        <span className="exploring-tool-dot"></span>
      </span>
    );
  }
  if (status === "success") {
    return <span className="exploring-tool-success">✓</span>;
  }
  if (status === "warning") {
    return (
      <span className="exploring-tool-warning" title="Completed with warnings">
        ⚠
      </span>
    );
  }
  if (status === "interrupted") {
    return (
      <span
        className="exploring-tool-interrupted"
        title="Interrupted before this tool finished"
      >
        ⚠️
      </span>
    );
  }
  return (
    <span
      className="exploring-tool-agent-note"
      title="The agent reads this and retries — no action needed from you"
    >
      Agent auto-fixing…
    </span>
  );
}

export const ToolCallResultFeedback: React.FC<ToolCallStatusProps> = ({
  status,
  result,
  toolError,
}) => {
  const feedback = getToolResultFeedback({ status, result, toolError });
  if (!feedback) {
    return null;
  }

  const className =
    status === "warning"
      ? "exploring-tool-feedback exploring-tool-feedback--warning"
      : status === "error"
        ? "exploring-tool-feedback exploring-tool-feedback--agent"
        : "exploring-tool-feedback";

  const title =
    status === "error"
      ? "Technical detail for the agent — you don't need to do anything"
      : feedback.detail;

  return (
    <div className={className} title={title}>
      {status === "error" && (
        <span className="exploring-tool-feedback__label">
          Agent read this and will retry
        </span>
      )}
      {feedback.message}
    </div>
  );
};
