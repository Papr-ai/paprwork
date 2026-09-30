/**
 * Browser-safe tool labels for published app-agent chat (mirrors ui/utils/toolDisplay.ts).
 */

export interface SdkToolCallLike {
  toolName: string;
  args?: Record<string, unknown>;
  status?: "calling" | "success" | "error" | "pending" | "stopped";
}

function getDisplayFilename(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.replace(/\\/g, "").split("/");
  let filename = parts[parts.length - 1] ?? filePath;
  filename = filename.replace(/-content\.md$/, "").replace(/\.md$/, "");
  if (filename.length > 30) {
    return `${filename.slice(0, 27)}...`;
  }
  return filename;
}

const TOOL_DESCRIPTIONS: Record<string, { running: string; complete: string }> = {
  read_app_file: { running: "Reading app file", complete: "App file read" },
  edit_app_file: { running: "Editing app file", complete: "App file edited" },
  edit_app_file_lines: { running: "Editing app file", complete: "App file edited" },
  list_app_files: { running: "Listing app files", complete: "App files listed" },
  read_app_data_sources: { running: "Reading data sources", complete: "Data sources read" },
  read_app_data_health: { running: "Checking data health", complete: "Data health checked" },
  run_job: { running: "Running job", complete: "Job finished" },
  create_plan: { running: "Creating plan", complete: "Plan created" },
  update_plan: { running: "Updating plan", complete: "Plan updated" },
};

export function getSdkToolDisplayLabel(toolCall: SdkToolCallLike): string {
  const toolName = toolCall.toolName;
  const isRunning =
    toolCall.status === "calling" || toolCall.status === "pending" || toolCall.status === undefined;
  const isError = toolCall.status === "error";

  if (toolName === "run_job" && typeof toolCall.args?.jobId === "string") {
    const jobId = toolCall.args.jobId;
    const name =
      typeof toolCall.args.name === "string" ? toolCall.args.name : jobId.slice(0, 8);
    return isRunning ? `Running job: ${name}` : `Job finished: ${name}`;
  }

  if (
    (toolName === "read_app_file" ||
      toolName === "edit_app_file" ||
      toolName === "edit_app_file_lines") &&
    typeof toolCall.args?.path === "string"
  ) {
    const filename = getDisplayFilename(toolCall.args.path);
    if (toolName === "read_app_file") {
      return isRunning ? `Reading ${filename}` : `Read ${filename}`;
    }
    return isRunning ? `Editing ${filename}` : `Edited ${filename}`;
  }

  if (toolName === "list_app_files") {
    return isRunning ? "Listing app files" : "Listed app files";
  }

  const desc = TOOL_DESCRIPTIONS[toolName];
  if (desc) {
    if (isError) return `${desc.running} failed`;
    return isRunning ? desc.running : desc.complete;
  }

  const friendly = toolName.replace(/_/g, " ");
  return isRunning ? `${friendly}…` : friendly;
}
