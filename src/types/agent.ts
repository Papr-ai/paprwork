/**
 * Agent Configuration Types
 */

export interface AgentConfig {
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  apiKey: string;
  systemPrompt?: string;
}
