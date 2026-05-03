/**
 * Shared tool call display utilities — used by MessageItem and ExploringCard.
 * Converts tool names and bash commands into user-friendly descriptions (ported from V1).
 */

export function getDisplayFilename(path: string): string {
  if (!path) return "";

  const cleanPath = path.replace(/\\/g, "");
  const parts = cleanPath.split("/");
  let filename = parts[parts.length - 1];

  // UUID-like IDs → generic label
  if (
    filename.match(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/,
    )
  ) {
    return "document";
  }

  filename = filename.replace(/-content\.md$/, "").replace(/\.md$/, "");

  if (filename.length > 30) {
    filename = filename.substring(0, 27) + "...";
  }

  return filename;
}

export function getBashCommandDescription(
  command: string,
  isRunning = true,
): string {
  const cmd = command.trim();
  const prefix = isRunning ? "Running" : "Ran";

  // Handle cd commands - show destination directory clearly
  // BUT: only match standalone cd, not cd in pipes/chains
  if (cmd.startsWith("cd ") && !cmd.includes("|") && !cmd.includes("&&") && !cmd.includes(";")) {
    const pathMatch = cmd.match(/cd\s+([^\s]+)/);  // Capture only the path argument
    if (pathMatch) {
      const fullPath = pathMatch[1].trim().replace(/["']/g, "");
      // Extract just the last 2-3 directory components for clarity
      const parts = fullPath.split("/").filter(p => p);
      let displayPath;
      
      if (parts.length > 3) {
        // Show last 3 parts with ellipsis: .../GitHub/repo-name/subfolder
        displayPath = ".../" + parts.slice(-3).join("/");
      } else if (parts.length > 0) {
        displayPath = parts.join("/");
      } else {
        displayPath = fullPath;
      }
      
      return isRunning 
        ? `Navigating to ${displayPath}` 
        : `Navigated to ${displayPath}`;
    }
    return isRunning ? "Navigating directory" : "Navigated to directory";
  }

  if (cmd.startsWith("curl")) {
    const urlMatch = cmd.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const domain = urlMatch[0].replace(/^https?:\/\//, "").split("/")[0];
      return isRunning
        ? `Getting info from ${domain}`
        : `Got info from ${domain}`;
    }
    return isRunning ? "Fetching web content" : "Fetched web content";
  }

  if (cmd.includes("cat >") && cmd.includes("<<")) {
    const pathMatch = cmd.match(/cat\s+>\s+((?:[^\s<]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Updating ${filename}` : `Updated ${filename}`;
    }
    return isRunning ? "Updating document" : "Updated document";
  }

  if (cmd.startsWith("cat ") && !cmd.includes(">")) {
    const pathMatch = cmd.match(/cat\s+((?:[^\s|;&]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Reading ${filename}` : `Read ${filename}`;
    }
    return isRunning ? "Reading file" : "Read file";
  }

  if (cmd.startsWith("head ") || cmd.startsWith("tail ")) {
    const cmdName = cmd.startsWith("head") ? "head" : "tail";
    const pathMatch = cmd.match(/(?:head|tail)\s+(?:-n?\s*\d+\s+)?([^\s|;&]+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Reading ${filename}` : `Read ${filename}`;
    }
    return isRunning ? "Reading file" : "Read file";
  }

  if (cmd.startsWith("grep")) {
    const searchMatch = cmd.match(/grep.*["']([^"']+)["']/);
    if (searchMatch) {
      const searchTerm = searchMatch[1].substring(0, 20);
      return isRunning
        ? `Searching for "${searchTerm}"`
        : `Searched for "${searchTerm}"`;
    }
    if (cmd.includes("documents/"))
      return isRunning ? "Searching documents" : "Searched documents";
    return isRunning ? "Searching files" : "Searched files";
  }

  if (cmd.startsWith("ls")) {
    const pathMatch = cmd.match(/ls\s+[^\s]*\s+([^\s]+)/);
    if (pathMatch) {
      const dirname = getDisplayFilename(pathMatch[1]);
      if (dirname)
        return isRunning ? `Listing ${dirname}` : `Listed ${dirname}`;
    }
    return isRunning ? "Listing files" : "Listed files";
  }

  if (cmd.includes("sqlite3")) {
    const dbMatch = cmd.match(/sqlite3\s+([^\s]+)/);
    if (dbMatch) {
      const db = getDisplayFilename(dbMatch[1]);
      if (db) return isRunning ? `Querying ${db}` : `Queried ${db}`;
    }
    return isRunning ? "Querying database" : "Queried database";
  }

  if (cmd.includes("pip install") || cmd.includes("pip3 install")) {
    const pkgMatch = cmd.match(/pip3?\s+install\s+([^\s]+)/);
    if (pkgMatch)
      return isRunning
        ? `Installing ${pkgMatch[1]}`
        : `Installed ${pkgMatch[1]}`;
    return isRunning
      ? "Installing Python packages"
      : "Installed Python packages";
  }

  if (cmd.includes("npm install") || cmd.includes("yarn add")) {
    const pkgMatch = cmd.match(/(?:npm install|yarn add)\s+([^\s]+)/);
    if (pkgMatch)
      return isRunning
        ? `Installing ${pkgMatch[1]}`
        : `Installed ${pkgMatch[1]}`;
    return isRunning ? "Installing packages" : "Installed packages";
  }

  if (
    cmd.includes("npm run") ||
    (cmd.includes("yarn") && !cmd.includes("yarn add"))
  ) {
    return isRunning ? "Running build" : "Ran build";
  }

  if (cmd.startsWith("python") || cmd.startsWith("python3")) {
    const scriptMatch = cmd.match(/python3?\s+([^\s]+)/);
    if (scriptMatch) {
      const script = getDisplayFilename(scriptMatch[1]);
      if (script) return isRunning ? `Running ${script}` : `Ran ${script}`;
    }
    return isRunning ? "Running Python script" : "Ran Python script";
  }

  if (cmd.startsWith("node ")) {
    const scriptMatch = cmd.match(/node\s+([^\s]+)/);
    if (scriptMatch) {
      const script = getDisplayFilename(scriptMatch[1]);
      if (script) return isRunning ? `Running ${script}` : `Ran ${script}`;
    }
    return isRunning ? "Running Node script" : "Ran Node script";
  }

  if (cmd.startsWith("git clone")) {
    const urlMatch = cmd.match(
      /git clone\s+[^\s]*\/([^\s/]+?)(?:\.git)?(?:\s|$)/,
    );
    if (urlMatch)
      return isRunning ? `Cloning ${urlMatch[1]}` : `Cloned ${urlMatch[1]}`;
    return isRunning ? "Cloning repository" : "Cloned repository";
  }

  if (cmd.startsWith("git pull"))
    return isRunning ? "Updating repository" : "Updated repository";
  if (cmd.startsWith("git commit"))
    return isRunning ? "Committing changes" : "Committed changes";
  if (cmd.startsWith("git push"))
    return isRunning ? "Pushing to remote" : "Pushed to remote";
  if (cmd.startsWith("git "))
    return isRunning ? "Running git command" : "Ran git command";

  if (cmd.startsWith("mkdir")) {
    const pathMatch = cmd.match(/mkdir\s+(?:-p\s+)?([^\s]+)/);
    if (pathMatch) {
      const dirname = getDisplayFilename(pathMatch[1]);
      if (dirname)
        return isRunning ? `Creating ${dirname}` : `Created ${dirname}`;
    }
    return isRunning ? "Creating folder" : "Created folder";
  }

  if (cmd.startsWith("rm")) {
    const pathMatch = cmd.match(/rm\s+(?:-[rf]+\s+)?((?:[^\s]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[1].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Deleting ${filename}` : `Deleted ${filename}`;
    }
    return isRunning ? "Deleting files" : "Deleted files";
  }

  if (cmd.startsWith("cp ")) {
    const pathMatch = cmd.match(
      /cp\s+(?:-[rf]+\s+)?((?:[^\s]|\\.)+)\s+((?:[^\s]|\\.)+)/,
    );
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[2].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Copying to ${filename}` : `Copied to ${filename}`;
    }
    return isRunning ? "Copying files" : "Copied files";
  }

  if (cmd.startsWith("mv ")) {
    const pathMatch = cmd.match(/mv\s+((?:[^\s]|\\.)+)\s+((?:[^\s]|\\.)+)/);
    if (pathMatch) {
      const filename = getDisplayFilename(pathMatch[2].replace(/\\/g, ""));
      if (filename)
        return isRunning ? `Moving to ${filename}` : `Moved to ${filename}`;
    }
    return isRunning ? "Moving files" : "Moved files";
  }

  // Default: show first 120 chars of command (increased from 40 to show more context)
  const shortCmd = cmd.length > 120 ? cmd.substring(0, 120) + "..." : cmd;
  return `${prefix}: ${shortCmd}`;
}

export interface ToolCallLike {
  toolName?: string;
  args?: Record<string, unknown>;
  status?: string;
}

export const TOOL_DESCRIPTIONS: Record<
  string,
  { running: string; complete: string }
> = {
  // Bash
  bash: { running: "Running command", complete: "Command completed" },
  // Filesystem
  read_file: { running: "Reading file", complete: "File read" },
  write_file: { running: "Writing file", complete: "File written" },
  list_directory: {
    running: "Listing directory",
    complete: "Directory listed",
  },
  search_files: { running: "Searching files", complete: "Files searched" },
  // Documents
  create_document: {
    running: "Creating document",
    complete: "Document created",
  },
  read_document: { running: "Reading document", complete: "Document read" },
  update_document: {
    running: "Updating document",
    complete: "Document updated",
  },
  list_documents: {
    running: "Listing documents",
    complete: "Documents listed",
  },
  import_document: {
    running: "Importing document",
    complete: "Document imported",
  },
  // Apps
  create_app: { running: "Creating app", complete: "App created" },
  list_apps: { running: "Listing apps", complete: "Apps listed" },
  read_app_file: { running: "Reading app file", complete: "App file read" },
  edit_app_file: { running: "Editing app file", complete: "App file edited" },
  list_app_files: {
    running: "Listing app files",
    complete: "App files listed",
  },
  link_app_data_source: {
    running: "Linking data source",
    complete: "Data source linked",
  },
  read_app_data_sources: {
    running: "Reading data sources",
    complete: "Data sources read",
  },
  // Jobs
  create_job: { running: "Creating job", complete: "Job created" },
  run_job: { running: "Running job", complete: "Job finished" },
  read_job_logs: { running: "Reading job logs", complete: "Job logs read" },
  list_jobs: { running: "Listing jobs", complete: "Jobs listed" },
  update_job: { running: "Updating job", complete: "Job updated" },
  delete_job: { running: "Deleting job", complete: "Job deleted" },
  list_job_files: {
    running: "Listing job files",
    complete: "Job files listed",
  },
  read_job_file: { running: "Reading job file", complete: "Job file read" },
  edit_job_file: { running: "Editing job file", complete: "Job file edited" },
  // Sub-agents
  create_sub_agent: {
    running: "Creating sub-agent",
    complete: "Sub-agent created",
  },
  list_sub_agents: {
    running: "Listing sub-agents",
    complete: "Sub-agents listed",
  },
  delete_sub_agent: {
    running: "Deleting sub-agent",
    complete: "Sub-agent deleted",
  },
  delegate_task: { running: "Delegating task", complete: "Task delegated" },
  get_delegation_run: {
    running: "Checking delegation",
    complete: "Delegation loaded",
  },
  list_delegation_runs: {
    running: "Listing delegations",
    complete: "Delegations listed",
  },
  // Planning
  create_plan: { running: "Creating plan", complete: "Plan created" },
  update_plan: { running: "Updating plan", complete: "Plan updated" },
  // Memory
  add_agent_memory: { running: "Saving to memory", complete: "Memory saved" },
  search_agent_memory: {
    running: "Searching memory",
    complete: "Memory loaded",
  },
  register_schema: {
    running: "Registering schema",
    complete: "Schema registered",
  },
  // Skills
  create_skill: { running: "Creating skill", complete: "Skill created" },
  read_skill: { running: "Reading skill", complete: "Skill loaded" },
  // Browser
  browser_navigate: {
    running: "Navigating browser",
    complete: "Browser navigated",
  },
  browser_snapshot: { running: "Reading page", complete: "Page read" },
  browser_click: { running: "Clicking element", complete: "Element clicked" },
  browser_type: { running: "Typing on page", complete: "Text entered" },
  browser_tabs: { running: "Checking tabs", complete: "Tabs loaded" },
  browser_console_logs: {
    running: "Reading console logs",
    complete: "Console logs read",
  },
  browser_network_logs: {
    running: "Reading network logs",
    complete: "Network logs read",
  },
  browser_test_script: {
    running: "Running browser test",
    complete: "Browser test done",
  },
  // Webview
  webview_launch_app: {
    running: "Launching app preview",
    complete: "App preview ready",
  },
  webview_snapshot: {
    running: "Reading app preview",
    complete: "App preview read",
  },
  webview_execute: {
    running: "Running preview script",
    complete: "Preview script done",
  },
  webview_get_console: {
    running: "Reading preview console",
    complete: "Preview console read",
  },
  webview_get_network: {
    running: "Reading preview network",
    complete: "Preview network read",
  },
  webview_list: { running: "Listing previews", complete: "Previews listed" },
  webview_close: { running: "Closing preview", complete: "Preview closed" },
};

/**
 * Get the display label for any tool call, with bash command parsing.
 */
export function getToolDisplayLabel(toolCall: ToolCallLike): string {
  const toolName = toolCall.toolName ?? "tool";
  const isRunning = toolCall.status === "calling";

  if (toolName === "bash" && typeof toolCall.args?.command === "string") {
    return getBashCommandDescription(toolCall.args.command, isRunning);
  }

  // Browser tools - show URL/domain
  if (toolName === "browser_navigate" && typeof toolCall.args?.url === "string") {
    const url = toolCall.args.url as string;
    try {
      const domain = new URL(url).hostname.replace(/^www\./, "");
      return isRunning ? `Navigating to ${domain}` : `Navigated to ${domain}`;
    } catch {
      return isRunning ? "Navigating browser" : "Browser navigated";
    }
  }

  if (toolName === "browser_snapshot") {
    return isRunning ? "Reading page" : "Page read";
  }

  if (toolName === "browser_click" && typeof toolCall.args?.ref === "string") {
    const ref = toolCall.args.ref as string;
    // Extract meaningful text if available (e.g., "ref-123 (Submit)")
    return isRunning ? "Clicking element" : "Clicked element";
  }

  if (toolName === "browser_type" && typeof toolCall.args?.text === "string") {
    const text = (toolCall.args.text as string).substring(0, 20);
    return isRunning ? `Typing "${text}"${text.length > 20 ? "..." : ""}` : "Text entered";
  }

  // Search tools - show what we're searching for
  if (toolName === "search_files" && typeof toolCall.args?.query === "string") {
    const query = (toolCall.args.query as string).substring(0, 30);
    return isRunning 
      ? `Searching for "${query}"${query.length > 30 ? "..." : ""}`
      : `Searched for "${query}"${query.length > 30 ? "..." : ""}`;
  }

  if (toolName === "search_agent_memory" && typeof toolCall.args?.query === "string") {
    const query = (toolCall.args.query as string).substring(0, 30);
    return isRunning 
      ? `Searching memory for "${query}"${query.length > 30 ? "..." : ""}`
      : `Found in memory`;
  }

  // File operations - show filename
  if ((toolName === "read_file" || toolName === "write_file") && typeof toolCall.args?.path === "string") {
    const filename = getDisplayFilename(toolCall.args.path as string);
    if (filename) {
      return toolName === "read_file"
        ? (isRunning ? `Reading ${filename}` : `Read ${filename}`)
        : (isRunning ? `Writing ${filename}` : `Wrote ${filename}`);
    }
  }

  if (toolName === "list_directory" && typeof toolCall.args?.path === "string") {
    const dirname = getDisplayFilename(toolCall.args.path as string) || "directory";
    return isRunning ? `Listing ${dirname}` : `Listed ${dirname}`;
  }

  const desc = TOOL_DESCRIPTIONS[toolName];
  if (desc) return isRunning ? desc.running : desc.complete;

  // Fallback: snake_case → Title Case words
  const friendly = toolName.replace(/_/g, " ");
  return isRunning ? `${friendly}...` : friendly;
}
