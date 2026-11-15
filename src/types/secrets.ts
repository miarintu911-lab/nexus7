export type AgentRole = 'architect' | 'coder' | 'debugger';

export interface ActionStep {
  id: string;
  kind: 'command' | 'thought' | 'tool' | 'file' | 'read' | 'edit' | 'build' | 'qc' | 'restart' | 'respond' | 'agent';
  label: string;
  agentRole?: AgentRole;
  status?: 'running' | 'done' | 'error';
  toolName?: string;
  filePath?: string;
  durationSec?: number;
  timestamp?: number;
  details?: string;
  output?: string;
  isError?: boolean;
}

export interface KeyMetadata {
  keyId?: string;
  keyName?: string;
  model?: string;
  provider?: string;
  isCustomKey?: boolean;
}

export type ApiProviderId = 'gemini' | 'openrouter' | 'huggingface' | 'deepseek' | 'groq' | 'cerebras' | 'mistral' | 'grok' | 'custom';

export type KeyRoleTier = 'auto' | 'architect' | 'builder' | 'fast';

export interface KeyConfig {
  id: string;
  provider: ApiProviderId;
  name: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  isActive: boolean;
  rpmLimit: number;
  tpmLimit?: number;
  roleTier?: KeyRoleTier;
  status?: 'healthy' | 'cooldown' | 'error';
  cooldownRemainingSec?: number;
  requestsThisMinute?: number;
  tokensThisMinute?: number;
  inFlightRequests?: number;
  requestsToday?: number;
  totalRequests?: number;
  lastError?: string | null;
  apiKeyMasked?: string;
}
