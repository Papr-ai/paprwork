/**
 * Tool execution types
 */

/**
 * Generic tool result
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  type?: string; // Error type for failures
  duration?: number; // Execution time in ms (optional)
  timestamp?: string; // ISO timestamp (optional)
}

/**
 * Tool execution metadata
 */
export interface ToolExecution {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  startTime: string;
  endTime: string;
}

/**
 * Bash tool specific types
 */
export interface BashToolInput {
  command: string;
  workingDirectory?: string;
  timeout?: number;
}

export interface BashToolOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Filesystem tool types
 */
export interface ReadToolInput {
  path: string;
  encoding?: string;
}

export interface ReadToolOutput {
  content: string;
  size: number;
}

export interface WriteToolInput {
  path: string;
  content: string;
  encoding?: string;
}

export interface WriteToolOutput {
  bytesWritten: number;
  path: string;
}

export interface EditToolInput {
  path: string;
  oldString: string;
  newString: string;
}

export interface EditToolOutput {
  success: boolean;
  linesChanged: number;
}

/**
 * Tool registry types
 */
import type { ZodSchema } from "zod";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  inputSchema: ZodSchema<TInput>;
  execute: (input: TInput) => Promise<ToolResult<TOutput>>;
}
