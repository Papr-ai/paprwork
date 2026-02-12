/**
 * Tool type aliases
 *
 * Mastra's Tool type has 7 generic parameters, making it verbose to use.
 * We create type-safe aliases here instead of using 'any'.
 */

import type { Tool, ToolExecutionContext } from "@mastra/core/tools";

/**
 * A Mastra tool with unknown type parameters
 * This is type-safe (unlike 'any') and represents any tool type
 */
export type AnyTool = Tool<
  unknown, // TSchemaIn
  unknown, // TSchemaOut
  unknown, // TSuspendSchema
  unknown, // TResumeSchema
  ToolExecutionContext<unknown, unknown, unknown>, // TContext
  string, // TId
  unknown // TRequestContext
>;
