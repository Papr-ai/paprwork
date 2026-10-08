/**
 * The one place Pen access is checked: every MCP tool call (Pen chat, agent
 * jobs, mini-apps via /api/mcp/call, Python jobs via papr_mcp) goes through
 * McpConnectionService.callTool, which calls this gate first.
 */
import { decidePenAccess, effectivePenAccess, PenAccessDeniedError } from "./mcpPenAccess.js";

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
export type PenGate = (serverId: string, tool: string, annotations: ToolAnnotations) => Promise<void>;

export interface PenGateDeps {
  /** The sign-in's own level (unset for older sign-ins). */
  keyLevel: (serverId: string) => Promise<unknown>;
  /** The org's maxPenAccess, or undefined when there is no org policy. */
  orgMax: () => Promise<unknown>;
  serverName: (serverId: string) => Promise<string> | string;
  /** Show the existing approval prompt; resolve true when the user allows it. */
  ask: (serverId: string, serverName: string, tool: string) => Promise<boolean>;
}

export function createPenGate(deps: PenGateDeps): PenGate {
  return async (serverId, tool, annotations) => {
    const level = effectivePenAccess(await deps.keyLevel(serverId), await deps.orgMax());
    const decision = decidePenAccess(level, annotations);
    if (decision === "allow") return;
    const name = await deps.serverName(serverId);
    if (decision === "deny") throw new PenAccessDeniedError(name, tool, "read_only");
    if (!(await deps.ask(serverId, name, tool))) throw new PenAccessDeniedError(name, tool, "declined");
  };
}
