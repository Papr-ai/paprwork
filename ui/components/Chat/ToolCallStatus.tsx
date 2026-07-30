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
  return <span className="exploring-tool-error">✗</span>;
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
        ? "exploring-tool-feedback exploring-tool-feedback--error"
        : "exploring-tool-feedback";

  return (
    <div className={className} title={feedback.detail}>
      {feedback.message}
    </div>
  );
};
