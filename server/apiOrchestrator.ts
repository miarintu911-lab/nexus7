import { GoogleGenAI, Type, ThinkingLevel, type FunctionDeclaration } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { Response } from "express";
import { serverTools, executeServerTool, type ToolExecutionContext } from "./geminiService.ts";
import { autoDeployWebsiteFromText, getNexusSystemInstruction, inferWebsiteDesignBrief, prepareGeminiHistoryAndLastMessage, type InlineImageAttachment, type SystemInstructionOptions } from "./websiteDeployer.ts";
import { verifyLivePreviewWithDom, createCheckpoint } from "./workspaceEngine.ts";
import { sanitizeSessionId, startWorkspaceServer, buildWorkspaceToStaticPreview } from "./sandboxManager.ts";
import { loadSecretsFromPersistence, saveSecretsToPersistence } from "./persistenceStore.ts";
import { runVisualQaReview } from "./visualQa.ts";
import { auditFirestoreRules } from "./firebaseProvisioner.ts";
import {
  buildHarnessPreFlightContext,
  checkApiContracts,
  extractTargetedErrorContext,
  isFreshGreenfieldWebsiteBuild,
  isGitHubClonePrompt,
  lookupErrorKnowledgeBase,
  recordErrorFixResolution,
  runCrossModelCritic,
  shouldUseModularArchitecture,
} from "./harnessEngine.ts";

const execPromise = promisify(exec);

export class JobCancelledError extends Error {
  public readonly isCancelled = true;
  constructor(message: string = 'Request cancelled by user') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

export function isAbortOrCancelError(err: any, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!err) return false;
  return Boolean(
    err instanceof JobCancelledError ||
    err?.isCancelled === true ||
    err?.name === 'AbortError' ||
    err?.name === 'JobCancelledError'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new JobCancelledError();
  }
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof (AbortSignal as any).any === 'function') {
    return (AbortSignal as any).any(active);
  }
  const ctrl = new AbortController();
  for (const s of active) {
    if (s.aborted) {
      ctrl.abort();
      return ctrl.signal;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new JobCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    promise.catch(() => {});
    return Promise.reject(new JobCancelledError());
  }
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(new JobCancelledError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(isAbortOrCancelError(err, signal) ? new JobCancelledError() : err);
      }
    );
  });
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
  lastError?: string | null;
}

interface KeyRuntimeStats {
  timestamps: number[]; // timestamps in last 60s
  tokenTimestamps: Array<{ ts: number; tokens: number }>; // estimated tokens in last 60s
  inFlightCount: number; // concurrent active requests using this key
  dailyRequests: number;
  dailyResetDate: string; // YYYY-MM-DD UTC
  cooldownUntil: number;
  totalRequests: number;
  lastError: string | null;
  lastUsedAt: number;
}

const keyStatsMap = new Map<string, KeyRuntimeStats>();

const FREE_PROVIDER_DEFAULTS: Record<string, { rpm: number; tpm: number }> = {
  gemini: { rpm: 15, tpm: 250_000 },
  groq: { rpm: 30, tpm: 6_000 },
  cerebras: { rpm: 30, tpm: 60_000 },
  openrouter: { rpm: 20, tpm: 40_000 },
  huggingface: { rpm: 20, tpm: 40_000 },
  deepseek: { rpm: 30, tpm: 100_000 },
  mistral: { rpm: 20, tpm: 50_000 },
  grok: { rpm: 20, tpm: 40_000 },
  custom: { rpm: 20, tpm: 40_000 },
};

export function inferKeyRoleTier(model: string, explicit?: KeyRoleTier): Exclude<KeyRoleTier, 'auto'> {
  if (explicit && explicit !== 'auto') return explicit;
  const m = (model || '').toLowerCase();
  if (/(pro|hydrogen|argon|carbon|deepseek-r1|deepseek-reasoner|deepseek-v3|qwen3-coder|qwen2\.5-coder-32b|qwen2\.5-72b|480b|120b|70b|devstral|deepseek-chat|grok-3)/i.test(m)) {
    return 'architect';
  }
  if (/(flash-lite|8b|7b|instant|nemotron|flint|openrouter\/free|small-latest|small-3\.1)/i.test(m)) {
    return 'fast';
  }
  return 'builder';
}

export function getKeyEffectiveCaps(k: KeyConfig): {
  rawRpmLimit: number;
  rawTpmLimit: number;
  safeRpmCap: number;
  safeTpmCap: number;
} {
  const def = FREE_PROVIDER_DEFAULTS[k.provider] || FREE_PROVIDER_DEFAULTS.custom;
  const rawRpmLimit = Math.max(3, k.rpmLimit || def.rpm);
  const rawTpmLimit = Math.max(3000, k.tpmLimit || def.tpm);
  // Strict 80% ceiling so no key crosses its 1-minute provider limit
  const safeRpmCap = Math.max(2, Math.floor(rawRpmLimit * 0.8));
  const safeTpmCap = Math.max(2500, Math.floor(rawTpmLimit * 0.8));
  return { rawRpmLimit, rawTpmLimit, safeRpmCap, safeTpmCap };
}

function acquireKeyInFlight(keyId?: string): void {
  if (!keyId) return;
  const s = getOrCreateStats(keyId);
  s.inFlightCount = Math.max(0, s.inFlightCount) + 1;
}

function releaseKeyInFlight(keyId?: string): void {
  if (!keyId) return;
  const s = getOrCreateStats(keyId);
  s.inFlightCount = Math.max(0, s.inFlightCount - 1);
}

// Speed-first ranking when load-balancing across multiple healthy providers (vision prompts still prefer Gemini)
const PROVIDER_SPEED_RANK: Record<string, number> = {
  cerebras: 1,
  groq: 2,
  deepseek: 3,
  gemini: 4,
  mistral: 5,
  huggingface: 6,
  grok: 7,
  custom: 8,
  openrouter: 9,
};

// Circuit-breaker for temporarily dead/unavailable provider models (keyed by `${provider}::${model}`)
const modelOutageMap = new Map<string, number>();

export function isModelInOutage(provider: string, model: string): boolean {
  const key = `${provider}::${model}`;
  const blockedUntil = modelOutageMap.get(key) || 0;
  if (blockedUntil <= Date.now()) {
    if (blockedUntil > 0) modelOutageMap.delete(key);
    return false;
  }
  return true;
}

export function markModelOutage(provider: string, model: string, durationSec: number = 600): void {
  if (!model) return;
  modelOutageMap.set(`${provider}::${model}`, Date.now() + durationSec * 1000);
}

export const OPENROUTER_FALLBACK_CHAIN = [
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3.5-lightning:free',
  'recursive/flint-v1.0:free',
  'openrouter/free',
] as const;

export const HUGGINGFACE_FALLBACK_CHAIN = [
  'deepseek-ai/DeepSeek-V4-Flash:cheapest',
  'Qwen/Qwen3-32B:cheapest',
  'Qwen/Qwen3.5-9B:cheapest',
  'openai/gpt-oss-20b:cheapest',
  'google/gemma-3-27b-it:cheapest',
  'meta-llama/Llama-3.1-8B-Instruct:cheapest',
] as const;

export const DEEPSEEK_FALLBACK_CHAIN = [
  'deepseek-chat',
  'deepseek-reasoner',
] as const;

export function getOpenRouterModelChain(preferredModel?: string | null): string[] {
  const clean = (preferredModel || '').trim();
  const baseChain = [...OPENROUTER_FALLBACK_CHAIN];
  if (
    !clean ||
    clean === 'openrouter/free' ||
    (OPENROUTER_FALLBACK_CHAIN as readonly string[]).includes(clean)
  ) {
    return baseChain;
  }
  return [clean, ...baseChain];
}

export function getHuggingFaceModelChain(preferredModel?: string | null): string[] {
  const clean = (preferredModel || '').trim();
  const baseChain = [...HUGGINGFACE_FALLBACK_CHAIN];
  const combined = !clean
    ? baseChain
    : [clean, ...baseChain.filter((m) => m !== clean)];
  const available = combined.filter((m) => !isModelInOutage('huggingface', m));
  return available.length > 0 ? available : combined;
}

export function getDeepSeekModelChain(preferredModel?: string | null): string[] {
  const clean = (preferredModel || '').trim();
  const baseChain = [...DEEPSEEK_FALLBACK_CHAIN];
  const combined = !clean
    ? baseChain
    : [clean, ...baseChain.filter((m) => m !== clean)];
  const available = combined.filter((m) => !isModelInOutage('deepseek', m));
  return available.length > 0 ? available : combined;
}

export function getProviderModelChain(provider: string, preferredModel?: string | null): string[] {
  if (provider === 'openrouter') {
    return getOpenRouterModelChain(preferredModel);
  }
  if (provider === 'huggingface') {
    return getHuggingFaceModelChain(preferredModel);
  }
  if (provider === 'deepseek') {
    return getDeepSeekModelChain(preferredModel);
  }
  const chains: Record<string, string[]> = {
    gemini: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen', 'gemini-3.8-flash'],
    groq: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'llama-3.1-8b-instant'],
    cerebras: ['llama-3.3-70b', 'qwen-3-32b', 'llama3.1-8b'],
    mistral: ['codestral-latest', 'mistral-small-latest', 'devstral-small-latest'],
    grok: ['grok-3-mini', 'grok-2-latest'],
  };
  const base = chains[provider] || [];
  const combined = preferredModel ? [preferredModel, ...base.filter((m) => m !== preferredModel)] : base;
  const available = combined.filter((m) => !isModelInOutage(provider, m));
  return available.length > 0 ? available : combined;
}

export async function fetchOpenRouterWithFallback(options: {
  apiKey: string;
  messages: any[];
  preferredModel?: string | null;
  max_tokens?: number;
  timeoutMs?: number;
  onFallback?: (info: {
    failedModel: string;
    nextModel: string;
    reason: string;
    attempt: number;
    total: number;
  }) => void;
}): Promise<{ response: globalThis.Response; model: string; data: any }> {
  const chain = getOpenRouterModelChain(options.preferredModel);
  const errors: Array<{ model: string; status: number; message: string }> = [];

  for (let idx = 0; idx < chain.length; idx++) {
    const candidateModel = chain[idx];
    const bodyPayload: Record<string, any> = {
      model: candidateModel,
      messages: options.messages,
      stream: false,
    };
    if (typeof options.max_tokens === 'number') {
      bodyPayload.max_tokens = options.max_tokens;
    }

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://nexus-ai.local',
          'X-Title': 'Nexus AI',
        },
        body: JSON.stringify(bodyPayload),
        ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error && data?.choices?.[0]?.message) {
        return { response: res, model: candidateModel, data };
      }

      const rawMsg =
        data?.error?.message ||
        data?.error?.metadata?.raw ||
        `HTTP ${res.status}: ${res.statusText || 'OpenRouter error'}`;
      const status = Number(data?.error?.code || res.status || 502);

      // Invalid/expired OpenRouter API key affects all models equally
      if (status === 401 || /User not found|Invalid API key|Unauthorized/i.test(rawMsg)) {
        const authErr = new Error(
          rawMsg.includes('User not found')
            ? 'User not found: এই OpenRouter কী-টি অকার্যকর বা মেয়াদোত্তীর্ণ।'
            : rawMsg
        );
        (authErr as any).status = 401;
        throw authErr;
      }

      errors.push({ model: candidateModel, status, message: rawMsg });
      addSystemLog({
        level: 'warn',
        category: status === 429 ? 'rate_limit' : 'rotation',
        provider: 'openrouter',
        model: candidateModel,
        message: `OpenRouter fallback: ${candidateModel} failed (${status}) -> ${
          idx < chain.length - 1 ? chain[idx + 1] : 'NO MORE BACKUPS'
        }`,
        details: rawMsg,
      });

      if (idx < chain.length - 1) {
        options.onFallback?.({
          failedModel: candidateModel,
          nextModel: chain[idx + 1],
          reason: rawMsg,
          attempt: idx + 1,
          total: chain.length,
        });
        continue;
      }
    } catch (err: any) {
      if (err?.status === 401) throw err;
      const errMsg = String(err?.message || err || 'Network error');
      const status = Number(err?.status || 503);
      errors.push({ model: candidateModel, status, message: errMsg });
      addSystemLog({
        level: 'warn',
        category: 'network',
        provider: 'openrouter',
        model: candidateModel,
        message: `OpenRouter fallback: ${candidateModel} threw error -> ${
          idx < chain.length - 1 ? chain[idx + 1] : 'NO MORE BACKUPS'
        }`,
        details: errMsg,
      });
      if (idx < chain.length - 1) {
        options.onFallback?.({
          failedModel: candidateModel,
          nextModel: chain[idx + 1],
          reason: errMsg,
          attempt: idx + 1,
          total: chain.length,
        });
        continue;
      }
    }
  }

  const last = errors[errors.length - 1];
  const summary = errors.map((e) => `${e.model} [${e.status}]`).join(' → ');
  const finalErr = new Error(
    `OpenRouter-এর সবকটি মডেল (${summary}) ফেইল বা রেট-লিমিট হয়েছে। শেষ ব্যাকআপ "openrouter/free"-ও কাজ করেনি: ${last?.message || 'Unknown error'}`
  );
  (finalErr as any).status = last?.status || 502;
  (finalErr as any).allOpenRouterModelsFailed = true;
  throw finalErr;
}

export async function fetchHuggingFaceWithFallback(options: {
  apiKey: string;
  messages: any[];
  preferredModel?: string | null;
  max_tokens?: number;
  timeoutMs?: number;
  onFallback?: (info: {
    failedModel: string;
    nextModel: string;
    reason: string;
    attempt: number;
    total: number;
  }) => void;
}): Promise<{ response: globalThis.Response; model: string; data: any }> {
  const baseChain = getHuggingFaceModelChain(options.preferredModel);
  const preferredBase = (baseChain[0] || 'deepseek-ai/DeepSeek-V4-Flash').replace(/:.+$/, '');
  const cheapestCandidates = [
    `${preferredBase}:cheapest`,
    'Qwen/Qwen3.5-9B:cheapest',
    'meta-llama/Llama-3.1-8B-Instruct:cheapest',
  ];
  const chain: string[] = [];
  for (const m of [...baseChain, ...cheapestCandidates]) {
    if (m && !chain.includes(m)) chain.push(m);
  }
  const errors: Array<{ model: string; status: number; message: string }> = [];
  let payment402Count = 0;

  const formatHf402Message = (raw: string) =>
    `Hugging Face Router (402): Hugging Face-এ ফ্রি অ্যাকাউন্টের জন্য এখন কোনো $0 ফ্রি চ্যাট মডেল বা মাসিক ফ্রি ক্রেডিট নেই (${raw})। HF অ্যাকাউন্টে ক্রেডিট/PRO অথবা HF Settings > Inference Providers-এ BYOK সেট করা না থাকলে সব মডেলেই 402 আসে — একদম ফ্রিতে চালাতে OpenRouter (:free), Groq বা Cerebras ব্যবহার করুন।`;

  for (let idx = 0; idx < chain.length; idx++) {
    const candidateModel = chain[idx];
    const bodyPayload: Record<string, any> = {
      model: candidateModel,
      messages: options.messages,
      stream: false,
    };
    if (typeof options.max_tokens === 'number') {
      bodyPayload.max_tokens = options.max_tokens;
    }

    try {
      const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyPayload),
        ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      });

      const data = await res.json().catch(() => null);
      if (res.ok && !data?.error && data?.choices?.[0]?.message) {
        return { response: res, model: candidateModel, data };
      }

      const rawMsg =
        (typeof data?.error === 'string' ? data.error : data?.error?.message) ||
        data?.message ||
        `HTTP ${res.status}: ${res.statusText || 'Hugging Face Router error'}`;
      const status = Number(data?.error?.code || res.status || 502);

      if (status === 401 || status === 403 || /Invalid credentials|Unauthorized|sufficient permissions/i.test(rawMsg)) {
        const authErr = new Error(
          status === 403 || /permissions/i.test(rawMsg)
            ? `Hugging Face টোকেনে Inference Providers পারমিশন নেই (${rawMsg})। huggingface.co/settings/tokens থেকে "Make calls to Inference Providers" অন করে টোকেন দিন।`
            : `অকার্যকর Hugging Face টোকেন (hf_...): ${rawMsg}`
        );
        (authErr as any).status = status === 403 ? 403 : 401;
        throw authErr;
      }

      if (status === 402 || /exceeded.*monthly.*credits|payment required/i.test(rawMsg)) {
        payment402Count++;
        errors.push({ model: candidateModel, status: 402, message: rawMsg });

        if (payment402Count === 1) {
          const cheapestIdx = chain.findIndex((m, j) => j > idx && (m.endsWith(':cheapest') || /Llama-3\.1-8B|Qwen3\.5-9B|gpt-oss-20b/i.test(m)));
          if (cheapestIdx > idx) {
            options.onFallback?.({
              failedModel: candidateModel,
              nextModel: chain[cheapestIdx],
              reason: `402 on ${candidateModel}: ${rawMsg}`,
              attempt: idx + 1,
              total: chain.length,
            });
            idx = cheapestIdx - 1;
            continue;
          }
        }

        const creditErr = new Error(formatHf402Message(rawMsg));
        (creditErr as any).status = 402;
        throw creditErr;
      }

      errors.push({ model: candidateModel, status, message: rawMsg });
      addSystemLog({
        level: 'warn',
        category: status === 429 ? 'rate_limit' : 'rotation',
        provider: 'huggingface',
        model: candidateModel,
        message: `Hugging Face Router fallback: ${candidateModel} failed (${status}) -> ${
          idx < chain.length - 1 ? chain[idx + 1] : 'NO MORE BACKUPS'
        }`,
        details: rawMsg,
      });

      if (idx < chain.length - 1) {
        options.onFallback?.({
          failedModel: candidateModel,
          nextModel: chain[idx + 1],
          reason: rawMsg,
          attempt: idx + 1,
          total: chain.length,
        });
        continue;
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 402 || err?.status === 403) throw err;
      const errMsg = String(err?.message || err || 'Network error');
      const status = Number(err?.status || 503);
      errors.push({ model: candidateModel, status, message: errMsg });
      addSystemLog({
        level: 'warn',
        category: 'network',
        provider: 'huggingface',
        model: candidateModel,
        message: `Hugging Face Router fallback: ${candidateModel} threw error -> ${
          idx < chain.length - 1 ? chain[idx + 1] : 'NO MORE BACKUPS'
        }`,
        details: errMsg,
      });
      if (idx < chain.length - 1) {
        options.onFallback?.({
          failedModel: candidateModel,
          nextModel: chain[idx + 1],
          reason: errMsg,
          attempt: idx + 1,
          total: chain.length,
        });
        continue;
      }
    }
  }

  const last = errors[errors.length - 1];
  const summary = errors.map((e) => `${e.model} [${e.status}]`).join(' → ');
  const finalErr = new Error(
    `Hugging Face Router-এর সবকটি মডেল (${summary}) ফেইল বা রেট-লিমিট হয়েছে: ${last?.message || 'Unknown error'}`
  );
  (finalErr as any).status = last?.status || 502;
  throw finalErr;
}

export interface SystemLogEntry {
  id: string;
  timestamp: number;
  level: 'error' | 'warn' | 'info' | 'success';
  category: 'auth' | 'rate_limit' | 'rotation' | 'execution' | 'network';
  keyName?: string;
  provider?: string;
  model?: string;
  message: string;
  details?: string;
}

const systemLogs: SystemLogEntry[] = [];
const MAX_LOGS = 200;

export function addSystemLog(log: Omit<SystemLogEntry, 'id' | 'timestamp'>) {
  const entry: SystemLogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    ...log
  };
  systemLogs.unshift(entry);
  if (systemLogs.length > MAX_LOGS) {
    systemLogs.pop();
  }
}

export function getSystemLogs(): SystemLogEntry[] {
  return systemLogs;
}

export function clearSystemLogs(): void {
  systemLogs.length = 0;
}

import fsSync from "fs";

// Track last successful responding key persistently so Nexus remembers and prioritizes it across turns & restarts
const STICKY_KEY_FILE = path.resolve(process.cwd(), '.nexus_sticky_key.json');
let lastSuccessfulKeyId: string | null = (() => {
  try {
    const raw = fsSync.readFileSync(STICKY_KEY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.keyId === 'string' ? parsed.keyId : null;
  } catch {
    return null;
  }
})();

export function getLastSuccessfulKeyId(): string | null {
  return lastSuccessfulKeyId;
}

function persistStickyKeyId(keyId: string | null) {
  lastSuccessfulKeyId = keyId;
  fs.writeFile(STICKY_KEY_FILE, JSON.stringify({ keyId, updatedAt: Date.now() }), 'utf-8').catch(() => {});
}

const SECRETS_FILE = path.resolve(process.cwd(), '.secrets.json');

export function getOpenAICompatibleEndpoint(provider: string, baseUrl?: string): string {
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1/chat/completions';
  if (provider === 'huggingface') return 'https://router.huggingface.co/v1/chat/completions';
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1/chat/completions';
  if (provider === 'groq') return 'https://api.groq.com/openai/v1/chat/completions';
  if (provider === 'cerebras') return 'https://api.cerebras.ai/v1/chat/completions';
  if (provider === 'mistral') return 'https://api.mistral.ai/v1/chat/completions';
  if (provider === 'grok') return 'https://api.x.ai/v1/chat/completions';
  const clean = (baseUrl || 'https://models.inference.ai.azure.com').trim().replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

export async function fetchLiveProviderModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string
): Promise<Array<{ id: string; label: string; badge: string }>> {
  const curated: Record<string, Array<{ id: string; label: string; badge: string }>> = {
    gemini: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', badge: 'Free · Ultra Fast' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', badge: 'Free · Coding' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', badge: 'Free · 1500 RPD' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', badge: 'Pro · Architecture' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', badge: 'Deep Reasoning' },
    ],
    openrouter: [
      { id: 'cohere/north-mini-code:free', label: 'Cohere North Mini Code (:free)', badge: 'Primary · Coding' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'NVIDIA Nemotron 3.5 Lightning (:free)', badge: 'Fallback 2 · Fast' },
      { id: 'recursive/flint-v1.0:free', label: 'Recursive Flint v1.0 (:free)', badge: 'Fallback 3 · Free' },
      { id: 'openrouter/free', label: 'OpenRouter Free Auto-Router', badge: 'Ultimate Backup' },
      { id: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B (:free)', badge: 'Free · Coding' },
      { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (:free)', badge: 'Free · Reasoning' },
      { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek Chat V3 (:free)', badge: 'Free · General' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B Instruct (:free)', badge: 'Free · 70B' },
      { id: 'google/gemma-3-27b-it:free', label: 'Gemma 3 27B (:free)', badge: 'Free · Google' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct:free', label: 'Mistral Small 3.1 24B (:free)', badge: 'Free · Fast' },
    ],
    huggingface: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash:cheapest', label: 'DeepSeek V4 Flash (:cheapest)', badge: 'Primary · $0.18/1M' },
      { id: 'Qwen/Qwen3-32B:cheapest', label: 'Qwen 3 32B (:cheapest)', badge: 'Coding · $0.28/1M' },
      { id: 'Qwen/Qwen3.5-9B:cheapest', label: 'Qwen 3.5 9B (:cheapest)', badge: 'Light · $0.15/1M' },
      { id: 'openai/gpt-oss-20b:cheapest', label: 'GPT-OSS 20B (:cheapest)', badge: 'Fast · $0.14/1M' },
      { id: 'google/gemma-3-27b-it:cheapest', label: 'Gemma 3 27B IT (:cheapest)', badge: '27B · $0.16/1M' },
      { id: 'meta-llama/Llama-3.1-8B-Instruct:cheapest', label: 'Llama 3.1 8B Instruct (:cheapest)', badge: 'Cheapest · $0.05/1M' },
      { id: 'zai-org/GLM-4.7-Flash:cheapest', label: 'GLM 4.7 Flash (:cheapest)', badge: 'Flash · $0.40/1M' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct:cheapest', label: 'Llama 3.3 70B Instruct (:cheapest)', badge: '70B · $0.40/1M' },
    ],
    deepseek: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', badge: 'Coding · Tool Calling' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', badge: 'Deep Reasoning' },
    ],
    groq: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', badge: 'Free · Coding' },
      { id: 'qwen/qwen3-32b', label: 'Qwen 3 32B', badge: 'Free · Reasoning' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', badge: 'Free · Instant' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', badge: 'Free · 120B' },
    ],
    cerebras: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', badge: 'Free · Fast' },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', badge: 'Free · Coding' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B', badge: 'Free · Instant' },
    ],
    mistral: [
      { id: 'codestral-latest', label: 'Codestral Latest', badge: 'Free · Coding' },
      { id: 'mistral-small-latest', label: 'Mistral Small Latest', badge: 'Free · Fast' },
      { id: 'devstral-small-latest', label: 'Devstral Small', badge: 'Free · Agents' },
    ],
    grok: [
      { id: 'grok-2-latest', label: 'Grok 2 Latest', badge: 'Default' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', badge: 'Fast' },
    ],
    custom: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', badge: 'Custom' },
      { id: 'deepseek-r1', label: 'deepseek-r1', badge: 'Custom' },
      { id: 'qwen2.5-coder-32b-instruct', label: 'qwen2.5-coder-32b-instruct', badge: 'Custom' },
    ],
  };

  try {
    if (provider === 'openrouter') {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const rawModels: any[] = json.data || [];
        const freeModels = rawModels
          .filter(m => String(m.id || '').endsWith(':free') || m.id === 'openrouter/free' || (m.pricing?.prompt === '0' && m.pricing?.completion === '0'))
          .slice(0, 40)
          .map(m => ({
            id: m.id,
            label: m.name || m.id,
            badge: 'Free · Live',
          }));
        if (freeModels.length > 0) {
          const hasAuto = freeModels.some(m => m.id === 'openrouter/free');
          return hasAuto
            ? freeModels
            : [{ id: 'openrouter/free', label: 'OpenRouter Free Auto-Router', badge: 'Free · Auto' }, ...freeModels];
        }
      }
    } else if (provider === 'huggingface') {
      const res = await fetch('https://router.huggingface.co/v1/models', {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const rawModels: any[] = json.data || [];
        const withLowestPrice = rawModels
          .filter((m) => Boolean(m?.id))
          .map((m) => {
            const liveProviders = Array.isArray(m.providers) ? m.providers.filter((p: any) => p.status === 'live') : [];
            const prices = liveProviders
              .map((p: any) => (typeof p?.pricing?.output === 'number' ? Number(p.pricing.output) : null))
              .filter((v: number | null): v is number => v !== null);
            const hasFreeFlag = liveProviders.some((p: any) => p?.is_free === true);
            const minOut = hasFreeFlag ? 0 : prices.length > 0 ? Math.min(...prices) : 999;
            return { id: String(m.id), minOut, hasFreeFlag };
          })
          .sort((a, b) => a.minOut - b.minOut);

        const hfModels = withLowestPrice.slice(0, 45).map((m) => {
          const shortName = m.id.split('/').pop() || m.id;
          const badge = m.hasFreeFlag
            ? 'Free · Live'
            : m.minOut < 999
              ? `:cheapest · $${m.minOut.toFixed(2)}/1M`
              : 'HF Router · :cheapest';
          return {
            id: m.id.includes(':') ? m.id : `${m.id}:cheapest`,
            label: `${shortName} (:cheapest)`,
            badge,
          };
        });
        if (hfModels.length > 0) return hfModels;
      }
    } else if (provider === 'gemini' && apiKey) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const live = (json.models || [])
          .filter((m: any) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
          .map((m: any) => {
            const id = String(m.name || '').replace(/^models\//, '');
            return { id, label: m.displayName || id, badge: 'Live · Gemini' };
          })
          .filter((m: any) => !m.id.includes('1.0') && !m.id.includes('1.5'))
          .slice(0, 25);
        if (live.length > 0) return live;
      }
    } else if (['deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(provider) && apiKey) {
      const chatUrl = getOpenAICompatibleEndpoint(provider, baseUrl);
      const modelsUrl = chatUrl.replace(/\/chat\/completions$/, '/models');
      const res = await fetch(modelsUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = await res.json();
        const list = (json.data || [])
          .map((m: any) => ({
            id: m.id,
            label:
              provider === 'deepseek' && m.id === 'deepseek-chat'
                ? 'DeepSeek Chat (V3)'
                : provider === 'deepseek' && m.id === 'deepseek-reasoner'
                  ? 'DeepSeek Reasoner (R1)'
                  : m.id,
            badge: `Live · ${provider}`,
          }))
          .slice(0, 35);
        if (list.length > 0) return list;
      }
    }
  } catch (err) {
    console.warn(`Live model fetch failed for ${provider}:`, err);
  }

  return curated[provider] || curated.custom;
}

// Normalize any model name according to active @google/genai & free provider guidelines
export function normalizeModelName(provider: string, model?: string): string {
  if (provider === 'gemini') {
    if (!model) return 'gemini-3.5-flash-lite';
    const lower = model.toLowerCase().trim();
    // Re-route deprecated 2.5/2.0/1.5 models to gemini-3.5-flash-lite
    if (
      lower.includes('1.5') ||
      lower.includes('2.0') ||
      lower.includes('2.5') ||
      lower.includes('gemini-pro') ||
      lower.includes('flash-latest') ||
      lower === 'gemini-flash'
    ) {
      return 'gemini-3.5-flash-lite';
    }
    const validGeminiModels = [
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
      'gemini-3.1-flash-lite',
      'gemini-3.1-pro',
      'gemini-4-hydrogen',
      'gemini-4-argon',
      'gemini-4-carbon',
      'gemini-3.1-flash-lite-image',
      'gemini-nano-banana-2.1',
      'gemini-3-pro-image'
    ];
    if (validGeminiModels.includes(model)) return model;
    return model.startsWith('gemini-') ? model : 'gemini-3.8-flash';
  }
  if (provider === 'openrouter') {
    if (!model || model.trim() === '' || model.includes('gemini-2.0-flash-lite:free')) {
      return 'cohere/north-mini-code:free';
    }
    return model.trim();
  }
  if (provider === 'huggingface') {
    const clean = (model || '').trim().replace(/^hf:/i, '');
    if (!clean) {
      return 'deepseek-ai/DeepSeek-V4-Flash:cheapest';
    }
    const deprecatedMap: Record<string, string> = {
      'Qwen/Qwen2.5-Coder-32B-Instruct': 'Qwen/Qwen3-32B:cheapest',
      'Qwen/Qwen3-Coder-30B-A3B-Instruct': 'Qwen/Qwen3-32B:cheapest',
      'Qwen/Qwen2.5-7B-Instruct': 'Qwen/Qwen3.5-9B:cheapest',
    };
    if (deprecatedMap[clean]) return deprecatedMap[clean];
    return clean.includes(':') ? clean : `${clean}:cheapest`;
  }
  if (provider === 'deepseek') {
    const clean = (model || '').trim();
    if (!clean) return 'deepseek-chat';
    if (clean === 'deepseek-reasoner' || /deepseek-r1/i.test(clean)) return 'deepseek-reasoner';
    if (/deepseek-v3|deepseek-chat/i.test(clean)) return 'deepseek-chat';
    return clean;
  }
  if (provider === 'groq') {
    if (!model || model.trim() === '') return 'llama-3.3-70b-versatile';
    return model.trim();
  }
  if (provider === 'cerebras') {
    if (!model || model.trim() === '') return 'llama-3.3-70b';
    return model.trim();
  }
  if (provider === 'mistral') {
    if (!model || model.trim() === '') return 'codestral-latest';
    return model.trim();
  }
  if (provider === 'grok') {
    if (!model || model.trim() === '') return 'grok-2-latest';
    return model.trim();
  }
  if (provider === 'custom') {
    return (model || 'gpt-4o-mini').trim();
  }
  return model || '';
}

// Load stored secrets from disk (auto-hydrating from remote Postgres/Turso/SQLite if disk file is missing)
export async function loadSecrets(): Promise<KeyConfig[]> {
  try {
    const raw = await fs.readFile(SECRETS_FILE, 'utf-8');
    const parsed: KeyConfig[] = JSON.parse(raw);
    let modified = false;
    for (const k of parsed) {
      const normalized = normalizeModelName(k.provider, k.model);
      if (normalized !== k.model) {
        k.model = normalized;
        modified = true;
      }
    }
    if (modified) {
      await fs.writeFile(SECRETS_FILE, JSON.stringify(parsed, null, 2), 'utf-8').catch(() => {});
    }
    return parsed;
  } catch {
    const remote = await loadSecretsFromPersistence().catch(() => null);
    if (Array.isArray(remote) && remote.length > 0) {
      await fs.writeFile(SECRETS_FILE, JSON.stringify(remote, null, 2), 'utf-8').catch(() => {});
      return remote as KeyConfig[];
    }
    return [];
  }
}

// Save secrets to disk + persistent DB (Postgres/Turso/SQLite)
export async function saveSecrets(keys: KeyConfig[]): Promise<void> {
  try {
    for (const k of keys) {
      k.model = normalizeModelName(k.provider, k.model);
    }
    await fs.writeFile(SECRETS_FILE, JSON.stringify(keys, null, 2), 'utf-8');
    await saveSecretsToPersistence(keys).catch(() => {});
  } catch (err) {
    console.error("Failed to save secrets to disk:", err);
  }
}

function getTodayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Clean old timestamps, reset daily RPD counter at UTC midnight, and return stats
function getOrCreateStats(keyId: string): KeyRuntimeStats {
  const today = getTodayUtcDate();
  let stats = keyStatsMap.get(keyId);
  if (!stats) {
    stats = {
      timestamps: [],
      tokenTimestamps: [],
      inFlightCount: 0,
      dailyRequests: 0,
      dailyResetDate: today,
      cooldownUntil: 0,
      totalRequests: 0,
      lastError: null,
      lastUsedAt: 0,
    };
    keyStatsMap.set(keyId, stats);
  }
  const now = Date.now();
  stats.timestamps = stats.timestamps.filter(ts => now - ts < 60_000);
  stats.tokenTimestamps = stats.tokenTimestamps.filter(entry => now - entry.ts < 60_000);
  if (stats.dailyResetDate !== today) {
    stats.dailyRequests = 0;
    stats.dailyResetDate = today;
  }
  return stats;
}

function estimateTokensFromPayload(payload: unknown): number {
  try {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return Math.ceil(str.length / 4);
  } catch {
    return 500;
  }
}

// Check real-time status of all keys (including free RPD, safe RPM & estimated TPM)
export function getKeyPoolStatus(keys: KeyConfig[]) {
  const now = Date.now();
  return keys.map(k => {
    const stats = getOrCreateStats(k.id);
    const caps = getKeyEffectiveCaps(k);
    const inCooldown = stats.cooldownUntil > now;
    const cooldownRemainingSec = inCooldown ? Math.ceil((stats.cooldownUntil - now) / 1000) : 0;
    const requestsThisMinute = stats.timestamps.length;
    const tokensThisMinute = stats.tokenTimestamps.reduce((sum, e) => sum + e.tokens, 0);
    const resolvedTier = inferKeyRoleTier(k.model, k.roleTier);
    
    let status: 'healthy' | 'cooldown' | 'error' = 'healthy';
    if (inCooldown) status = 'cooldown';
    else if (stats.lastError && requestsThisMinute === 0) status = 'error';

    return {
      id: k.id,
      provider: k.provider,
      name: k.name,
      model: k.model,
      isActive: k.isActive,
      rpmLimit: caps.rawRpmLimit,
      tpmLimit: caps.rawTpmLimit,
      safeRpmCap: caps.safeRpmCap,
      safeTpmCap: caps.safeTpmCap,
      roleTier: resolvedTier,
      inFlightRequests: stats.inFlightCount,
      status,
      isPinned: k.id === lastSuccessfulKeyId,
      cooldownUntil: stats.cooldownUntil,
      cooldownRemainingSec,
      requestsThisMinute,
      tokensThisMinute,
      requestsToday: stats.dailyRequests,
      totalRequests: stats.totalRequests,
      lastError: stats.lastError,
      lastUsedAt: stats.lastUsedAt,
    };
  });
}

// Select the optimal key from a 1..40+ key pool:
// 1) Enforces strict 80% RPM + TPM headroom & in-flight concurrency locks so free keys never hit 1-min limits
// 2) Matches task role tier (architect / builder / fast) without stalling if that tier is busy
// 3) Distributes load evenly across all healthy free keys by utilization bucket + speed + LRU timestamp
export function selectBestKey(
  keys: KeyConfig[],
  preferredProvider: string = 'all',
  excludeKeyIds: Set<string> = new Set(),
  clientStickyKeyId?: string | null,
  options?: {
    requiresVision?: boolean;
    loadBalance?: boolean;
    desiredTier?: Exclude<KeyRoleTier, 'auto'>;
    estimatedTokens?: number;
  }
): { key: KeyConfig | null; reason?: string; healthyCount: number } {
  const now = Date.now();
  const estTokens = Math.max(400, options?.estimatedTokens || 1200);
  
  let candidates = keys.filter(k => k.isActive && !excludeKeyIds.has(k.id));

  if (preferredProvider && preferredProvider !== 'all') {
    const filtered = candidates.filter(k => k.provider === preferredProvider);
    if (filtered.length > 0) candidates = filtered;
  }

  if (candidates.length === 0) {
    return { key: null, reason: 'No active keys remaining to try.', healthyCount: 0 };
  }

  const readyKeys = candidates.filter(k => {
    const stats = getOrCreateStats(k.id);
    return stats.cooldownUntil <= now;
  });

  const nonPermanentErrorKeys = candidates.filter(k => {
    const stats = getOrCreateStats(k.id);
    return !stats.lastError?.includes('Invalid API key');
  });

  const effectiveReady = readyKeys.length > 0
    ? readyKeys
    : (nonPermanentErrorKeys.length > 0 ? nonPermanentErrorKeys : candidates);

  // Strict 80% RPM + TPM headroom + daily free RPD filter
  const underSafeCapsKeys = effectiveReady.filter(k => {
    const stats = getOrCreateStats(k.id);
    const caps = getKeyEffectiveCaps(k);
    const tpmUsed = stats.tokenTimestamps.reduce((s, e) => s + e.tokens, 0);
    const estDailyCap = k.provider === 'openrouter' ? 46 : 1450;
    const withinRpm = (stats.timestamps.length + stats.inFlightCount) < caps.safeRpmCap;
    const withinTpm = (tpmUsed + estTokens) <= caps.safeTpmCap;
    return withinRpm && withinTpm && stats.dailyRequests < estDailyCap;
  });

  // Fallback to raw RPM cap if all keys crossed 80% soft guard
  const underRawRpmKeys = underSafeCapsKeys.length > 0
    ? underSafeCapsKeys
    : effectiveReady.filter(k => {
        const stats = getOrCreateStats(k.id);
        const caps = getKeyEffectiveCaps(k);
        return (stats.timestamps.length + stats.inFlightCount) < caps.rawRpmLimit;
      });

  const pool = underRawRpmKeys.length > 0 ? underRawRpmKeys : effectiveReady;

  const customKeysPool = pool.filter(k => k.id !== 'studio_primary_key');
  const prioritizedPool = customKeysPool.length > 0 ? customKeysPool : pool;

  const useLoadBalancer =
    Boolean(options?.loadBalance) ||
    (preferredProvider === 'all' && prioritizedPool.length >= 3);

  const stickyId = lastSuccessfulKeyId || clientStickyKeyId || null;
  if (!useLoadBalancer && !options?.requiresVision && !options?.desiredTier && stickyId && !excludeKeyIds.has(stickyId)) {
    const preferredKey = prioritizedPool.find(k => k.id === stickyId);
    if (preferredKey) {
      return {
        key: preferredKey,
        reason: 'পূর্বের সচল কী অগ্রাধিকার পেয়েছে (Remembered Working Key)',
        healthyCount: prioritizedPool.length,
      };
    }
  }

  const tierPenalty = (k: KeyConfig): number => {
    if (!options?.desiredTier) return 0;
    const tier = inferKeyRoleTier(k.model, k.roleTier);
    if (tier === options.desiredTier) return 0;
    if (options.desiredTier === 'architect' && tier === 'builder') return 1;
    if (options.desiredTier === 'builder' && tier === 'architect') return 1;
    if (options.desiredTier === 'fast' && tier === 'builder') return 1;
    return 2;
  };

  prioritizedPool.sort((a, b) => {
    const statsA = getOrCreateStats(a.id);
    const statsB = getOrCreateStats(b.id);
    if (statsA.cooldownUntil !== statsB.cooldownUntil) {
      return statsA.cooldownUntil - statsB.cooldownUntil;
    }

    // If vision images are attached, prioritize Gemini or known multimodal OpenRouter models
    if (options?.requiresVision) {
      const aVision = a.provider === 'gemini' || /gemma|gemini|gpt-4o|vision|claude/i.test(a.model || '') ? 0 : 1;
      const bVision = b.provider === 'gemini' || /gemma|gemini|gpt-4o|vision|claude/i.test(b.model || '') ? 0 : 1;
      if (aVision !== bVision) return aVision - bVision;
    }

    // Deprioritize keys whose assigned model is currently in outage
    const aOutage = isModelInOutage(a.provider, normalizeModelName(a.provider, a.model)) ? 1 : 0;
    const bOutage = isModelInOutage(b.provider, normalizeModelName(b.provider, b.model)) ? 1 : 0;
    if (aOutage !== bOutage) return aOutage - bOutage;

    // Never collide parallel calls onto a key already in-flight when idle keys exist
    if (statsA.inFlightCount !== statsB.inFlightCount) {
      return statsA.inFlightCount - statsB.inFlightCount;
    }

    // Role-based tier matching (architect for planning/debug, builder for coding, fast for light jobs)
    const tPenA = tierPenalty(a);
    const tPenB = tierPenalty(b);
    if (tPenA !== tPenB) return tPenA - tPenB;

    // Compare combined RPM & TPM utilization in 10% buckets so idle keys across 20-40 keys always rotate cleanly
    const capsA = getKeyEffectiveCaps(a);
    const capsB = getKeyEffectiveCaps(b);
    const tpmA = statsA.tokenTimestamps.reduce((s, e) => s + e.tokens, 0);
    const tpmB = statsB.tokenTimestamps.reduce((s, e) => s + e.tokens, 0);
    const utilA = Math.floor(Math.max(statsA.timestamps.length / capsA.safeRpmCap, tpmA / capsA.safeTpmCap) * 10);
    const utilB = Math.floor(Math.max(statsB.timestamps.length / capsB.safeRpmCap, tpmB / capsB.safeTpmCap) * 10);
    if (utilA !== utilB) return utilA - utilB;

    // Speed-first provider ranking (Cerebras -> Groq -> Gemini -> Mistral -> OpenRouter)
    const speedA = PROVIDER_SPEED_RANK[a.provider] ?? 9;
    const speedB = PROVIDER_SPEED_RANK[b.provider] ?? 9;
    if (speedA !== speedB && prioritizedPool.length < 6) return speedA - speedB;

    // Least-recently-used ensures all 20-40 keys share load evenly
    return statsA.lastUsedAt - statsB.lastUsedAt;
  });

  const chosen = prioritizedPool[0];
  const chosenTier = options?.desiredTier ? ` • ${inferKeyRoleTier(chosen.model, chosen.roleTier).toUpperCase()}` : '';
  return {
    key: chosen,
    reason: useLoadBalancer
      ? `স্মার্ট লোড ব্যালেন্সিং (${chosen.provider.toUpperCase()}${chosenTier} • ${prioritizedPool.length} সচল কী পুল)`
      : undefined,
    healthyCount: prioritizedPool.length,
  };
}

// Hard 1-minute RPM + TPM pacing guard: protects every key in small OR 20-40 key pools from crossing its 1-min limit
async function paceAndTrackKeyRound(
  trackedKey: KeyConfig | undefined,
  round: number,
  sendEvent?: (data: any) => void,
  estimatedRoundTokens: number = 1200,
  poolHealthyCount: number = 1,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (!trackedKey) return;
  const stats = getOrCreateStats(trackedKey.id);
  const now = Date.now();
  const caps = getKeyEffectiveCaps(trackedKey);
  const tpmUsed = stats.tokenTimestamps.reduce((s, e) => s + e.tokens, 0);

  const hitsRpmHardGuard = stats.timestamps.length >= caps.safeRpmCap && stats.timestamps.length > 0;
  const hitsTpmHardGuard = (tpmUsed + estimatedRoundTokens) > caps.safeTpmCap && stats.tokenTimestamps.length > 0;

  if (hitsRpmHardGuard || hitsTpmHardGuard) {
    const oldestTs = hitsRpmHardGuard
      ? stats.timestamps[0]
      : (stats.tokenTimestamps[0]?.ts || now);
    const waitMs = Math.min(8000, Math.max(1200, 60_500 - (now - oldestTs)));
    if (sendEvent) {
      sendEvent({
        type: 'action',
        action: hitsTpmHardGuard
          ? `⏱️ ${trackedKey.name}-এর ১-মিনিটের TPM লিমিট (${tpmUsed}/${caps.safeTpmCap}) বাঁচাতে ${(waitMs / 1000).toFixed(1)}s সেফটি পেসিং...`
          : `⏱️ ${trackedKey.name}-এর ১-মিনিটের RPM লিমিট (${stats.timestamps.length}/${caps.safeRpmCap}) বাঁচাতে ${(waitMs / 1000).toFixed(1)}s সেফটি পেসিং...`
      });
    }
    await abortableSleep(waitMs, signal);
  } else if (round > 0 && trackedKey.id !== 'studio_primary_key' && poolHealthyCount < 3) {
    await abortableSleep(550, signal);
  }

  throwIfAborted(signal);
  const freshStats = getOrCreateStats(trackedKey.id);
  const tsNow = Date.now();
  freshStats.timestamps.push(tsNow);
  freshStats.tokenTimestamps.push({ ts: tsNow, tokens: estimatedRoundTokens });
  freshStats.dailyRequests++;
  freshStats.lastUsedAt = tsNow;
}

// Record successful request on key and remember it persistently
export function recordKeySuccess(keyId: string) {
  persistStickyKeyId(keyId);
  const stats = getOrCreateStats(keyId);
  const now = Date.now();
  stats.timestamps.push(now);
  stats.totalRequests++;
  stats.lastUsedAt = now;
  stats.cooldownUntil = 0;
  stats.lastError = null;
}

// Record error / cooldown on key
export function recordKeyCooldown(keyId: string, durationSec: number = 60, errorMsg?: string) {
  const stats = getOrCreateStats(keyId);
  stats.cooldownUntil = Date.now() + durationSec * 1000;
  stats.lastError = errorMsg || 'Rate limit or failure';
}

// Test an API key connectivity
export async function testApiKey(
  provider: string,
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<{ success: boolean; latencyMs: number; message?: string }> {
  const start = Date.now();
  try {
    if (provider === 'gemini') {
      const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
      const targetModel = normalizeModelName('gemini', model);
      try {
        const client = new GoogleGenAI({
          apiKey: cleanKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build'
            }
          }
        });
        const res = await client.models.generateContent({
          model: targetModel,
          contents: 'Hi. Reply with only one word: OK'
        });
        const latencyMs = Date.now() - start;
        const text = res.text || '';
        return { success: true, latencyMs, message: `Connected (${targetModel}) in ${latencyMs}ms: ${text.trim().slice(0, 20)}` };
      } catch (geminiErr: any) {
        const rawMsg = geminiErr.message || '';
        // If AQ. key is a Vertex AI Express Mode key, also try vertexai: true before failing
        if (cleanKey.startsWith('AQ.') && /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(rawMsg)) {
          try {
            const vertexClient = new GoogleGenAI({
              vertexai: true,
              apiKey: cleanKey,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
            });
            const vRes = await vertexClient.models.generateContent({
              model: targetModel,
              contents: 'Hi. Reply with only one word: OK'
            });
            const latencyMs = Date.now() - start;
            return { success: true, latencyMs, message: `Connected via Vertex Express (${targetModel}) in ${latencyMs}ms: ${(vRes.text || '').trim().slice(0, 20)}` };
          } catch {
            // Fall through to helpful AQ. error diagnosis below
          }
        }
        const latencyMs = Date.now() - start;
        if (/ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(rawMsg)) {
          return {
            success: false,
            latencyMs,
            message: `Google সার্ভার এই AQ. কী-টি গ্রহণ করেনি (401 ACCESS_TOKEN_TYPE_UNSUPPORTED)। কারণ: (১) Google Cloud Console > Credentials-এ "API restrictions"-এ ভুল করে "Gemini API" দেওয়া থাকলে পরিবর্তন করে "Generative Language API" করুন অথবা "Don't restrict key" রাখুন; অথবা (২) কী-টি বাতিল/সীমাবদ্ধ হলে aistudio.google.com থেকে নতুন প্রজেক্টে নতুন কী তৈরি করুন।`
          };
        }
        return { success: false, latencyMs, message: rawMsg };
      }
    }

    if (provider === 'openrouter') {
      const targetModel = normalizeModelName(provider, model);
      const { model: connectedModel } = await fetchOpenRouterWithFallback({
        apiKey,
        preferredModel: targetModel,
        messages: [{ role: 'user', content: 'Reply with one word: OK' }],
        max_tokens: 10,
        timeoutMs: 20000,
      });
      const latencyMs = Date.now() - start;
      return { success: true, latencyMs, message: `Connected to OPENROUTER (${connectedModel}) in ${latencyMs}ms.` };
    }

    if (provider === 'huggingface') {
      const targetModel = normalizeModelName(provider, model);
      const { model: connectedModel } = await fetchHuggingFaceWithFallback({
        apiKey,
        preferredModel: targetModel,
        messages: [{ role: 'user', content: 'Reply with one word: OK' }],
        max_tokens: 10,
        timeoutMs: 25000,
      });
      const latencyMs = Date.now() - start;
      return { success: true, latencyMs, message: `Connected to HUGGINGFACE ROUTER (${connectedModel}) in ${latencyMs}ms.` };
    }

    if (['deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(provider)) {
      const targetModel = normalizeModelName(provider, model);
      const endpoint = getOpenAICompatibleEndpoint(provider, baseUrl);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: 'user', content: 'Reply with one word: OK' }],
          max_tokens: targetModel === 'deepseek-reasoner' ? 64 : 10,
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const rawMsg = errorData.error?.message || `${provider} returned status ${res.status}`;
        if (provider === 'deepseek' && res.status === 402) {
          return {
            success: false,
            latencyMs,
            message: `DeepSeek API অ্যাকাউন্টে পর্যাপ্ত ব্যালেন্স নেই (402 Insufficient Balance): ${rawMsg} — ফ্রিতে DeepSeek চালাতে OpenRouter (:free) অথবা Hugging Face Router (hf_...) ব্যবহার করুন।`,
          };
        }
        return { success: false, latencyMs, message: rawMsg };
      }
      return { success: true, latencyMs, message: `Connected to ${provider.toUpperCase()} (${targetModel}) in ${latencyMs}ms.` };
    }

    return { success: false, latencyMs: 0, message: `Unknown provider: ${provider}` };
  } catch (err: any) {
    return { success: false, latencyMs: Date.now() - start, message: err.message || 'Connection failed' };
  }
}

// Re-export website, PWA deployer, and chat history sanitizer
export { autoDeployWebsiteFromText, prepareGeminiHistoryAndLastMessage } from "./websiteDeployer.ts";

export type ActionStepKind = 'thought' | 'command' | 'read' | 'edit' | 'build' | 'qc' | 'restart' | 'respond' | 'agent';
export type AgentRole = 'architect' | 'coder' | 'debugger';

export function emitActionStep(
  sendEvent: (data: any) => void,
  kind: ActionStepKind,
  label: string,
  detail?: string,
  options?: {
    id?: string;
    agentRole?: AgentRole;
    status?: 'running' | 'done' | 'error';
    toolName?: string;
    filePath?: string;
    durationSec?: number;
    isError?: boolean;
  }
): string {
  const stepId = options?.id || `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  sendEvent({
    type: "action_step",
    step: {
      id: stepId,
      kind,
      label,
      agentRole: options?.agentRole,
      detail,
      status: options?.status || 'done',
      toolName: options?.toolName,
      filePath: options?.filePath,
      durationSec: options?.durationSec,
      isError: options?.isError,
      timestamp: Date.now()
    }
  });
  return stepId;
}

function inferToolAgentRole(toolName: string, kind: ActionStepKind): AgentRole {
  if (
    [
      'compile_applet', 'compileProject', 'lint_applet', 'lintProject',
      'debug_error_analysis', 'targeted_error_context', 'api_contract_checker',
      'verify_live_preview', 'visual_qa_review', 'code_execution_sandbox',
      'run_tests', 'detect_secrets', 'claw_doctor',
    ].includes(toolName) || kind === 'qc'
  ) {
    return 'debugger';
  }
  if (
    [
      'write_to_file', 'fileWrite', 'replace_file_content', 'fileEdit',
      'multi_replace_file_content', 'delete_file', 'fileDelete', 'delete_dir',
      'move', 'moveFile', 'install_applet_package', 'installPackage',
      'install_applet_dependencies', 'generate_image', 'generateImage', 'fetch_stock_images',
      'set_up_firebase', 'deploy_firebase', 'github_clone', 'workspace_run',
      'restart_dev_server', 'restartServer', 'focus_mode', 'figma_import',
      'cloudsql_update_schema',
    ].includes(toolName) || kind === 'edit' || kind === 'restart'
  ) {
    return 'coder';
  }
  return 'architect';
}

function mapToolToActionStep(toolName: string, args: any): { kind: ActionStepKind; label: string; detail: string; filePath?: string } {
  let kind: ActionStepKind = 'command';
  let label = 'Ran command';

  if (toolName === 'fileRead' || toolName === 'view_file') {
    kind = 'read';
    label = 'Read file';
  } else if (toolName === 'read_skill') {
    kind = 'thought';
    label = 'Loaded coding skill';
  } else if (toolName === 'analyze_project') {
    kind = 'read';
    label = 'Analyzed workspace project';
  } else if (toolName === 'grep_search') {
    kind = 'read';
    label = 'Searched code (grep)';
  } else if (toolName === 'find_by_name') {
    kind = 'read';
    label = 'Found workspace files';
  } else if (toolName === 'list_dir' || toolName === 'listDir') {
    kind = 'read';
    label = 'Listed directory';
  } else if (toolName === 'fileWrite' || toolName === 'write_to_file') {
    kind = 'edit';
    label = 'Wrote file';
  } else if (toolName === 'fileEdit' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
    kind = 'edit';
    label = 'Edited file';
  } else if (toolName === 'delete_file' || toolName === 'fileDelete' || toolName === 'delete_dir' || toolName === 'move' || toolName === 'moveFile') {
    kind = 'edit';
    label = 'Updated workspace files';
  } else if (toolName === 'install_applet_package' || toolName === 'installPackage' || toolName === 'install_applet_dependencies') {
    kind = 'build';
    label = 'Installed dependencies';
  } else if (toolName === 'compileProject' || toolName === 'compile_applet') {
    kind = 'build';
    label = 'Built project';
  } else if (toolName === 'lintProject' || toolName === 'lint_applet' || toolName === 'detect_secrets') {
    kind = 'qc';
    label = toolName === 'detect_secrets' ? 'Scanned for secrets' : 'Ran quality control';
  } else if (toolName === 'restartServer' || toolName === 'restart_dev_server') {
    kind = 'restart';
    label = 'Restarted dev server';
  } else if (toolName === 'manage_task') {
    kind = 'command';
    label = `Managed background task (${args?.Action || 'status'})`;
  } else if (toolName === 'git_status' || toolName === 'git_diff') {
    kind = 'read';
    label = toolName === 'git_status' ? 'Checked git status' : 'Inspected git diff';
  } else if (toolName === 'search_web' || toolName === 'webSearch' || toolName === 'webFetch') {
    kind = 'command';
    label = toolName === 'webFetch' ? 'Fetched webpage' : 'Searched web';
  } else if (toolName === 'generate_image' || toolName === 'generateImage') {
    kind = 'edit';
    label = 'Generated image';
  } else if (toolName === 'fetch_stock_images') {
    kind = 'edit';
    const count = Array.isArray(args?.items) ? args.items.length : 1;
    label = `Fetched ${count} stock image(s) (0 tokens)`;
  } else if (toolName === 'code_execution_sandbox') {
    kind = 'command';
    label = `Executed ${args?.Language || 'code'} in Sandbox`;
  } else if (toolName === 'read_multiple_files') {
    kind = 'read';
    label = `Read ${(args?.FilePaths || []).length} files (Multi-File Context)`;
  } else if (toolName === 'compute_file_diff') {
    kind = 'read';
    label = 'Computed file diff';
  } else if (toolName === 'debug_error_analysis') {
    kind = 'qc';
    label = 'Analyzed error & diagnostics';
  } else if (toolName === 'claw_doctor') {
    kind = 'qc';
    label = 'Ran Claw Doctor health check';
  } else if (toolName === 'claw_status') {
    kind = 'thought';
    label = 'Checked Claw harness status';
  } else if (toolName === 'claw_acp') {
    kind = 'thought';
    label = 'Checked Agent Client Protocol';
  } else if (toolName === 'claw_prompt') {
    kind = 'command';
    label = `Dispatched Claw prompt (${args?.role || 'agent'})`;
  } else if (toolName === 'omo_coordinate') {
    kind = 'agent';
    label = 'Orchestrated OmO Multi-Agent coordination';
  } else if (toolName === 'omx_protocol') {
    kind = 'agent';
    label = 'Constructed OmX Execution Protocol';
  } else if (toolName === 'clawhip_router') {
    kind = 'command';
    label = `Routed ClawHip event (${args?.action || 'stream'})`;
  } else if (toolName === 'lazycodex_runner') {
    kind = 'command';
    label = 'Executed LazyCodex autonomous engine';
  } else if (toolName === 'ask_question' || toolName === 'plan') {
    kind = 'thought';
    label = toolName === 'plan' ? 'Created implementation plan' : 'Asked clarifying questions';
  } else if (toolName === 'verify_live_preview') {
    kind = 'qc';
    label = 'Verified live preview';
  } else if (toolName === 'visual_qa_review') {
    kind = 'qc';
    label = 'Ran Visual QA Screenshot & Layout Audit';
  } else if (toolName === 'workspace_init') {
    kind = 'build';
    label = `Initialized sandbox (${args?.template || 'react-vite'})`;
  } else if (toolName === 'workspace_run') {
    const act = String(args?.action || 'start').toLowerCase();
    kind = act === 'build' ? 'build' : 'restart';
    label = act === 'build' ? 'Built static production preview' : `Sandbox sub-server (${act})`;
  } else if (toolName === 'github_clone') {
    kind = 'build';
    label = `Cloned GitHub repo (${args?.repo || 'repo'})`;
  } else if (toolName === 'ast_context_ranker') {
    kind = 'read';
    label = 'Analyzed AST symbol & call graph';
  } else if (toolName === 'persistence_status') {
    kind = 'read';
    label = 'Checked remote DB persistence status';
  } else if (toolName === 'set_up_firebase') {
    kind = 'build';
    label = 'Provisioned Firebase & Firestore';
  } else if (toolName === 'deploy_firebase') {
    kind = 'build';
    label = 'Deployed firestore.rules';
  } else if (toolName === 'set_up_oauth' || toolName === 'remove_oauth') {
    kind = 'command';
    label = toolName === 'remove_oauth' ? 'Removed OAuth scopes' : 'Configured OAuth client & scopes';
  } else if (toolName === 'cloudsql_execute_sql') {
    kind = 'command';
    label = 'Executed SQL query on Cloud SQL';
  } else if (toolName === 'cloudsql_update_schema') {
    kind = 'build';
    label = 'Updated database schema (Drizzle ORM)';
  } else if (toolName === 'figma_import') {
    kind = 'edit';
    label = 'Imported Figma design spec';
  } else if (toolName === 'focus_mode') {
    kind = 'edit';
    label = `Focus Mode edit (${args?.cssSelector || 'target'})`;
  } else if (toolName === 'schedule') {
    kind = 'command';
    label = `Scheduled background timer (${args?.DurationSeconds || 5}s)`;
  }

  const filePath =
    args?.TargetFile ||
    args?.AbsolutePath ||
    args?.filePath ||
    args?.DestinationPath ||
    undefined;

  const detail =
    filePath ||
    args?.SkillName ||
    (Array.isArray(args?.FilePaths) ? args.FilePaths.join(', ') : '') ||
    args?.Language ||
    args?.Pattern ||
    args?.CommandLine ||
    args?.command ||
    args?.query ||
    args?.task ||
    args?.goal ||
    args?.prompt ||
    args?.Prompt ||
    args?.message ||
    (toolName === 'fetch_stock_images' && Array.isArray(args?.items)
      ? args.items.slice(0, 3).map((it: any) => it?.query).filter(Boolean).join(', ')
      : '') ||
    (Array.isArray(args?.PackageNames) ? args.PackageNames.join(', ') : args?.packageName) ||
    (toolName === 'plan' && Array.isArray(args?.steps)
      ? `${args.steps.length} steps: ${args.steps.slice(0, 3).map((s: any) => (typeof s === 'string' ? s : s?.title || '')).filter(Boolean).join(' → ')}`
      : '') ||
    args?.TaskId ||
    '';

  return { kind, label, detail, filePath };
}

async function executeToolWithLiveEvents(
  callName: string,
  callArgs: any,
  sendEvent: (data: any) => void,
  execCtx: ToolExecutionContext
): Promise<any> {
  const mapped = mapToolToActionStep(callName, callArgs);
  const agentRole = inferToolAgentRole(callName, mapped.kind);
  const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const startTime = Date.now();

  // Emit live "running" step immediately before execution
  emitActionStep(sendEvent, mapped.kind, mapped.label, mapped.detail, {
    id: stepId,
    agentRole,
    status: 'running',
    toolName: callName,
    filePath: mapped.filePath,
  });

  const toolResult = await executeServerTool(
    callName,
    callArgs,
    (action) => sendEvent({ type: "action", action }),
    execCtx
  );

  const durationSec = Math.max(0.1, Number(((Date.now() - startTime) / 1000).toFixed(1)));
  const hasError = Boolean(toolResult?.error || toolResult?.success === false);

  // Update the same step to "done" or "error"
  emitActionStep(
    sendEvent,
    mapped.kind,
    hasError ? `${mapped.label} (failed)` : mapped.label,
    hasError ? String(toolResult?.error || toolResult?.message || mapped.detail).slice(0, 140) : mapped.detail,
    {
      id: stepId,
      agentRole,
      status: hasError ? 'error' : 'done',
      toolName: callName,
      filePath: toolResult?.cleanPath || mapped.filePath,
      durationSec,
      isError: hasError,
    }
  );

  // Emit structured real file modification events
  if (!hasError) {
    if (['write_to_file', 'fileWrite', 'replace_file_content', 'fileEdit', 'multi_replace_file_content'].includes(callName)) {
      const fp = (toolResult?.cleanPath || (toolResult?.path || mapped.filePath || '').replace(/^\/+/, '')).trim();
      if (fp) {
        sendEvent({
          type: 'file_modified',
          filePath: fp,
          action: callName.includes('write') || callName.includes('Write') ? 'created' : 'edited',
        });
      }
    } else if (callName === 'delete_file' || callName === 'fileDelete') {
      const fp = (mapped.filePath || '').replace(/^\/+/, '').trim();
      if (fp) sendEvent({ type: 'file_modified', filePath: fp, action: 'deleted' });
    } else if (callName === 'move' || callName === 'moveFile') {
      const fp = (callArgs?.DestinationPath || callArgs?.destinationPath || '').replace(/^\/+/, '').trim();
      if (fp) sendEvent({ type: 'file_modified', filePath: fp, action: 'moved' });
    } else if (Array.isArray(toolResult?.modifiedFiles)) {
      for (const fp of toolResult.modifiedFiles) {
        sendEvent({ type: 'file_modified', filePath: fp, action: 'created' });
      }
    } else if (callName === 'deploy_firebase') {
      sendEvent({ type: 'file_modified', filePath: toolResult?.rulesPath || 'firestore.rules', action: 'edited' });
    } else if (callName === 'cloudsql_update_schema' && toolResult?.schemaPath) {
      const rel = path.relative(process.cwd(), toolResult.schemaPath);
      sendEvent({ type: 'file_modified', filePath: rel || 'src/db/schema.ts', action: 'edited' });
    }

    // If an HTML website/PWA file or sandbox sub-server became ready, trigger Live Preview immediately!
    if (toolResult?.previewUrl) {
      sendEvent({
        type: "action",
        action: `✓ Live Preview updated (${toolResult.previewUrl})`,
      });
      sendEvent({
        type: "preview_ready",
        url: toolResult.previewUrl,
        html: toolResult.deployedHtml,
        sessionId: execCtx.sessionId,
        timestamp: Date.now(),
      });
    } else if (callName === 'workspace_run' && toolResult?.success && toolResult?.proxyUrl && toolResult?.status !== 'stopped') {
      sendEvent({
        type: "action",
        action: `✓ Sandbox server live at ${toolResult.proxyUrl}`,
      });
      sendEvent({
        type: "preview_ready",
        url: toolResult.proxyUrl,
        sessionId: execCtx.sessionId,
        timestamp: Date.now(),
      });
    } else if (callName === 'github_clone' && toolResult?.success && toolResult?.proxyUrl) {
      const srvOk = !toolResult?.serverStatus || toolResult?.serverStatus?.success !== false;
      sendEvent({
        type: "action",
        action: srvOk
          ? `✓ Cloned ${toolResult.repo} & live preview ready at ${toolResult.proxyUrl}`
          : `✓ Cloned ${toolResult.repo} into ${toolResult.workspacePath}`,
      });
      if (srvOk) {
        sendEvent({
          type: "preview_ready",
          url: toolResult.proxyUrl,
          sessionId: execCtx.sessionId,
          timestamp: Date.now(),
        });
      }
    }
  }

  if ((callName === "generateImage" || callName === "generate_image") && toolResult?.imageUrl) {
    sendEvent({ type: "image", imageUrl: toolResult.imageUrl });
  }
  if (callName === "visual_qa_review" && toolResult?.screenshotUrl) {
    sendEvent({ type: "image", imageUrl: toolResult.screenshotUrl });
  }

  return toolResult;
}

const KNOWN_TOOL_NAMES = new Set(
  serverTools.map((t) => t.name).filter((n): n is string => Boolean(n))
);

const OPENAI_CORE_TOOL_NAMES = new Set([
  'read_skill',
  'analyze_project',
  'codebase_graph',
  'ast_context_ranker',
  'api_contract_checker',
  'targeted_error_context',
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file',
  'delete_dir',
  'move',
  'install_applet_package',
  'install_applet_dependencies',
  'compile_applet',
  'lint_applet',
  'run_tests',
  'run_command',
  'manage_task',
  'git_status',
  'git_diff',
  'git_checkpoint',
  'git_rollback',
  'detect_secrets',
  'read_multiple_files',
  'compute_file_diff',
  'omo_coordinate',
  'omx_protocol',
  'claw_doctor',
  'claw_status',
  'claw_acp',
  'claw_prompt',
  'clawhip_router',
  'lazycodex_runner',
  'debug_error_analysis',
  'code_execution_sandbox',
  'workspace_init',
  'workspace_run',
  'github_clone',
  'visual_qa_review',
  'persistence_status',
  'set_up_firebase',
  'deploy_firebase',
  'set_up_oauth',
  'remove_oauth',
  'cloudsql_execute_sql',
  'cloudsql_update_schema',
  'figma_import',
  'focus_mode',
  'plan',
  'search_web',
  'webFetch',
  'generate_image',
  'fetch_stock_images',
  'restart_dev_server',
  'ask_question',
  'verify_live_preview',
  'schedule',
]);

// Intent-based dynamic tool filtering: cuts 50-65% tool schema tokens on free APIs
function selectRelevantTools(
  declarations: FunctionDeclaration[],
  promptText: string,
  mode: string,
  compactMode: boolean,
  isGreenfield: boolean = false,
  enableMultiAgentOmo: boolean = false
): FunctionDeclaration[] {
  const baseTools = new Set(
    isGreenfield
      ? [
          'write_to_file',
          'replace_file_content',
          'multi_replace_file_content',
          'view_file',
          'verify_live_preview',
          'compile_applet',
          'lint_applet',
          'read_skill',
          'plan',
        ]
      : [
          'view_file',
          'write_to_file',
          'replace_file_content',
          'multi_replace_file_content',
          'list_dir',
          'grep_search',
          'codebase_graph',
          'ast_context_ranker',
          'verify_live_preview',
          'compile_applet',
          'lint_applet',
          'git_checkpoint',
          'read_multiple_files',
          'compute_file_diff',
          'read_skill',
          'plan',
        ]
  );

  const lower = (promptText || '').toLowerCase();
  if (!isGreenfield && (/(install|package|npm|react|express|server|backend|api|build|typescript|vite|clone|repo|github|gh\s+repo|sandbox|workspace|fullstack|command|cmd|shell|bash|terminal|script|python|node|exec|status|check|verify|all|ফুল-স্ট্যাক|ক্লোন|রিপো|গিটহাব|প্রিভিউ|ইমপোর্ট|কমান্ড|টার্মিনাল|প্যাকেজ|স্কিল|সব)/i.test(lower) || /github\.com\//i.test(lower))) {
    baseTools.add('analyze_project');
    baseTools.add('find_by_name');
    baseTools.add('install_applet_package');
    baseTools.add('install_applet_dependencies');
    baseTools.add('run_command');
    baseTools.add('manage_task');
    baseTools.add('restart_dev_server');
    baseTools.add('run_tests');
    baseTools.add('workspace_init');
    baseTools.add('workspace_run');
    baseTools.add('github_clone');
  } else if (isGreenfield) {
    baseTools.add('workspace_init');
    baseTools.add('workspace_run');
    baseTools.add('install_applet_package');
    baseTools.add('fetch_stock_images');
  }
  if (/(delete|remove|rename|move|clean|মুছ|সরাও)/i.test(lower)) {
    baseTools.add('delete_file');
    baseTools.add('delete_dir');
    baseTools.add('move');
  }
  if (/(test|spec|vitest|bug|error|fix|debug|crash|secret|security|audit|check|verify|api|route|endpoint|all|ফ্লো|এরর|ঠিক|সব)/i.test(lower)) {
    baseTools.add('debug_error_analysis');
    baseTools.add('targeted_error_context');
    baseTools.add('api_contract_checker');
    baseTools.add('code_execution_sandbox');
    baseTools.add('run_tests');
    baseTools.add('git_rollback');
    baseTools.add('detect_secrets');
  }
  if (enableMultiAgentOmo) {
    baseTools.add('omo_coordinate');
  }
  if (/(agent|multi|omo|omx|claw|lazycodex|autonomous|orchestrat|মাল্টি|এজেন্ট)/i.test(lower)) {
    baseTools.add('omo_coordinate');
    baseTools.add('omx_protocol');
    baseTools.add('claw_doctor');
    baseTools.add('claw_status');
    baseTools.add('claw_acp');
    baseTools.add('claw_prompt');
    baseTools.add('clawhip_router');
    baseTools.add('lazycodex_runner');
  }
  if (/(visual|screenshot|qa|ui|layout|design|css|figma|mockup|selector|#|\.|ডিজাইন|ভিজ্যুয়াল)/i.test(lower)) {
    baseTools.add('figma_import');
    baseTools.add('focus_mode');
    baseTools.add('visual_qa_review');
  }
  if (/(website|landing|store|shop|ecommerce|e-commerce|portfolio|dashboard|saas|game|pwa|portal|platform|app|ওয়েবসাইট|ওয়েবসাইট|ড্যাশবোর্ড|ই-কমার্স|স্টোর|পোর্টফোলিও|গেম|অ্যাপ|বানাও|তৈরি)/i.test(lower)) {
    baseTools.add('fetch_stock_images');
    baseTools.add('generate_image');
    baseTools.add('visual_qa_review');
    baseTools.add('workspace_init');
    baseTools.add('workspace_run');
  }
  if (/(search|docs|latest|find online|web|url|https?:\/\/|সার্চ|খুঁজ)/i.test(lower) || mode === 'search') {
    baseTools.add('search_web');
    baseTools.add('webFetch');
  }
  if (/(image|photo|stock|seed|catalog|product|avatar|gallery|banner|logo|icon|illustration|ছবি|লোগো)/i.test(lower) || mode === 'image') {
    baseTools.add('fetch_stock_images');
    baseTools.add('generate_image');
  }
  const hasExplicitFirebaseIntent = /(firebase|firestore|firebaseconfig|ফায়ারবেস|ফায়ারবেস)/i.test(lower);
  if (hasExplicitFirebaseIntent) {
    baseTools.add('set_up_firebase');
    baseTools.add('deploy_firebase');
  }
  if (/(database|sql|postgres|turso|supabase|sqlite|drizzle|ডাটাবেজ)/i.test(lower)) {
    baseTools.add('cloudsql_execute_sql');
    baseTools.add('cloudsql_update_schema');
    baseTools.add('persistence_status');
  }
  if (/(oauth|gmail|drive|calendar|sheets|workspace)/i.test(lower)) {
    baseTools.add('set_up_oauth');
    baseTools.add('remove_oauth');
  }
  if (/(schedule|timer|cron|remind|টাইমার)/i.test(lower)) {
    baseTools.add('schedule');
  }
  if (/(plan|clarify|ask|প্ল্যান)/i.test(lower)) {
    baseTools.add('ask_question');
    baseTools.add('plan');
  }
  if (/(git|rollback|checkpoint|undo|রোলব্যাক)/i.test(lower)) {
    baseTools.add('git_status');
    baseTools.add('git_diff');
    baseTools.add('git_rollback');
  }
  if (!compactMode) {
    // Allow full toolset on primary Gemini engine, still excluding redundant legacy aliases and hiding Firebase tools unless explicitly requested
    const blockedTools = new Set([
      'fileRead', 'fileWrite', 'fileEdit', 'bash', 'listDir', 'compileProject',
      'lintProject', 'restartServer', 'webSearch', 'generateImage', 'installPackage',
      'moveFile', 'fileDelete',
    ]);
    if (isGreenfield) {
      blockedTools.add('analyze_project');
      blockedTools.add('codebase_graph');
      blockedTools.add('ast_context_ranker');
    }
    if (!hasExplicitFirebaseIntent) {
      blockedTools.add('set_up_firebase');
      blockedTools.add('deploy_firebase');
    }
    return declarations.filter((fn) => fn.name && !blockedTools.has(fn.name));
  }
  return declarations.filter((fn) => fn.name && baseTools.has(fn.name) && OPENAI_CORE_TOOL_NAMES.has(fn.name));
}

interface PendingQuestionEntry {
  resolve: (val: { answers: Record<string, string[]>; skipped?: boolean; notes?: string }) => void;
  timer: NodeJS.Timeout;
}

const pendingQuestionResolvers = new Map<string, PendingQuestionEntry>();

export function resolvePendingQuestion(
  questionId: string,
  payload: { answers?: Record<string, string[]>; skipped?: boolean; notes?: string }
): boolean {
  const entry = pendingQuestionResolvers.get(questionId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingQuestionResolvers.delete(questionId);
  entry.resolve({
    answers: payload?.answers || {},
    skipped: Boolean(payload?.skipped),
    notes: payload?.notes || '',
  });
  return true;
}

interface PendingFirebaseEntry {
  resolve: (val: any) => void;
  timer: NodeJS.Timeout;
}

const pendingFirebaseResolvers = new Map<string, PendingFirebaseEntry>();

export function resolvePendingFirebaseSetup(requestId: string, payload: any): boolean {
  const entry = pendingFirebaseResolvers.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingFirebaseResolvers.delete(requestId);
  entry.resolve({
    action: payload?.action || 'scaffold',
    configSnippet: payload?.configSnippet,
    projectId: payload?.projectId,
    apiKey: payload?.apiKey,
    authDomain: payload?.authDomain,
    storageBucket: payload?.storageBucket,
    messagingSenderId: payload?.messagingSenderId,
    appId: payload?.appId,
    firestoreDatabaseId: payload?.firestoreDatabaseId,
    serviceAccountJson: payload?.serviceAccountJson,
    firebaseToken: payload?.firebaseToken,
    saveToGlobalProfile: payload?.saveToGlobalProfile !== false,
  });
  return true;
}

function extractAndStripTextToolCalls(rawText: string): {
  calls: Array<{ name: string; args: any }>;
  cleanedText: string;
} {
  if (!rawText) return { calls: [], cleanedText: '' };

  const calls: Array<{ name: string; args: any }> = [];
  let cleaned = rawText;

  const pushParsedCall = (item: any) => {
    if (!item || typeof item !== 'object') return;
    const fnName = item.name || item.function?.name || item.tool;
    if (!fnName || !KNOWN_TOOL_NAMES.has(fnName)) return;
    let args = item.arguments ?? item.args ?? item.parameters ?? item.function?.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    calls.push({ name: fnName, args: args && typeof args === 'object' ? args : {} });
  };

  const tryParseToolJsonBlock = (candidate: string): boolean => {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const before = calls.length;
        parsed.forEach(pushParsedCall);
        return calls.length > before;
      }
      if (Array.isArray(parsed.tool_calls)) {
        const before = calls.length;
        parsed.tool_calls.forEach(pushParsedCall);
        return calls.length > before;
      }
      if (parsed.name && KNOWN_TOOL_NAMES.has(parsed.name)) {
        pushParsedCall(parsed);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  };

  // 1. <tool_call>...</tool_call> or <function_call>...</function_call>
  cleaned = cleaned.replace(/<(?:tool_call|function_call)>([\s\S]*?)<\/(?:tool_call|function_call)>/gi, (full, inner) => {
    return tryParseToolJsonBlock(inner) ? '' : full;
  });

  // 2. Fenced ```json ... ``` or ``json ... `` blocks containing tool_calls or single known tool object
  cleaned = cleaned.replace(/`{2,3}(?:json)?\s*([\s\S]*?)`{2,3}/gi, (full, inner) => {
    if (!inner.includes('"tool_calls"') && !inner.includes('"arguments"') && !inner.includes('"name"')) {
      return full;
    }
    return tryParseToolJsonBlock(inner) ? '' : full;
  });

  // 3. Unfenced (or unclosed fenced) {"tool_calls": [...]} JSON object
  const toolCallsMatch = cleaned.match(/`{0,3}(?:json)?\s*\{\s*"tool_calls"\s*:/i);
  if (toolCallsMatch && typeof toolCallsMatch.index === 'number') {
    const startIdx = toolCallsMatch.index;
    const jsonStartIdx = cleaned.indexOf('{', startIdx);
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let endIdx = -1;
    for (let i = jsonStartIdx; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (!inStr) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i + 1;
            break;
          }
        }
      }
    }
    if (endIdx !== -1) {
      const slice = cleaned.slice(jsonStartIdx, endIdx);
      if (tryParseToolJsonBlock(slice)) {
        let after = cleaned.slice(endIdx).replace(/^\s*`{1,3}/, '');
        cleaned = (cleaned.slice(0, startIdx) + after).trim();
      }
    } else {
      // Truncated tool_calls JSON at end of stream: try salvaging complete { "name": ... } objects and strip raw JSON noise
      const tail = cleaned.slice(jsonStartIdx);
      const itemMatches = tail.match(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g) || [];
      for (const itemStr of itemMatches) {
        tryParseToolJsonBlock(itemStr);
      }
      cleaned = cleaned.slice(0, startIdx).trim();
    }
  }

  // Clean up <think>...</think> blocks emitted by R1/reasoning models if real output or tool calls exist outside
  const withoutThink = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (withoutThink || calls.length > 0) {
    cleaned = withoutThink;
  }

  // Clean up stray backtick artifacts left behind when models wrap tool JSON weirdly
  cleaned = cleaned
    .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n')
    .replace(/`{2,3}\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { calls, cleanedText: cleaned };
}

function getSafeStreamableText(rawText: string): string {
  // Prevent partial <tool_call>, <think>, or ```json { "tool_calls" ... from flashing in UI while streaming
  let safe = rawText;
  const openThinkIdx = safe.search(/<think>/i);
  if (openThinkIdx !== -1) {
    const closeThinkIdx = safe.search(/<\/think>/i);
    if (closeThinkIdx === -1) {
      safe = safe.slice(0, openThinkIdx);
    } else {
      safe = safe.replace(/<think>[\s\S]*?<\/think>/gi, '');
    }
  }
  const openTagIdx = safe.search(/<(?:tool_call|function_call)/i);
  if (openTagIdx !== -1 && !/<\/(?:tool_call|function_call)>/i.test(safe.slice(openTagIdx))) {
    safe = safe.slice(0, openTagIdx);
  }
  const jsonToolIdx = safe.search(/`{0,3}(?:json)?\s*\{\s*"tool_calls"\s*:/i);
  if (jsonToolIdx !== -1) {
    safe = safe.slice(0, jsonToolIdx);
  }
  const { cleanedText } = extractAndStripTextToolCalls(safe);
  return cleanedText
    .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n')
    .replace(/`{1,3}\s*$/g, '')
    .trimEnd();
}

function isActionOrBuildPrompt(promptText: string): boolean {
  const lower = (promptText || '').toLowerCase();
  return /(বানাও|তৈরি|ফিচার|যুক্ত|এ্যাড|অ্যাড|এডিট|ঠিক কর|ফিক্স|আপডেট|কোড|অ্যাপ|ওয়েবসাইট|ড্যাশবোর্ড|গেম|দেখো|চেক কর|সার্চ|build|create|add|feature|fix|update|implement|modify|edit|design|refactor|upgrade|debug|write|read|inspect|search|run|compile|deploy|clone|import)/i.test(lower);
}

function isCasualOrConversationalOnly(promptText: string): boolean {
  const trimmed = (promptText || '').trim();
  if (!trimmed) return false;
  // Never treat as casual if it contains URLs, file paths, code fences, or build/inspect keywords
  if (/https?:\/\/|```|[a-z0-9_-]+\.(tsx?|jsx?|html|css|json|py|md)\b|[/\\]/i.test(trimmed)) {
    return false;
  }
  if (isActionOrBuildPrompt(trimmed)) {
    return false;
  }
  const clean = trimmed.toLowerCase().replace(/[!?.।,~`'"]+/g, '').trim();
  const greetingPattern = /^(hi+|hello+|hey+|helo+|yo+|hola|salam|assalamu\s*alaikum|nomoshkar|namaste|good\s*(morning|afternoon|evening|night)|thanks?|thank\s*you|thx|ok|okay|bye|goodbye|হাই|হ্যালো|হেলো|সালাম|আসসালামু\s*আলাইকুম|নমস্কার|কেমন\s*আছো|কেমন\s*আছেন|কি\s*খবর|কী\s*খবর|ভালো\s*আছো|ধন্যবাদ|শুভ\s*(সকাল|দুপুর|সন্ধ্যা|রাত্রি)|ঠিক\s*আছে|ওকে)$/i;
  if (greetingPattern.test(clean)) return true;

  // Short casual chat/intro questions (<= 6 words, no coding/workspace intent)
  const wordCount = clean.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 6 && /^(who are you|what can you do|how are you|what is your name|তুমি কে|আপনি কে|কি করতে পারো|কী করতে পারো|তুমি কি পারো|পরিচয় দাও)/i.test(clean)) {
    return true;
  }
  return false;
}

function looksLikeUnfinishedNarration(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return /(শুরু করব|যুক্ত করব|তৈরি করব|করছি|করব\.?$|প্রতিক্ষয়ে|আরেকটি টুল কল|I will now|Let me |Next,? I will|Starting tool)/i.test(trimmed.slice(-220));
}

function convertSchemaToJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const mapType = (t: any): string => {
    if (!t) return 'string';
    const s = String(t).toUpperCase();
    if (s === 'OBJECT' || t === Type.OBJECT) return 'object';
    if (s === 'ARRAY' || t === Type.ARRAY) return 'array';
    if (s === 'INTEGER' || t === Type.INTEGER) return 'integer';
    if (s === 'NUMBER' || t === Type.NUMBER) return 'number';
    if (s === 'BOOLEAN' || t === Type.BOOLEAN) return 'boolean';
    return 'string';
  };
  const out: any = { type: mapType(schema.type) };
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = convertSchemaToJsonSchema(v);
    }
  } else if (out.type === 'object') {
    out.properties = {};
  }
  if (schema.items) {
    out.items = convertSchemaToJsonSchema(schema.items);
  }
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    out.required = schema.required;
  }
  return out;
}

function compactJsonSchemaDescriptions(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  const clone: any = { ...schema };
  if (typeof clone.description === 'string' && clone.description.length > 85) {
    clone.description = clone.description.slice(0, 82) + '...';
  }
  if (clone.properties && typeof clone.properties === 'object') {
    const nextProps: Record<string, any> = {};
    for (const [k, v] of Object.entries(clone.properties)) {
      nextProps[k] = compactJsonSchemaDescriptions(v);
    }
    clone.properties = nextProps;
  }
  if (clone.items) {
    clone.items = compactJsonSchemaDescriptions(clone.items);
  }
  return clone;
}

type ToolExecutionPhase = 'greenfield' | 'inspect' | 'build' | 'verify';

function selectPhaseOpenAITools(
  declarations: FunctionDeclaration[],
  promptText: string,
  mode: string,
  phase: ToolExecutionPhase,
  compactSubset: boolean,
  enableMultiAgentOmo: boolean = false
): any[] {
  const relevant = selectRelevantTools(declarations, promptText, mode, true, phase === 'greenfield', enableMultiAgentOmo);
  const phaseAllowlist: Record<ToolExecutionPhase, Set<string>> = {
    greenfield: new Set([
      'plan',
      'read_skill',
      'workspace_init',
      'write_to_file',
      'install_applet_package',
      'fetch_stock_images',
      'generate_image',
      'set_up_firebase',
      'ask_question',
      ...(enableMultiAgentOmo ? ['omo_coordinate'] : []),
    ]),
    inspect: new Set([
      'read_skill',
      'plan',
      'list_dir',
      'view_file',
      'grep_search',
      'ast_context_ranker',
      'workspace_init',
      'github_clone',
      'targeted_error_context',
      'ask_question',
      'search_web',
      'write_to_file',
      ...(enableMultiAgentOmo ? ['omo_coordinate'] : []),
    ]),
    build: new Set([
      'write_to_file',
      'replace_file_content',
      'multi_replace_file_content',
      'view_file',
      'install_applet_package',
      'workspace_run',
      'compile_applet',
      'lint_applet',
      'api_contract_checker',
      'read_skill',
      'fetch_stock_images',
      'generate_image',
      'set_up_firebase',
      'deploy_firebase',
    ]),
    verify: new Set([
      'targeted_error_context',
      'api_contract_checker',
      'view_file',
      'replace_file_content',
      'multi_replace_file_content',
      'write_to_file',
      'compile_applet',
      'lint_applet',
      'verify_live_preview',
      'workspace_run',
      'set_up_firebase',
      'deploy_firebase',
    ]),
  };

  const allowed = phaseAllowlist[phase];
  const filtered = relevant.filter((fn) => fn.name && allowed.has(fn.name));
  const finalList = (filtered.length >= 4 ? filtered : relevant).slice(0, compactSubset ? 10 : 14);
  return finalList.map((fn) => {
    const rawDesc = fn.description || '';
    const maxLen = compactSubset ? 70 : 90;
    const shortDesc = rawDesc.length > maxLen ? rawDesc.slice(0, maxLen - 3) + '...' : rawDesc;
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: shortDesc,
        parameters: compactJsonSchemaDescriptions(convertSchemaToJsonSchema(fn.parameters)),
      },
    };
  });
}

// Rolling context compaction: preserves system prompt & recent 4 messages, tightly compresses older tool outputs & payloads to cut 40-60% TPM
function compactOpenAIMessages(messages: any[], mutatedFiles?: Set<string>): any[] {
  if (messages.length <= 5) return messages;
  const keepTailStart = Math.max(1, messages.length - 4);
  const compacted = messages.map((msg, idx) => {
    if (idx === 0 || idx >= keepTailStart) return msg;
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 220) {
      const fileHeader = msg.content.match(/File Path:\s*(\/[^\n]+)\nTotal Lines:\s*(\d+)/);
      if (fileHeader) {
        return {
          ...msg,
          content: `[Previously read ${fileHeader[1]} (${fileHeader[2]} lines) — call view_file if exact lines needed again]`,
        };
      }
      return {
        ...msg,
        content: `${msg.content.slice(0, 140)}...[Compacted ${msg.content.length} chars]`,
      };
    }
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[TOOL EXECUTION RESULTS]:') && msg.content.length > 320) {
      return {
        ...msg,
        content: `${msg.content.slice(0, 170)}...[Compacted ${msg.content.length} chars]`,
      };
    }
    if (msg.role === 'assistant') {
      let nextMsg = msg;
      if (typeof msg.content === 'string' && msg.content.length > 500) {
        nextMsg = {
          ...nextMsg,
          content: `${msg.content.slice(0, 220)}...[Compacted]`,
        };
      }
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const compactedCalls = msg.tool_calls.map((tc: any) => {
          const rawArgs = tc?.function?.arguments;
          if (typeof rawArgs === 'string' && rawArgs.length > 220) {
            try {
              const parsed = JSON.parse(rawArgs);
              const target = parsed.TargetFile || parsed.filePath || parsed.AbsolutePath || 'file';
              if (typeof parsed.CodeContent === 'string' && parsed.CodeContent.length > 120) {
                parsed.CodeContent = `[Written ${parsed.CodeContent.split('\n').length}L -> ${target}]`;
              }
              if (typeof parsed.ReplacementContent === 'string' && parsed.ReplacementContent.length > 120) {
                parsed.ReplacementContent = `[Edited ${target}]`;
              }
              if (typeof parsed.TargetContent === 'string' && parsed.TargetContent.length > 100) {
                parsed.TargetContent = `[Target in ${target}]`;
              }
              return {
                ...tc,
                function: { ...tc.function, arguments: JSON.stringify(parsed) },
              };
            } catch {
              return {
                ...tc,
                function: { ...tc.function, arguments: JSON.stringify({ compacted: true, summary: rawArgs.slice(0, 100) }) },
              };
            }
          }
          return tc;
        });
        nextMsg = { ...nextMsg, tool_calls: compactedCalls };
      }
      return nextMsg;
    }
    return msg;
  });

  if (mutatedFiles && mutatedFiles.size > 0 && compacted.length > 6 && compacted[0]?.role === 'system') {
    const writtenList = Array.from(mutatedFiles).slice(-12).join(', ');
    compacted[0] = {
      ...compacted[0],
      content: `${compacted[0].content}\n\n[ACTIVE PROGRESS STATE — ALREADY WRITTEN]: ${writtenList}`,
    };
  }
  return compacted;
}

// Salvage truncated write_to_file JSON when a free model hits max_tokens mid-HTML
function trySalvageTruncatedFileWrite(rawText: string): { TargetFile: string; CodeContent: string } | null {
  if (!rawText || !rawText.includes('write_to_file') || !rawText.includes('CodeContent')) return null;
  const targetMatch = rawText.match(/"TargetFile"\s*:\s*"([^"]+)"/);
  const codeStartMatch = rawText.match(/"CodeContent"\s*:\s*"/);
  if (!targetMatch || !codeStartMatch || typeof codeStartMatch.index !== 'number') return null;
  const rawAfterQuote = rawText.slice(codeStartMatch.index + codeStartMatch[0].length);
  if (rawAfterQuote.length < 80) return null;

  // Unescape JSON string characters cleanly up to truncation point
  let decoded = '';
  for (let i = 0; i < rawAfterQuote.length; i++) {
    const ch = rawAfterQuote[i];
    if (ch === '"') break;
    if (ch === '\\' && i + 1 < rawAfterQuote.length) {
      const next = rawAfterQuote[i + 1];
      if (next === 'n') { decoded += '\n'; i++; continue; }
      if (next === 'r') { decoded += '\r'; i++; continue; }
      if (next === 't') { decoded += '\t'; i++; continue; }
      if (next === '"') { decoded += '"'; i++; continue; }
      if (next === '\\') { decoded += '\\'; i++; continue; }
      if (next === '/') { decoded += '/'; i++; continue; }
    }
    decoded += ch;
  }
  if (decoded.length < 80) return null;
  return { TargetFile: targetMatch[1], CodeContent: decoded };
}

interface SharedExecutionProgress {
  mutatedFiles: Set<string>;
  readFiles: Set<string>;
  executedTools: string[];
  committedText: string;
  activeModel?: string;
  lastGateFailure?: string;
  preEditCheckpointId?: string;
  criticRan?: boolean;
  emittedWorkspacePreview?: boolean;
}

async function ensureWorkspacePreviewEmitted(
  sharedProgress: SharedExecutionProgress | undefined,
  sessionId: string | undefined,
  sendEvent: (data: any) => void
): Promise<void> {
  if (!sharedProgress || sharedProgress.emittedWorkspacePreview) return;
  const wsIds = new Set<string>();
  for (const fp of sharedProgress.mutatedFiles) {
    const clean = fp.replace(/^\/+/, '');
    const m = clean.match(/^workspaces\/([^/]+)\//);
    if (m?.[1]) wsIds.add(sanitizeSessionId(m[1]));
  }
  if (
    wsIds.size === 0 &&
    (sharedProgress.executedTools.includes('workspace_init') || sharedProgress.executedTools.includes('github_clone')) &&
    sessionId
  ) {
    wsIds.add(sanitizeSessionId(sessionId));
  }
  const firstWs = Array.from(wsIds)[0];
  if (!firstWs) return;
  const wsDir = path.resolve(process.cwd(), 'workspaces', firstWs);
  const exists = await fs.access(wsDir).then(() => true).catch(() => false);
  if (!exists) return;

  const hasBackendServer =
    (await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false));

  let previewUrl = `/w/${firstWs}/`;
  if (!hasBackendServer) {
    const buildRes = await buildWorkspaceToStaticPreview(firstWs).catch(() => null);
    if (buildRes?.success && buildRes.previewUrl) {
      previewUrl = buildRes.previewUrl;
      sharedProgress.emittedWorkspacePreview = true;
      sendEvent({
        type: 'action',
        action: `✓ Production Vite build published to ${previewUrl}`,
      });
      sendEvent({
        type: 'preview_ready',
        url: previewUrl,
        sessionId,
        timestamp: Date.now(),
      });
      return;
    }
  }

  const startRes = await startWorkspaceServer(firstWs).catch(() => null);
  if (!startRes?.success) {
    const hasViteCfg = await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false);
    if (hasViteCfg) {
      await execPromise('npx vite build', { cwd: wsDir, timeout: 45000 }).catch(() => null);
    }
  }
  previewUrl = startRes?.proxyUrl || `/w/${firstWs}/`;
  sharedProgress.emittedWorkspacePreview = true;
  sendEvent({
    type: 'action',
    action: `✓ Sandbox preview ready at ${previewUrl}`,
  });
  sendEvent({
    type: 'preview_ready',
    url: previewUrl,
    sessionId,
    timestamp: Date.now(),
  });
}

// Convert messages to standard OpenAI format (supports vision image_url on last user turn)
function convertToOpenAIMessages(
  messages: any[],
  mode: string,
  systemOptions: SystemInstructionOptions = {},
  enrichedLastMessage?: string,
  lastMessageImages: InlineImageAttachment[] = []
): any[] {
  const systemPrompt = getNexusSystemInstruction(mode, { ...systemOptions, compactForFreeApi: true });

  const safeMessages = Array.isArray(messages) ? messages : [];
  const formatted: any[] = [{ role: 'system', content: systemPrompt }];
  for (let i = 0; i < safeMessages.length; i++) {
    const m = safeMessages[i];
    const isLastUser = i === safeMessages.length - 1 && m.role !== 'model' && m.role !== 'assistant';
    const text = isLastUser && enrichedLastMessage
      ? enrichedLastMessage
      : (m.parts?.[0]?.text || m.content || '');
    if (text) {
      if (isLastUser && lastMessageImages.length > 0) {
        formatted.push({
          role: 'user',
          content: [
            { type: 'text', text },
            ...lastMessageImages
              .filter(img => Boolean(img.dataUrl))
              .map(img => ({ type: 'image_url', image_url: { url: img.dataUrl! } })),
          ],
        });
      } else {
        formatted.push({
          role: m.role === 'model' || m.role === 'assistant' ? 'assistant' : 'user',
          content: text
        });
      }
    }
  }
  return formatted;
}

const FILE_WRITE_TOOL_NAMES = new Set([
  'write_to_file',
  'fileWrite',
  'replace_file_content',
  'fileEdit',
  'multi_replace_file_content',
]);

async function auditLargeModularWorkspace(wsDir: string): Promise<{
  fileCount: number;
  totalLines: number;
  hasUntouchedBoilerplate: boolean;
}> {
  let fileCount = 0;
  let totalLines = 0;
  let hasUntouchedBoilerplate = false;

  const walk = async (dir: string) => {
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (/\.(ts|tsx|js|jsx|css)$/i.test(ent.name) && ent.name !== 'vite-env.d.ts' && ent.name !== 'main.tsx') {
        fileCount++;
        try {
          const raw = await fs.readFile(full, 'utf-8');
          totalLines += raw.split('\n').length;
          if (ent.name === 'HomePage.tsx' && raw.includes('Modular Workspace Ready')) {
            hasUntouchedBoilerplate = true;
          }
        } catch {}
      }
    }
  };

  await walk(path.join(wsDir, 'src'));
  await walk(path.join(wsDir, 'server'));
  try {
    const srvRaw = await fs.readFile(path.join(wsDir, 'server.ts'), 'utf-8');
    fileCount++;
    totalLines += srvRaw.split('\n').length;
  } catch {}

  return { fileCount, totalLines, hasUntouchedBoilerplate };
}

// Mandatory Server-Side Self-Healing Verification Gate: catches compiler/build/runtime/DOM/visual/cross-model defects before agent stops
async function runMandatorySelfHealingGate(
  mutatedFiles: Set<string>,
  sessionId: string | undefined,
  sendEvent: (data: any) => void,
  geminiApiKey?: string,
  harnessCtx?: {
    originalPrompt?: string;
    poolKeys?: KeyConfig[];
    activeKeyId?: string;
    fallbackInvoker?: (sys: string, usr: string) => Promise<string>;
    sharedProgress?: SharedExecutionProgress;
    selfHealRound?: number;
    signal?: AbortSignal;
  }
): Promise<{ passed: boolean; feedbackPrompt?: string }> {
  throwIfAborted(harnessCtx?.signal);
  const files = Array.from(mutatedFiles).map((f) => f.replace(/^\/+/, ''));
  if (files.length === 0) return { passed: true };

  const gateStepId = emitActionStep(
    sendEvent,
    'qc',
    'Self-Healing Gate: verifying types, build & runtime preview',
    files.slice(0, 4).join(', '),
    { status: 'running', agentRole: 'debugger' }
  );
  const start = Date.now();
  const failures: string[] = [];

  try {
    throwIfAborted(harnessCtx?.signal);
    const rootTsMutated = files.some(
      (f) => /\.(ts|tsx)$/i.test(f) && (f.startsWith('src/') || f.startsWith('server/') || f === 'server.ts')
    );
    const viteBuildNeeded = files.some(
      (f) => f.startsWith('src/') || f === 'index.html' || f === 'vite.config.ts'
    );
    const htmlPreviewTargets = files.filter((f) => f.startsWith('projects/') && f.endsWith('.html'));
    const workspaceIds = new Set<string>();
    for (const f of files) {
      const m = f.match(/^workspaces\/([^/]+)\//);
      if (m?.[1]) workspaceIds.add(m[1]);
    }

    if (rootTsMutated) {
      try {
        await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 25000 });
      } catch (tscErr: any) {
        const rawErr = (tscErr.stdout || tscErr.stderr || tscErr.message || '').slice(0, 1800);
        const targeted = await extractTargetedErrorContext(rawErr, '.').catch(() => null);
        const slices = targeted?.diagnostics?.length
          ? '\n\n[TARGETED ERROR SLICES]:\n' + targeted.diagnostics.map((d) => `--- ${d.file}:${d.line} (${d.message}) ---\n${d.snippet}`).join('\n')
          : '';
        failures.push(`[TypeScript Root Compiler Errors]:\n${rawErr}${slices}`);
      }
    }

    if (viteBuildNeeded && failures.length === 0) {
      try {
        await execPromise('npm run build', { cwd: process.cwd(), timeout: 45000 });
      } catch (buildErr: any) {
        failures.push(`[Vite Production Build Errors]:\n${(buildErr.stdout || buildErr.stderr || buildErr.message || '').slice(0, 1800)}`);
      }
    }

    // Root full-stack API contract verification
    if (files.some((f) => f.startsWith('src/') || f.startsWith('server/') || f === 'server.ts') && failures.length === 0) {
      const apiReport = await checkApiContracts('.').catch(() => null);
      if (apiReport && (!apiReport.ok) && (apiReport.mismatches.length > 0 || apiReport.warnings.length > 0)) {
        failures.push(
          `[API Contract Mismatches]:\n${[...apiReport.mismatches, ...apiReport.warnings].slice(0, 6).join('\n')}`
        );
      }
    }

    const isModularWebsiteTask = shouldUseModularArchitecture(harnessCtx?.originalPrompt || '');

    if (isModularWebsiteTask && htmlPreviewTargets.length > 0 && workspaceIds.size === 0) {
      const safeId = sanitizeSessionId(sessionId || 'app');
      failures.push(
        `[Large Website Policy Violation]: Nexus ONLY builds large modular multi-file websites inside workspaces/${safeId}/ (single-file projects/*.html websites are disabled). Call workspace_init(sessionId: "${safeId}", template: "react-vite" or "fullstack-express") and build 10-15+ modular React/Vite files.`
      );
    }

    const isClonedRepoTask =
      isGitHubClonePrompt(harnessCtx?.originalPrompt || '') ||
      Boolean(harnessCtx?.sharedProgress?.executedTools?.includes('github_clone'));

    for (const wsId of workspaceIds) {
      const safeWsId = sanitizeSessionId(wsId);
      const wsDir = path.resolve(process.cwd(), 'workspaces', safeWsId);
      let wsTscPassed = true;
      let publishedStaticPreviewUrl: string | null = null;

      // Cloned third-party GitHub repos may have upstream TypeScript strictness or PWA build quirks — boot & verify runtime directly instead of blocking on tsc/vite build
      if (!isClonedRepoTask) {
        try {
          await fs.access(path.join(wsDir, 'tsconfig.json'));
          try {
            await execPromise('npx tsc --noEmit', { cwd: wsDir, timeout: 25000 });
          } catch (wsTscErr: any) {
            wsTscPassed = false;
            const rawErr = (wsTscErr.stdout || wsTscErr.stderr || wsTscErr.message || '').slice(0, 1800);
            const targeted = await extractTargetedErrorContext(rawErr, `workspaces/${safeWsId}`).catch(() => null);
            const slices = targeted?.diagnostics?.length
              ? '\n\n[TARGETED ERROR SLICES]:\n' + targeted.diagnostics.map((d) => `--- ${d.file}:${d.line} (${d.message}) ---\n${d.snippet}`).join('\n')
              : '';
            failures.push(
              `[Sandbox /w/${safeWsId} TypeScript Errors]:\n${rawErr}${slices}`
            );
          }
        } catch {
          // No tsconfig.json in sandbox
        }

        if (wsTscPassed) {
          const hasViteCfg =
            (await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false)) ||
            (await fs.access(path.join(wsDir, 'vite.config.js')).then(() => true).catch(() => false));
          const hasBackendServer =
            (await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false)) ||
            (await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false));

          if (hasViteCfg) {
            if (!hasBackendServer && !isClonedRepoTask) {
              const staticBuild = await buildWorkspaceToStaticPreview(safeWsId);
              if (staticBuild.success) {
                publishedStaticPreviewUrl = staticBuild.previewUrl;
              } else {
                failures.push(
                  `[Sandbox /projects/${safeWsId}/ Vite Build Errors]:\n${(staticBuild.stdout || staticBuild.stderr || staticBuild.error || '').slice(0, 1800)}`
                );
              }
            } else {
              try {
                await execPromise('npx vite build', { cwd: wsDir, timeout: 45000 });
              } catch (wsViteErr: any) {
                failures.push(
                  `[Sandbox /w/${safeWsId} Vite Build Errors]:\n${(wsViteErr.stdout || wsViteErr.stderr || wsViteErr.message || '').slice(0, 1800)}`
                );
              }
            }
          }

          if (hasBackendServer) {
            const wsApiReport = await checkApiContracts(`workspaces/${safeWsId}`).catch(() => null);
            if (wsApiReport && !wsApiReport.ok && (wsApiReport.mismatches.length > 0 || wsApiReport.warnings.length > 0)) {
              failures.push(
                `[Sandbox /w/${safeWsId} API Contract Mismatches]:\n${[...wsApiReport.mismatches, ...wsApiReport.warnings].slice(0, 6).join('\n')}`
              );
            }
          }
        }
      }

      // Workspace Completeness & Quality Audit: ensure starter boilerplate isn't untouched and fresh workspaces have real structure (skip for cloned GitHub repos)
      if (isModularWebsiteTask && !isClonedRepoTask) {
        const wsAudit = await auditLargeModularWorkspace(wsDir);
        const isFreshInit = Boolean(harnessCtx?.sharedProgress?.executedTools?.includes('workspace_init'));
        const isMassiveScaleRequest = /(5000|10000|5,000|10,000|5k|10k|৫\s*হাজার|১০\s*হাজার|হাজার\s*লাইন)/i.test(
          harnessCtx?.originalPrompt || ''
        );
        const minFiles = isMassiveScaleRequest ? 12 : 3;
        const minLines = isMassiveScaleRequest && (harnessCtx?.selfHealRound || 0) === 0 ? 2500 : 0;
        const failedMinFiles = isFreshInit && wsAudit.fileCount < minFiles;
        const failedMassiveLines = isMassiveScaleRequest && wsAudit.totalLines < minLines;
        if (wsAudit.hasUntouchedBoilerplate || failedMinFiles || failedMassiveLines) {
          failures.push(
            `[Workspace Completeness Audit Failed (/w/${safeWsId})]: Found ${wsAudit.fileCount} source files (${wsAudit.totalLines} lines${wsAudit.hasUntouchedBoilerplate ? ', starter "Modular Workspace Ready" boilerplate still untouched' : ''}). Ensure starter boilerplate is replaced and at least ${minFiles} clean modular files${minLines > 0 ? ` (${minLines}+ lines)` : ''} exist before finishing.`
          );
        }

        // Code-Matched Firebase Backend Audit (only when Firebase already provisioned OR explicitly requested by user)
        const bpRaw = await fs.readFile(path.join(wsDir, 'firebase-blueprint.json'), 'utf-8').catch(() => '');
        const needsFirebaseBackend = /(firebase|firestore|firebaseconfig|ফায়ারবেস|ফায়ারবেস)/i.test(
          harnessCtx?.originalPrompt || ''
        );
        if (bpRaw.trim()) {
          let parsedBp: any = null;
          try { parsedBp = JSON.parse(bpRaw); } catch {}
          const rulesRaw = await fs.readFile(path.join(wsDir, 'firestore.rules'), 'utf-8').catch(() => '');
          const rulesCheck = auditFirestoreRules(rulesRaw, parsedBp);
          if (!rulesCheck.valid) {
            failures.push(
              `[Firebase firestore.rules Validation Failed (/w/${safeWsId})]: ${rulesCheck.issues.join(' | ')}. Call set_up_firebase(sessionId: "${safeWsId}", platform: "web") or deploy_firebase(sessionId: "${safeWsId}").`
            );
          }
          const hasFbBackend = await fs.access(path.join(wsDir, 'src/services/firebaseBackend.ts')).then(() => true).catch(() => false);
          const hasFbSdk = await fs.access(path.join(wsDir, 'src/lib/firebase.ts')).then(() => true).catch(() => false);
          const hasFbProvider = await fs.access(path.join(wsDir, 'src/components/FirebaseProvider.tsx')).then(() => true).catch(() => false);
          if (!hasFbBackend || !hasFbSdk || !hasFbProvider) {
            failures.push(
              `[Firebase Backend Wiring Incomplete (/w/${safeWsId})]: Missing ${[!hasFbSdk && 'src/lib/firebase.ts', !hasFbProvider && 'src/components/FirebaseProvider.tsx', !hasFbBackend && 'src/services/firebaseBackend.ts'].filter(Boolean).join(', ')}. Call set_up_firebase(sessionId: "${safeWsId}", platform: "web") to generate code-matched Firebase backend modules.`
            );
          } else {
            const appRaw = await fs.readFile(path.join(wsDir, 'src/App.tsx'), 'utf-8').catch(() => '');
            const mainRaw = await fs.readFile(path.join(wsDir, 'src/main.tsx'), 'utf-8').catch(() => '');
            if (!/FirebaseProvider/.test(appRaw) && !/FirebaseProvider/.test(mainRaw)) {
              failures.push(
                `[FirebaseProvider Not Wired (/w/${safeWsId})]: src/App.tsx or src/main.tsx must wrap the root app in <FirebaseProvider> from './components/FirebaseProvider' and connect hooks/pages to './services/firebaseBackend'.`
              );
            }
          }
        } else if (needsFirebaseBackend && (harnessCtx?.selfHealRound || 0) === 0) {
          failures.push(
            `[Code-Matched Firebase Backend Missing (/w/${safeWsId})]: The user requested Firebase. Call set_up_firebase(sessionId: "${safeWsId}", platform: "web", blueprint: {...}) matching src/types.ts, wrap src/App.tsx in <FirebaseProvider>, wire CRUD to src/services/firebaseBackend.ts, and call deploy_firebase(sessionId: "${safeWsId}").`
          );
        }
      }

      const effectiveVisionKey =
        geminiApiKey ||
        harnessCtx?.poolKeys?.find((k) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey ||
        process.env.GEMINI_API_KEY;

      const wsPreviewUrl =
        typeof publishedStaticPreviewUrl === 'string' && publishedStaticPreviewUrl
          ? publishedStaticPreviewUrl
          : `/w/${safeWsId}/`;
      const domRes = await verifyLivePreviewWithDom(wsPreviewUrl, !isClonedRepoTask, sessionId);
      const fatalClonedErr =
        isClonedRepoTask
          ? Boolean(domRes.error || !domRes.status || domRes.status >= 500)
          : !domRes.ok;
      if (fatalClonedErr) {
        failures.push(
          `[Sandbox ${wsPreviewUrl} Verification Errors]: status=${domRes.status || 'unreachable'}, error=${domRes.error || 'none'}, syntax=${JSON.stringify(domRes.syntaxErrors)}, runtime=${JSON.stringify(domRes.runtimeErrors)}, clickErrors=${JSON.stringify(domRes.interactionAudit?.clickErrors || [])}, brokenAssets=${JSON.stringify(domRes.brokenAssets)}, emptyRoot=${domRes.domMetrics?.emptyRootDetected}`
        );
      } else if (!isClonedRepoTask && (process.env.BROWSERLESS_TOKEN || process.env.BROWSERLESS_URL)) {
        const vqaStepId = emitActionStep(
          sendEvent,
          'qc',
          `Browserless Screenshot & Vision Audit (${wsPreviewUrl})`,
          'Inspecting rendered desktop layout & contrast',
          { status: 'running' }
        );
        const qaRes = await runVisualQaReview({
          targetUrl: wsPreviewUrl,
          sessionId,
          viewport: 'desktop',
          geminiApiKey: effectiveVisionKey,
        });
        const qaPassed = qaRes.ok || qaRes.layoutIssues.length === 0;
        emitActionStep(
          sendEvent,
          'qc',
          qaPassed
            ? `Browserless Visual QA passed (${qaRes.visualScore ?? 8}/10)`
            : `Browserless Visual QA found ${qaRes.layoutIssues.length} layout defect(s)`,
          qaRes.visionCritique?.slice(0, 140) || qaRes.screenshotUrl,
          { id: vqaStepId, status: qaPassed ? 'done' : 'error', isError: !qaPassed }
        );
        if (!qaPassed && qaRes.layoutIssues.length > 0) {
          failures.push(
            `[Visual QA Screenshot Audit Failed on ${wsPreviewUrl} (Score: ${qaRes.visualScore ?? '?'}/10)]: ${qaRes.layoutIssues.join('; ')}${qaRes.visionCritique ? ` | Critique: ${qaRes.visionCritique}` : ''}${qaRes.recommendations?.length ? ` | Fix: ${qaRes.recommendations.join(' ')}` : ''}`
          );
        }
      }
    }

    const effectiveHtmlVisionKey =
      geminiApiKey ||
      harnessCtx?.poolKeys?.find((k) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey ||
      process.env.GEMINI_API_KEY;

    for (const htmlFile of htmlPreviewTargets.slice(0, 1)) {
      const urlPath = `/${htmlFile}`;
      const domRes = await verifyLivePreviewWithDom(urlPath, true, sessionId);
      if (!domRes.ok) {
        const truncationNote = domRes.hasClosedHtml === false ? ' [TRUNCATED_HTML: missing closing </body></html>]' : '';
        failures.push(
          `[Live Preview ${urlPath} Runtime/DOM Errors]${truncationNote}: syntax=${JSON.stringify(domRes.syntaxErrors)}, runtime=${JSON.stringify(domRes.runtimeErrors)}, clickErrors=${JSON.stringify(domRes.interactionAudit?.clickErrors || [])}, brokenAssets=${JSON.stringify(domRes.brokenAssets)}, emptyRoot=${domRes.domMetrics?.emptyRootDetected}`
        );
      } else if (process.env.BROWSERLESS_TOKEN || process.env.BROWSERLESS_URL) {
        const qaRes = await runVisualQaReview({
          targetUrl: urlPath,
          sessionId,
          viewport: 'desktop',
          geminiApiKey: effectiveHtmlVisionKey,
        });
        if (!qaRes.ok && qaRes.layoutIssues.length > 0) {
          failures.push(
            `[Visual QA Issues on ${urlPath} (Score: ${qaRes.visualScore ?? '?'}/10)]: ${qaRes.layoutIssues.join('; ')}${qaRes.visionCritique ? ` | Critique: ${qaRes.visionCritique}` : ''}`
          );
        }
      }
    }

    // Cross-Model Critic: runs once when compiler/build/DOM passed and another healthy key exists in the pool
    if (
      failures.length === 0 &&
      (harnessCtx?.selfHealRound || 0) === 0 &&
      !harnessCtx?.sharedProgress?.criticRan &&
      harnessCtx?.originalPrompt &&
      harnessCtx?.poolKeys &&
      harnessCtx.poolKeys.length > 1
    ) {
      if (harnessCtx.sharedProgress) harnessCtx.sharedProgress.criticRan = true;
      const criticCandidates = harnessCtx.poolKeys.filter(
        (k) =>
          k.isActive &&
          k.id !== harnessCtx.activeKeyId &&
          k.provider !== 'groq' &&
          getKeyEffectiveCaps(k).rawTpmLimit > 8000 &&
          getOrCreateStats(k.id).cooldownUntil <= Date.now()
      );
      const { key: criticKey } = selectBestKey(criticCandidates, 'all', new Set(), null, {
        loadBalance: true,
        desiredTier: 'architect',
        estimatedTokens: 2500,
      });
      if (criticKey) {
        acquireKeyInFlight(criticKey.id);
        const criticStepId = emitActionStep(
          sendEvent,
          'qc',
          `Cross-Model Critic (${criticKey.name}) auditing code`,
          files.slice(0, 3).join(', '),
          { status: 'running' }
        );
        const criticRes = await runCrossModelCritic({
          mutatedFiles: files,
          originalPrompt: harnessCtx.originalPrompt,
          criticKey: {
            id: criticKey.id,
            name: criticKey.name,
            provider: criticKey.provider,
            apiKey: criticKey.apiKey,
            model: getProviderModelChain(criticKey.provider, normalizeModelName(criticKey.provider, criticKey.model))[0] || criticKey.model,
            baseUrl: criticKey.baseUrl,
          },
          fallbackInvoker: harnessCtx.fallbackInvoker,
          getEndpoint: getOpenAICompatibleEndpoint,
        }).finally(() => releaseKeyInFlight(criticKey.id));
        emitActionStep(
          sendEvent,
          'qc',
          criticRes.passed
            ? `Cross-Model Critic passed (${criticRes.criticName})`
            : `Cross-Model Critic found ${criticRes.issues.length} defect(s)`,
          criticRes.issues[0]?.slice(0, 120) || 'No blocking issues',
          { id: criticStepId, status: criticRes.passed ? 'done' : 'error', isError: !criticRes.passed }
        );
        if (criticRes.ran && !criticRes.passed && criticRes.issues.length > 0) {
          failures.push(`[Cross-Model Critic Review (${criticRes.criticName})]:\n- ${criticRes.issues.join('\n- ')}`);
        }
      }
    }

    const dur = Math.max(0.1, Number(((Date.now() - start) / 1000).toFixed(1)));
    if (failures.length === 0) {
      if (harnessCtx?.sharedProgress?.lastGateFailure) {
        recordErrorFixResolution(
          harnessCtx.sharedProgress.lastGateFailure,
          `Verified fix passed tsc/build/DOM checks on ${files.slice(0, 3).join(', ')}`
        );
        harnessCtx.sharedProgress.lastGateFailure = undefined;
      }
      emitActionStep(sendEvent, 'qc', 'Self-Healing Gate passed (0 errors)', files.slice(0, 3).join(', '), {
        id: gateStepId,
        status: 'done',
        durationSec: dur,
      });
      return { passed: true };
    }

    if (harnessCtx?.sharedProgress) {
      harnessCtx.sharedProgress.lastGateFailure = failures[0];
    }

    const kbHints = lookupErrorKnowledgeBase(failures.join('\n'));
    const kbBlock = kbHints.length > 0
      ? `\n\n[ERROR KNOWLEDGE BASE FIX PLAYBOOK]:\n- ${kbHints.join('\n- ')}`
      : '';

    emitActionStep(sendEvent, 'qc', 'Self-Healing Gate caught errors — auto-fixing', failures[0].slice(0, 140), {
      id: gateStepId,
      status: 'error',
      durationSec: dur,
      isError: true,
    });
    sendEvent({
      type: 'action',
      action: `🔧 Self-Healing Gate: এরর ধরা পড়েছে — নলেজ বেস ও অটো-হিলিং দিয়ে ঠিক করা হচ্ছে...`,
    });

    return {
      passed: false,
      feedbackPrompt: `[MANDATORY SERVER SELF-HEALING VERIFICATION FAILED]:
Your recent edits produced real compiler/build/runtime/critic defects:
${failures.join('\n\n')}${kbBlock}

Fix every defect directly in the workspace files NOW using replace_file_content or write_to_file, then re-verify. Do NOT apologize or stop until fixed.`,
    };
  } catch (err: any) {
    if (isAbortOrCancelError(err, harnessCtx?.signal)) {
      emitActionStep(sendEvent, 'qc', 'Self-Healing Gate cancelled', undefined, { id: gateStepId, status: 'done' });
      throw new JobCancelledError();
    }
    emitActionStep(sendEvent, 'qc', 'Self-Healing Gate checked', undefined, { id: gateStepId, status: 'done' });
    return { passed: true };
  }
}

// Stream chat with OpenAI-compatible endpoints (OpenRouter, Groq, Cerebras, Mistral, Grok, Custom) WITH full tool-calling + text-tool fallback loop
async function streamOpenAICompatible(
  endpoint: string,
  apiKey: string,
  model: string,
  headers: Record<string, string>,
  messages: any[],
  mode: string,
  sendEvent: (data: any) => void,
  systemOptions: SystemInstructionOptions = {},
  execCtx: ToolExecutionContext = {},
  enrichedLastMessage?: string,
  rawUserPrompt: string = '',
  trackedKey?: KeyConfig,
  allowTools: boolean = true,
  lastMessageImages: InlineImageAttachment[] = [],
  sharedProgress?: SharedExecutionProgress,
  poolKeys: KeyConfig[] = []
): Promise<string> {
  const effectiveExecCtx: ToolExecutionContext = { ...execCtx, compactMode: true };
  const isFreshGreenfield = await isFreshGreenfieldWebsiteBuild(rawUserPrompt, execCtx?.sessionId);
  const isLowTpmGroqKey = (k?: KeyConfig, ep?: string): boolean =>
    k?.provider === 'groq' ||
    (ep || '').includes('api.groq.com') ||
    (k ? getKeyEffectiveCaps(k).rawTpmLimit <= 8000 : false);
  const initialIsLowTpmGroq = isLowTpmGroqKey(trackedKey, endpoint);
  const effectiveSystemOptions: SystemInstructionOptions = initialIsLowTpmGroq
    ? { ...systemOptions, multiAgent: false }
    : systemOptions;
  const initialEnableOmo =
    Boolean(systemOptions.multiAgent) &&
    !initialIsLowTpmGroq &&
    isActionOrBuildPrompt(rawUserPrompt);
  let openAiMessages: any[] = convertToOpenAIMessages(messages, mode, effectiveSystemOptions, enrichedLastMessage, lastMessageImages);
  let openAiTools = allowTools
    ? selectPhaseOpenAITools(serverTools, rawUserPrompt, mode, isFreshGreenfield ? 'greenfield' : 'inspect', false, initialEnableOmo)
    : [];
  let usingCompactTools = false;
  let activeKeyObj = trackedKey;
  let activeEndpoint = endpoint;
  let activeApiKey = apiKey;
  let activeHeaders = headers;
  let activePreferredModel = model;
  const initialProvider =
    activeKeyObj?.provider ||
    (activeEndpoint.includes('openrouter.ai')
      ? 'openrouter'
      : activeEndpoint.includes('router.huggingface.co')
        ? 'huggingface'
        : activeEndpoint.includes('api.deepseek.com')
          ? 'deepseek'
          : 'custom');
  let targetModel =
    initialProvider === 'openrouter'
      ? getOpenRouterModelChain(model)[0]
      : initialProvider === 'huggingface'
        ? getHuggingFaceModelChain(model)[0]
        : initialProvider === 'deepseek'
          ? getDeepSeekModelChain(model)[0]
          : model;
  if (activeKeyObj && !['openrouter', 'huggingface', 'deepseek'].includes(activeKeyObj.provider) && isModelInOutage(activeKeyObj.provider, targetModel)) {
    const chain = getProviderModelChain(activeKeyObj.provider, targetModel);
    if (chain.length > 0) targetModel = chain[0];
  }
  if (sharedProgress) {
    sharedProgress.activeModel = targetModel;
  }
  let toolsEnabled = allowTools;
  let committedText = sharedProgress?.committedText || '';
  let didMutateFiles = (sharedProgress?.mutatedFiles.size || 0) > 0;
  let calledAnyTool = (sharedProgress?.executedTools.length || 0) > 0;
  let continuationNudges = 0;
  let selfHealRounds = 0;
  let inlineHotSwaps = 0;
  const requiresImplementation = isActionOrBuildPrompt(rawUserPrompt);

  // Convert native tool_call/tool-role history into provider-neutral messages when hopping to a different OpenAI-compatible API
  const normalizeCrossProviderMessages = (msgs: any[]): any[] => {
    const out: any[] = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        const callNames = m.tool_calls.map((tc: any) => tc?.function?.name || 'tool').join(', ');
        const textPrefix = typeof m.content === 'string' && m.content.trim() ? `${m.content.trim()}\n` : '';
        out.push({ role: 'assistant', content: `${textPrefix}[Executed tools: ${callNames}]` });
        continue;
      }
      if (m.role === 'tool') {
        const snippet = typeof m.content === 'string' ? m.content.slice(0, 500) : JSON.stringify(m.content || '').slice(0, 500);
        const prev = out[out.length - 1];
        if (prev && prev.role === 'user' && typeof prev.content === 'string' && prev.content.startsWith('[TOOL RESULTS]:')) {
          prev.content += `\n- ${snippet}`;
        } else {
          out.push({ role: 'user', content: `[TOOL RESULTS]:\n- ${snippet}` });
        }
        continue;
      }
      out.push(m);
    }
    return out;
  };

  let currentMessages: any[] = openAiMessages;
  const healthyPoolCount = Math.max(1, poolKeys.filter(k => k.isActive && getOrCreateStats(k.id).cooldownUntil <= Date.now()).length);
  const maxRounds = allowTools ? 60 : 1;
  const signal = execCtx?.signal;
  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted(signal);
    const roundDesiredTier: Exclude<KeyRoleTier, 'auto'> =
      (round === 0 && requiresImplementation) || selfHealRounds > 0 ? 'architect' : 'builder';

    // Per-round proactive multi-API load balancing across ALL healthy OpenAI-compatible keys (keeps 20-40 keys well under 1-min limits)
    if (round > 0 && activeKeyObj && poolKeys.length > 1) {
      const openAiPoolCandidates = poolKeys.filter(k =>
        k.isActive &&
        k.id !== activeKeyObj!.id &&
        ['openrouter', 'huggingface', 'deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(k.provider) &&
        getOrCreateStats(k.id).cooldownUntil <= Date.now()
      );
      if (openAiPoolCandidates.length > 0) {
        const sameProviderKeys = openAiPoolCandidates.filter(k => k.provider === activeKeyObj!.provider);
        const candidatePool = sameProviderKeys.length > 0 ? sameProviderKeys : openAiPoolCandidates;
        const estRoundTokens = estimateTokensFromPayload(openAiMessages.slice(-4)) + 1000;
        const { key: nextKey } = selectBestKey(candidatePool, 'all', new Set(), null, {
          loadBalance: true,
          desiredTier: roundDesiredTier,
          estimatedTokens: estRoundTokens,
        });
        if (nextKey && nextKey.id !== activeKeyObj.id) {
          const currStats = getOrCreateStats(activeKeyObj.id);
          const nextStats = getOrCreateStats(nextKey.id);
          const currCaps = getKeyEffectiveCaps(activeKeyObj);
          const currTpm = currStats.tokenTimestamps.reduce((s, e) => s + e.tokens, 0);
          const nearHalfRpm = (currStats.timestamps.length + currStats.inFlightCount) >= Math.max(2, Math.floor(currCaps.safeRpmCap * 0.45));
          const nearHalfTpm = (currTpm + estRoundTokens) >= Math.floor(currCaps.safeTpmCap * 0.65);
          const shouldRotateProvider =
            openAiPoolCandidates.length >= 4 ||
            nearHalfRpm ||
            nearHalfTpm ||
            (sameProviderKeys.length > 0 ? nextStats.timestamps.length < currStats.timestamps.length : round % 2 === 0);

          if (shouldRotateProvider) {
            const switchedProvider = nextKey.provider !== activeKeyObj.provider;
            activeKeyObj = nextKey;
            activeApiKey = nextKey.apiKey;
            activeEndpoint = getOpenAICompatibleEndpoint(nextKey.provider, nextKey.baseUrl);
            activeHeaders = nextKey.provider === 'openrouter'
              ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
              : {};
            activePreferredModel = normalizeModelName(nextKey.provider, nextKey.model);
            const nextChain = getProviderModelChain(nextKey.provider, activePreferredModel);
            targetModel = nextChain[0] || activePreferredModel;
            if (switchedProvider) {
              // Ensure tool-history compatibility when collaborating across different OpenAI-compatible APIs
              const normalized = normalizeCrossProviderMessages(openAiMessages);
              openAiMessages.length = 0;
              openAiMessages.push(...normalized);
            }
            sendEvent({
              type: 'key_active',
              keyId: nextKey.id,
              keyName: nextKey.name,
              provider: nextKey.provider,
              model: targetModel,
              isCustomKey: true,
            });
          }
        }
      }
    }
    currentMessages = openAiMessages;
    if (allowTools) {
      const currentPhase: ToolExecutionPhase =
        selfHealRounds > 0
          ? 'verify'
          : didMutateFiles || Boolean(sharedProgress?.executedTools?.includes('workspace_init'))
            ? 'build'
            : isFreshGreenfield
              ? 'greenfield'
              : 'inspect';
      const omoAlreadyRan = Boolean(sharedProgress?.executedTools?.includes('omo_coordinate'));
      const enableOmoThisRound =
        Boolean(systemOptions.multiAgent) &&
        !isLowTpmGroqKey(activeKeyObj, activeEndpoint) &&
        !usingCompactTools &&
        !didMutateFiles &&
        !omoAlreadyRan &&
        isActionOrBuildPrompt(rawUserPrompt);
      openAiTools = selectPhaseOpenAITools(serverTools, rawUserPrompt, mode, currentPhase, usingCompactTools, enableOmoThisRound);
    }

    let compactedMessages = compactOpenAIMessages(currentMessages, sharedProgress?.mutatedFiles);
    await paceAndTrackKeyRound(activeKeyObj, round, sendEvent, estimateTokensFromPayload(compactedMessages), healthyPoolCount, signal);
    const buildPayload = (useModel: string, useTools: boolean, msgs: any[] = compactedMessages) => {
      const payload: any = {
        model: useModel,
        messages: msgs,
        stream: true,
      };
      if (useTools && openAiTools.length > 0) {
        payload.tools = openAiTools;
        payload.tool_choice = 'auto';
      }
      return JSON.stringify(payload);
    };

    const routerProvider: 'openrouter' | 'huggingface' | 'deepseek' | null =
      activeKeyObj?.provider === 'openrouter' || activeEndpoint.includes('openrouter.ai')
        ? 'openrouter'
        : activeKeyObj?.provider === 'huggingface' || activeEndpoint.includes('router.huggingface.co')
          ? 'huggingface'
          : activeKeyObj?.provider === 'deepseek' || activeEndpoint.includes('api.deepseek.com')
            ? 'deepseek'
            : null;
    const isRouterChainCall = routerProvider !== null;

    const getRoundModelChain = (): string[] => {
      if (!routerProvider) return [targetModel];
      const baseChain =
        routerProvider === 'openrouter'
          ? getOpenRouterModelChain(activePreferredModel)
          : routerProvider === 'huggingface'
            ? getHuggingFaceModelChain(activePreferredModel)
            : getDeepSeekModelChain(activePreferredModel);
      if (round === 0) return baseChain;
      const currentIdx = baseChain.indexOf(targetModel);
      return currentIdx >= 0 ? baseChain.slice(currentIdx) : baseChain;
    };

    const roundModelChain = getRoundModelChain();
    let roundText = '';
    let roundReasoning = '';
    let emittedReasoningStep = false;
    const toolCallsMap = new Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>();
    const routerModelErrors: Array<{ model: string; status: number; message: string }> = [];
    let hfPayment402Count = 0;
    let roundSucceeded = false;
    const roundLockKeyId = activeKeyObj?.id;
    acquireKeyInFlight(roundLockKeyId);

    try {
    for (let modelIdx = 0; modelIdx < roundModelChain.length; modelIdx++) {
      throwIfAborted(signal);
      const candidateModel = roundModelChain[modelIdx];
      targetModel = candidateModel;
      roundText = '';
      roundReasoning = '';
      emittedReasoningStep = false;
      toolCallsMap.clear();

      if (isRouterChainCall && (round === 0 || modelIdx > 0)) {
        sendEvent({
          type: 'key_active',
          keyId: activeKeyObj?.id || routerProvider || 'openrouter',
          keyName: activeKeyObj?.name || (routerProvider === 'huggingface' ? 'Hugging Face Router' : routerProvider === 'deepseek' ? 'DeepSeek API' : 'OpenRouter'),
          provider: activeKeyObj?.provider || routerProvider || 'openrouter',
          model: candidateModel,
          isCustomKey: true,
        });
      }

      if (isRouterChainCall && modelIdx > 0) {
        const prevFail = routerModelErrors[routerModelErrors.length - 1];
        const isUltimateBackup = routerProvider === 'openrouter' && candidateModel === 'openrouter/free';
        const providerTitle = routerProvider === 'huggingface' ? 'Hugging Face Router' : routerProvider === 'deepseek' ? 'DeepSeek' : 'OpenRouter';
        sendEvent({
          type: 'action',
          action: isUltimateBackup
            ? `🛡️ ওপরের সব OpenRouter মডেল ফেইল/রেট-লিমিট হয়েছে — আল্টিমেট ব্যাকআপ "openrouter/free" সিলেক্ট করে রিকোয়েস্ট পাঠানো হচ্ছে...`
            : `🔄 ${providerTitle}: "${prevFail?.model || 'Previous model'}" ফেইল করেছে (${prevFail?.status || 'ERR'}) — পরবর্তী ফলব্যাক মডেল "${candidateModel}" ট্রাই করা হচ্ছে...`,
        });
      }

      const sendRequest = async (useModel: string, useTools: boolean, msgs: any[] = compactedMessages) => {
        throwIfAborted(signal);
        return fetch(activeEndpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${activeApiKey}`,
            'Content-Type': 'application/json',
            ...activeHeaders,
          },
          body: buildPayload(useModel, useTools, msgs),
          ...(signal ? { signal } : {}),
        });
      };

      let res: globalThis.Response | null = null;
      let fetchNetworkError: any = null;

      try {
        res = await sendRequest(candidateModel, toolsEnabled);
      } catch (netErr: any) {
        if (isAbortOrCancelError(netErr, signal)) {
          throw new JobCancelledError();
        }
        fetchNetworkError = netErr;
      }

      if (fetchNetworkError) {
        if (signal?.aborted) throw new JobCancelledError();
        const netMsg = String(fetchNetworkError?.message || fetchNetworkError || 'Network error');
        if (isRouterChainCall) {
          routerModelErrors.push({ model: candidateModel, status: 503, message: netMsg });
          addSystemLog({
            level: 'warn',
            category: 'network',
            keyName: activeKeyObj?.name,
            provider: routerProvider || 'openrouter',
            model: candidateModel,
            message: `${routerProvider} network error on ${candidateModel}: ${netMsg.slice(0, 120)}`,
          });
          if (modelIdx < roundModelChain.length - 1) continue;
          break;
        }
        throw fetchNetworkError;
      }

      if (res && !res.ok) {
        const errorJson = await res.json().catch(() => null);
        const msg =
          (typeof errorJson?.error === 'string' ? errorJson.error : errorJson?.error?.message) ||
          errorJson?.message ||
          `API error ${res.status}: ${res.statusText}`;

        // Invalid/expired API key cannot succeed on fallback models
        if (res.status === 401 || (res.status === 403 && routerProvider === 'huggingface') || /User not found|Invalid API key|Unauthorized|Invalid credentials|sufficient permissions/i.test(msg)) {
          const authErr = new Error(msg);
          (authErr as any).status = res.status === 403 ? 403 : 401;
          throw authErr;
        }

        // Account credits depleted (402) affects the key across all models — for Hugging Face, allow 1 lightweight fallback in case only the heavy partner model hit 402
        if (res.status === 402 || /insufficient balance|exceeded.*monthly.*credits/i.test(msg)) {
          if (routerProvider === 'huggingface' && hfPayment402Count === 0 && modelIdx < roundModelChain.length - 1) {
            hfPayment402Count++;
            routerModelErrors.push({ model: candidateModel, status: 402, message: msg });
            sendEvent({
              type: 'action',
              action: `⚡ HF ${candidateModel} returned 402 — trying lighter model (${roundModelChain[modelIdx + 1]})...`,
            });
            continue;
          }
          const formattedMsg =
            routerProvider === 'huggingface'
              ? `Hugging Face Router (402): HF ফ্রি অ্যাকাউন্টে $0 ফ্রি চ্যাট ক্রেডিট না থাকায় সব মডেলে 402 আসছে (${msg}) — একদম ফ্রিতে চালাতে OpenRouter (:free), Groq বা Cerebras ব্যবহার করুন।`
              : msg;
          const creditErr = new Error(formattedMsg);
          (creditErr as any).status = 402;
          throw creditErr;
        }

        const isToolsUnsupported =
          toolsEnabled &&
          (res.status === 400 || res.status === 422 || res.status === 404) &&
          (msg.toLowerCase().includes('tool') ||
            msg.toLowerCase().includes('function') ||
            msg.toLowerCase().includes('support') ||
            msg.toLowerCase().includes('schema'));

        const slugMatch = msg.match(/use this slug instead:\s*([a-zA-Z0-9_\-\/:]+)/i);
        const isModelUnavailable =
          msg.includes("unavailable for free") ||
          msg.includes("not available") ||
          msg.includes("No endpoints found") ||
          msg.includes("not found") ||
          msg.includes("not a valid model ID") ||
          msg.includes("not a valid model");

        const isVisionUnsupported =
          lastMessageImages.length > 0 &&
          (res.status === 400 || res.status === 422) &&
          /(image|vision|multimodal|media|content.*array|expected.*string|does not support image)/i.test(msg);

        const isPayloadOrTpmTooLarge =
          toolsEnabled &&
          !usingCompactTools &&
          (res.status === 413 ||
            /request too large|payload too large|too many tools|context_length|maximum context|tokens.*limit|TPM|rate_limit_exceeded/i.test(msg));

        if (isPayloadOrTpmTooLarge) {
          usingCompactTools = true;
          const retryPhase: ToolExecutionPhase =
            selfHealRounds > 0
              ? 'verify'
              : didMutateFiles || Boolean(sharedProgress?.executedTools?.includes('workspace_init'))
                ? 'build'
                : isFreshGreenfield
                  ? 'greenfield'
                  : 'inspect';
          openAiTools = selectPhaseOpenAITools(serverTools, rawUserPrompt, mode, retryPhase, true, false);
          sendEvent({
            type: "action",
            action: `⚡ ${candidateModel} TPM/payload limit — auto-compacting to ${openAiTools.length} phase-focused tools...`,
          });
          res = await sendRequest(candidateModel, true).catch(() => null);
        } else if (isVisionUnsupported) {
          for (let i = 1; i < openAiMessages.length; i++) {
            if (Array.isArray(openAiMessages[i].content)) {
              const textPart = openAiMessages[i].content.find((p: any) => p.type === 'text')?.text || '';
              openAiMessages[i] = {
                role: openAiMessages[i].role,
                content: `${textPart}\n[Note: User attached ${lastMessageImages.length} image(s), but the current free model (${candidateModel}) does not accept image inputs.]`,
              };
            }
          }
          compactedMessages = compactOpenAIMessages(openAiMessages, sharedProgress?.mutatedFiles);
          sendEvent({
            type: "action",
            action: `🖼️ ${candidateModel} ভিশন সাপোর্ট করে না — টেক্সট-মোডে ফলোব্যাক করা হচ্ছে...`,
          });
          res = await sendRequest(candidateModel, toolsEnabled, compactedMessages).catch(() => null);
        } else if (isToolsUnsupported) {
          toolsEnabled = false;
          openAiMessages[0] = {
            role: 'system',
            content: openAiMessages[0].content + `\n\n[FALLBACK TOOL EXECUTION PROTOCOL]:
Native function calling is unavailable on this model. Whenever you need to call a tool (e.g. view_file, write_to_file, replace_file_content, compile_applet, lint_applet, omo_coordinate, set_up_firebase), output ONLY:
<tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call>
The server will execute it immediately and send back the result so you can continue.`
          };
          compactedMessages = compactOpenAIMessages(openAiMessages, sharedProgress?.mutatedFiles);
          sendEvent({
            type: "action",
            action: `⚡ ${candidateModel} switched to structured <tool_call> execution protocol...`
          });
          res = await sendRequest(candidateModel, false, compactedMessages).catch(() => null);
        } else if (!isRouterChainCall && slugMatch && slugMatch[1] && slugMatch[1] !== targetModel) {
          if (activeKeyObj) markModelOutage(activeKeyObj.provider, targetModel, 600);
          targetModel = slugMatch[1];
          sendEvent({
            type: "action",
            action: `Switching to available model: ${targetModel}...`
          });
          res = await sendRequest(targetModel, toolsEnabled).catch(() => null);
        } else if (
          !isRouterChainCall &&
          !/free-models-per-day/i.test(msg) &&
          res.status !== 401 &&
          res.status !== 429 &&
          (isModelUnavailable || /provider returned error|decommissioned|not supported/i.test(msg) || [404, 502, 503].includes(res.status))
        ) {
          const providerName = activeKeyObj?.provider || 'custom';
          markModelOutage(providerName, targetModel, 600);
          const fallbackCandidates = getProviderModelChain(providerName, null).filter(m => m !== targetModel);
          if (fallbackCandidates.length > 0) {
            targetModel = fallbackCandidates[0];
            sendEvent({
              type: "action",
              action: `⚡ Model error on ${providerName}. Circuit-breaking dead model and switching to ${targetModel}...`
            });
            res = await sendRequest(targetModel, toolsEnabled).catch(() => null);
          }
        }

        // If still !res.ok after per-model adjustments
        throwIfAborted(signal);
        if (!res || !res.ok) {
          const retryErrorJson = res ? await res.json().catch(() => null) : null;
          const finalErrMsg =
            (typeof retryErrorJson?.error === 'string' ? retryErrorJson.error : retryErrorJson?.error?.message) ||
            retryErrorJson?.message ||
            msg;
          const finalStatus = res?.status || 503;

          if (finalStatus === 401 || (finalStatus === 403 && routerProvider === 'huggingface') || /User not found|Invalid API key|Unauthorized|Invalid credentials|sufficient permissions/i.test(finalErrMsg)) {
            const authErr = new Error(finalErrMsg);
            (authErr as any).status = finalStatus === 403 ? 403 : 401;
            throw authErr;
          }

          if (finalStatus === 402 || /insufficient balance|exceeded.*monthly.*credits/i.test(finalErrMsg)) {
            if (routerProvider === 'huggingface' && hfPayment402Count === 0 && modelIdx < roundModelChain.length - 1) {
              hfPayment402Count++;
              routerModelErrors.push({ model: candidateModel, status: 402, message: finalErrMsg });
              continue;
            }
            const formattedMsg =
              routerProvider === 'huggingface'
                ? `Hugging Face Router (402): HF ফ্রি অ্যাকাউন্টে $0 ফ্রি চ্যাট ক্রেডিট না থাকায় সব মডেলে 402 আসছে (${finalErrMsg}) — একদম ফ্রিতে চালাতে OpenRouter (:free), Groq বা Cerebras ব্যবহার করুন।`
                : finalErrMsg;
            const creditErr = new Error(formattedMsg);
            (creditErr as any).status = 402;
            throw creditErr;
          }

          if (isRouterChainCall) {
            routerModelErrors.push({ model: candidateModel, status: finalStatus, message: finalErrMsg });
            if (activeKeyObj && [400, 404, 502, 503].includes(finalStatus)) {
              markModelOutage(routerProvider || activeKeyObj.provider, candidateModel, 300);
            }
            addSystemLog({
              level: 'warn',
              category: finalStatus === 429 ? 'rate_limit' : 'rotation',
              keyName: activeKeyObj?.name,
              provider: routerProvider || 'openrouter',
              model: candidateModel,
              message: `${routerProvider} model failed (${finalStatus}): ${candidateModel} — ${finalErrMsg.slice(0, 120)}`,
            });
            if (modelIdx < roundModelChain.length - 1) {
              continue;
            }
            break;
          }

          // Non-Router inline hot-swap on mid-loop 429/502/503
          if (res && (res.status === 429 || res.status === 502 || res.status === 503) && inlineHotSwaps < 12 && poolKeys.length > 1 && activeKeyObj) {
            const swapCooldown = /free-models-per-day/i.test(finalErrMsg) ? 1800 : res.status === 429 ? 60 : 15;
            recordKeyCooldown(activeKeyObj.id, swapCooldown, finalErrMsg);

            const eligibleSwapKeys = poolKeys.filter(k =>
              k.isActive &&
              k.id !== activeKeyObj!.id &&
              ['openrouter', 'huggingface', 'deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(k.provider) &&
              getOrCreateStats(k.id).cooldownUntil <= Date.now()
            );
            const { key: swapKey } = selectBestKey(eligibleSwapKeys, 'all', new Set(), null, { loadBalance: true });
            if (swapKey) {
              inlineHotSwaps++;
              const prevProvider = activeKeyObj.provider;
              activeKeyObj = swapKey;
              activeApiKey = swapKey.apiKey;
              activeEndpoint = getOpenAICompatibleEndpoint(swapKey.provider, swapKey.baseUrl);
              activeHeaders = swapKey.provider === 'openrouter'
                ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
                : {};
              activePreferredModel = normalizeModelName(swapKey.provider, swapKey.model);
              const chain = getProviderModelChain(swapKey.provider, activePreferredModel);
              targetModel = chain[0] || activePreferredModel;
              if (swapKey.provider !== prevProvider) {
                const normalized = normalizeCrossProviderMessages(openAiMessages);
                openAiMessages.length = 0;
                openAiMessages.push(...normalized);
                compactedMessages = compactOpenAIMessages(openAiMessages, sharedProgress?.mutatedFiles);
              }
              sendEvent({
                type: "key_active",
                keyId: swapKey.id,
                keyName: swapKey.name,
                provider: swapKey.provider,
                model: targetModel,
                isCustomKey: true
              });
              sendEvent({
                type: "action",
                action: `⚡ Mid-loop hot-swap -> ${swapKey.name} (${swapKey.provider.toUpperCase()} • ${targetModel}) without losing progress!`
              });
              res = await fetch(activeEndpoint, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${activeApiKey}`,
                  'Content-Type': 'application/json',
                  ...activeHeaders
                },
                body: buildPayload(targetModel, toolsEnabled, compactedMessages),
                ...(signal ? { signal } : {}),
              });
            }
          }

          if (!res || !res.ok) {
            throwIfAborted(signal);
            const secondError = res ? await res.json().catch(() => null) : null;
            const errText = secondError?.error?.message || finalErrMsg;
            const err = new Error(errText);
            (err as any).status = res?.status || 503;
            throw err;
          }
        }
      }

      throwIfAborted(signal);
      if (!res) {
        if (isRouterChainCall) {
          routerModelErrors.push({ model: candidateModel, status: 503, message: 'No HTTP response received' });
          if (modelIdx < roundModelChain.length - 1) continue;
          break;
        }
        throw new Error('No HTTP response received');
      }

      const reader = res.body?.getReader();
      if (!reader) {
        if (isRouterChainCall) {
          routerModelErrors.push({ model: candidateModel, status: 502, message: 'No response stream available' });
          if (modelIdx < roundModelChain.length - 1) continue;
          break;
        }
        throw new Error("No response stream available");
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let streamError: { message: string; status: number } | null = null;
      const cancelReaderOnAbort = () => {
        reader.cancel().catch(() => {});
      };
      signal?.addEventListener('abort', cancelReaderOnAbort, { once: true });

      try {
      while (true) {
        throwIfAborted(signal);
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed === 'data: [DONE]') continue;
          if (trimmed.startsWith('data: ')) {
            let json: any = null;
            try {
              json = JSON.parse(trimmed.slice(6));
            } catch {
              continue;
            }

            if (json?.error) {
              streamError = {
                message: json.error.message || json.error?.metadata?.raw || 'Provider returned error',
                status: Number(json.error.code || 502),
              };
              break;
            }

            const choiceDelta = json.choices?.[0]?.delta;
            if (!choiceDelta) continue;

            if (typeof choiceDelta.reasoning_content === 'string' && choiceDelta.reasoning_content.length > 0) {
              roundReasoning += choiceDelta.reasoning_content;
              if (!emittedReasoningStep) {
                emittedReasoningStep = true;
                sendEvent({
                  type: 'action',
                  action: `🧠 ${candidateModel} যুক্তি বিশ্লেষণ করছে (Reasoning)...`,
                });
              }
            }

            if (typeof choiceDelta.content === 'string' && choiceDelta.content.length > 0) {
              roundText += choiceDelta.content;
              const previewText = (committedText ? committedText + '\n\n' : '') + getSafeStreamableText(roundText);
              if (previewText.trim()) {
                sendEvent({ type: 'text', text: previewText });
              }
            }

            if (Array.isArray(choiceDelta.tool_calls)) {
              for (const tc of choiceDelta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                const existing = toolCallsMap.get(idx) || {
                  id: tc.id || `call_${round}_${idx}_${Date.now()}`,
                  type: 'function' as const,
                  function: { name: '', arguments: '' },
                };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.function.name += tc.function.name;
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
                toolCallsMap.set(idx, existing);
              }
            }
          }
        }
        if (streamError) break;
      }
      } finally {
        signal?.removeEventListener('abort', cancelReaderOnAbort);
      }
      throwIfAborted(signal);

      if (streamError) {
        if (streamError.status === 401 || /User not found|Invalid API key|Unauthorized/i.test(streamError.message)) {
          const authErr = new Error(streamError.message);
          (authErr as any).status = 401;
          throw authErr;
        }
        if (isRouterChainCall) {
          routerModelErrors.push({
            model: candidateModel,
            status: streamError.status,
            message: streamError.message,
          });
          addSystemLog({
            level: 'warn',
            category: streamError.status === 429 ? 'rate_limit' : 'rotation',
            keyName: activeKeyObj?.name,
            provider: routerProvider || 'openrouter',
            model: candidateModel,
            message: `${routerProvider} stream error on ${candidateModel} (${streamError.status}): ${streamError.message.slice(0, 120)}`,
          });
          if (toolCallsMap.size === 0 && modelIdx < roundModelChain.length - 1) {
            continue;
          }
          break;
        }
        const err = new Error(streamError.message);
        (err as any).status = streamError.status;
        throw err;
      }

      if (isRouterChainCall && roundText.trim() === '' && toolCallsMap.size === 0) {
        routerModelErrors.push({
          model: candidateModel,
          status: 502,
          message: 'Empty response stream from model',
        });
        addSystemLog({
          level: 'warn',
          category: 'rotation',
          keyName: activeKeyObj?.name,
          provider: routerProvider || 'openrouter',
          model: candidateModel,
          message: `${routerProvider} model ${candidateModel} returned an empty response — trying next fallback model.`,
        });
        if (modelIdx < roundModelChain.length - 1) {
          continue;
        }
        break;
      }

      roundSucceeded = true;
      if (sharedProgress) {
        sharedProgress.activeModel = candidateModel;
      }
      break;
    }
    } finally {
      releaseKeyInFlight(roundLockKeyId);
    }

    if (!roundSucceeded) {
      // If all router models failed, check if there is another key in poolKeys for hot-swap
      const lastModelErr = routerModelErrors[routerModelErrors.length - 1];
      if (isRouterChainCall && inlineHotSwaps < 12 && poolKeys.length > 1 && activeKeyObj) {
        const swapCooldown = /free-models-per-day/i.test(lastModelErr?.message || '')
          ? 1800
          : lastModelErr?.status === 429
            ? 60
            : 15;
        recordKeyCooldown(activeKeyObj.id, swapCooldown, lastModelErr?.message || `All ${routerProvider} fallback models failed`);
        const eligibleSwapKeys = poolKeys.filter(k =>
          k.isActive &&
          k.id !== activeKeyObj!.id &&
          ['openrouter', 'huggingface', 'deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(k.provider) &&
          getOrCreateStats(k.id).cooldownUntil <= Date.now()
        );
        const { key: swapKey } = selectBestKey(eligibleSwapKeys, 'all', new Set(), null, { loadBalance: true });
        if (swapKey) {
          inlineHotSwaps++;
          const prevProvider = activeKeyObj.provider;
          activeKeyObj = swapKey;
          activeApiKey = swapKey.apiKey;
          activeEndpoint = getOpenAICompatibleEndpoint(swapKey.provider, swapKey.baseUrl);
          activeHeaders = swapKey.provider === 'openrouter'
            ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
            : {};
          activePreferredModel = normalizeModelName(swapKey.provider, swapKey.model);
          const chain = getProviderModelChain(swapKey.provider, activePreferredModel);
          targetModel = chain[0] || activePreferredModel;
          if (swapKey.provider !== prevProvider) {
            const normalized = normalizeCrossProviderMessages(openAiMessages);
            openAiMessages.length = 0;
            openAiMessages.push(...normalized);
          }
          sendEvent({
            type: 'key_active',
            keyId: swapKey.id,
            keyName: swapKey.name,
            provider: swapKey.provider,
            model: targetModel,
            isCustomKey: true,
          });
          sendEvent({
            type: 'action',
            action: `⚡ All ${routerProvider} models failed on previous key — hot-swapping to ${swapKey.name} (${swapKey.provider.toUpperCase()} • ${targetModel})...`,
          });
          continue;
        }
      }

      const summary = routerModelErrors
        .map((e) => `${e.model} [${e.status || 'ERR'}]`)
        .join(' → ');
      const routerLabel =
        routerProvider === 'huggingface'
          ? 'Hugging Face Router'
          : routerProvider === 'deepseek'
            ? 'DeepSeek API'
            : 'OpenRouter';
      const finalErr = new Error(
        `${routerLabel}-এর সবকটি ফলব্যাক মডেল (${summary || roundModelChain.join(' → ')}) ফেইল বা রেট-লিমিট হয়েছে: ${lastModelErr?.message || 'Unknown error'}`
      );
      (finalErr as any).status = lastModelErr?.status || 502;
      if (routerProvider === 'openrouter') {
        (finalErr as any).allOpenRouterModelsFailed = true;
      }
      throw finalErr;
    }

    const nativeCalls = Array.from(toolCallsMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((c) => Boolean(c.function.name));

    // Also detect and strip text-embedded tool calls (e.g. ```json {"tool_calls": [...]} ``` or <tool_call>...</tool_call>)
    const { calls: textParsedCalls, cleanedText: cleanRoundText } = extractAndStripTextToolCalls(roundText);

    if (cleanRoundText) {
      committedText = committedText ? `${committedText}\n\n${cleanRoundText}` : cleanRoundText;
    }
    sendEvent({ type: 'text', text: committedText });

    if (nativeCalls.length > 0) {
      throwIfAborted(signal);
      calledAnyTool = true;
      openAiMessages.push({
        role: 'assistant',
        content: roundText || null,
        ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
        tool_calls: nativeCalls,
      });

      const toolMessagePayloads = await Promise.all(
        nativeCalls.map(async (tc) => {
          throwIfAborted(signal);
          let parsedArgs: any = {};
          try {
            parsedArgs = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          } catch {
            parsedArgs = {};
          }
          sharedProgress?.executedTools.push(tc.function.name);
          if (FILE_WRITE_TOOL_NAMES.has(tc.function.name)) {
            didMutateFiles = true;
            const tf = parsedArgs?.TargetFile || parsedArgs?.filePath;
            if (tf) sharedProgress?.mutatedFiles.add(String(tf));
          }
          const toolResult = await executeToolWithLiveEvents(tc.function.name, parsedArgs, sendEvent, effectiveExecCtx);
          if ((tc.function.name === 'github_clone' || toolResult?.clonedWorkspace) && toolResult?.success && toolResult?.workspacePath) {
            didMutateFiles = true;
            if (tc.function.name !== 'github_clone') sharedProgress?.executedTools.push('github_clone');
            sharedProgress?.mutatedFiles.add(`${toolResult.workspacePath}/.nexus_cloned`);
          }
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(toolResult),
          };
        })
      );
      openAiMessages.push(...toolMessagePayloads);
      if (sharedProgress) sharedProgress.committedText = committedText;
      continue;
    }

    if (textParsedCalls.length > 0) {
      calledAnyTool = true;
      openAiMessages.push({
        role: 'assistant',
        content: roundText,
      });
      const resultSummaries: any[] = [];
      for (const tc of textParsedCalls) {
        throwIfAborted(signal);
        sharedProgress?.executedTools.push(tc.name);
        if (FILE_WRITE_TOOL_NAMES.has(tc.name)) {
          didMutateFiles = true;
          const tf = tc.args?.TargetFile || tc.args?.filePath;
          if (tf) sharedProgress?.mutatedFiles.add(String(tf));
        }
        const toolResult = await executeToolWithLiveEvents(tc.name, tc.args, sendEvent, effectiveExecCtx);
        if ((tc.name === 'github_clone' || toolResult?.clonedWorkspace) && toolResult?.success && toolResult?.workspacePath) {
          didMutateFiles = true;
          if (tc.name !== 'github_clone') sharedProgress?.executedTools.push('github_clone');
          sharedProgress?.mutatedFiles.add(`${toolResult.workspacePath}/.nexus_cloned`);
        }
        resultSummaries.push({ tool: tc.name, result: toolResult });
      }
      openAiMessages.push({
        role: 'user',
        content: `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(resultSummaries)}\n\nContinue immediately: implement all requested features directly in workspace files using write_to_file or replace_file_content (never output tool_calls JSON or full code in chat), then verify and summarize.`,
      });
      if (sharedProgress) sharedProgress.committedText = committedText;
      continue;
    }

    // Truncated tool_call salvage for free models hitting max_tokens mid-file
    const salvaged = trySalvageTruncatedFileWrite(roundText);
    if (salvaged && continuationNudges < 2) {
      throwIfAborted(signal);
      continuationNudges++;
      calledAnyTool = true;
      didMutateFiles = true;
      sharedProgress?.executedTools.push('write_to_file(salvaged)');
      sharedProgress?.mutatedFiles.add(salvaged.TargetFile);
      await executeToolWithLiveEvents(
        'write_to_file',
        { TargetFile: salvaged.TargetFile, CodeContent: salvaged.CodeContent, Description: 'Salvaged partial output before token truncation', Overwrite: true },
        sendEvent,
        effectiveExecCtx
      );
      openAiMessages.push({ role: 'assistant', content: `Saved partial content to ${salvaged.TargetFile}.` });
      openAiMessages.push({
        role: 'user',
        content: `Your output for ${salvaged.TargetFile} was truncated at max_tokens. Call write_to_file with Append: true (or replace_file_content) to complete the remaining closing tags/features, then run verify_live_preview.`,
      });
      continue;
    }

    const shouldNudge =
      continuationNudges < 4 &&
      ((requiresImplementation && !didMutateFiles && (calledAnyTool || looksLikeUnfinishedNarration(roundText))) ||
        looksLikeUnfinishedNarration(roundText));

    if (shouldNudge) {
      throwIfAborted(signal);
      continuationNudges++;
      openAiMessages.push({
        role: 'assistant',
        content: roundText || 'Proceeding with next step.',
      });
      openAiMessages.push({
        role: 'user',
        content: toolsEnabled
          ? `Do NOT stop or narrate what tool you will call next. Immediately execute the real tool calls now (inspect target file with view_file if needed, write/update features directly in files using write_to_file or replace_file_content, and verify with compile_applet / lint_applet). Never write code or tool_calls JSON in chat.`
          : `Do NOT stop or narrate. Call the next tool immediately using <tool_call>{"name":"TOOL_NAME","arguments":{...}}</tool_call> to inspect/write the actual workspace files and add all requested features.`,
      });
      continue;
    }

    if (allowTools && didMutateFiles && selfHealRounds < 4) {
      const gate = await runMandatorySelfHealingGate(
        sharedProgress?.mutatedFiles || new Set(),
        execCtx?.sessionId,
        sendEvent,
        execCtx?.geminiApiKey,
        {
          originalPrompt: rawUserPrompt,
          poolKeys,
          activeKeyId: activeKeyObj?.id,
          fallbackInvoker: execCtx?.llmInvoker,
          sharedProgress,
          selfHealRound: selfHealRounds,
          signal,
        }
      );
      if (!gate.passed && gate.feedbackPrompt) {
        selfHealRounds++;
        openAiMessages.push({ role: 'assistant', content: roundText || 'Changes applied.' });
        openAiMessages.push({ role: 'user', content: gate.feedbackPrompt });
        continue;
      }
    } else if (allowTools && didMutateFiles && sharedProgress?.lastGateFailure && sharedProgress?.preEditCheckpointId) {
      sendEvent({
        type: 'action',
        action: `⚠️ Auto-Rollback safety checkpoint available (${sharedProgress.preEditCheckpointId}) — use git_rollback if needed.`,
      });
    }

    break;
  }

  return committedText;
}

interface GeminiBuiltInToolSelection {
  builtInTools: any[];
  labels: string[];
  needsIncludeServerSideInvocations: boolean;
}

function selectGeminiBuiltInTools(
  targetModel: string,
  rawUserPrompt: string,
  mode: string,
  allowTools: boolean,
  hasFunctionDeclarations: boolean,
  isVertexExpress: boolean
): GeminiBuiltInToolSelection {
  if (!allowTools || isVertexExpress) {
    return { builtInTools: [], labels: [], needsIncludeServerSideInvocations: false };
  }

  // Hybrid built-in + custom tool combination is supported on Gemini 3 & Gemini 4 models (non-image/tts/live)
  const isGemini3Or4 =
    /gemini-4-|gemini-3\./i.test(targetModel) &&
    !/image|tts|live|transcribe/i.test(targetModel);
  if (!isGemini3Or4) {
    return { builtInTools: [], labels: [], needsIncludeServerSideInvocations: false };
  }

  const prompt = rawUserPrompt || '';
  const lower = prompt.toLowerCase();
  const hasUrl = /https?:\/\/[^\s]+/i.test(prompt);
  const hasSearchIntent =
    mode === 'search' ||
    /(search|google|latest|current|news|weather|price|docs|documentation|find online|research|up[- ]to[- ]date|সার্চ|খুঁজ|সাম্প্রতিক|বর্তমান|আজকের|আবহাওয়া|আবহাওয়া|ডকুমেন্টেশন|দাম)/i.test(lower);
  const hasUrlIntent =
    hasUrl ||
    mode === 'search' ||
    /(url|webpage|fetch|read.*page|clone.*site|reference.*site|ওয়েবপেজ|ওয়েবপেজ|লিংক)/i.test(lower);
  const hasPureComputationIntent =
    /(calculate|math|equation|solve|compute|statistics|probability|অঙ্ক|হিসাব|সমীকরণ)/i.test(lower) &&
    !isActionOrBuildPrompt(prompt);

  const builtInTools: any[] = [];
  const labels: string[] = [];

  if (hasSearchIntent) {
    builtInTools.push({ googleSearch: {} });
    labels.push('Google Search');
  }
  if (hasUrlIntent) {
    builtInTools.push({ urlContext: {} });
    labels.push('URL Context');
  }
  if (hasPureComputationIntent) {
    builtInTools.push({ codeExecution: {} });
    labels.push('Code Execution');
  }

  return {
    builtInTools,
    labels,
    needsIncludeServerSideInvocations: builtInTools.length > 0 && hasFunctionDeclarations,
  };
}

async function runGeminiAgentLoop(
  client: GoogleGenAI,
  targetModel: string,
  mode: string,
  systemOptions: SystemInstructionOptions,
  history: any[],
  lastMessage: string,
  rawUserPrompt: string,
  sendEvent: (data: any) => void,
  execCtx: ToolExecutionContext,
  trackedKey?: KeyConfig,
  allowTools: boolean = true,
  lastMessageImages: InlineImageAttachment[] = [],
  sharedProgress?: SharedExecutionProgress,
  poolKeys: KeyConfig[] = [],
  isVertexExpress: boolean = false
): Promise<string> {
  const isFreeCustomKey = Boolean(trackedKey && trackedKey.id !== 'studio_primary_key');
  const isFreshGreenfield = await isFreshGreenfieldWebsiteBuild(rawUserPrompt, execCtx?.sessionId);
  const enableMultiAgentOmo = Boolean(systemOptions.multiAgent) && isActionOrBuildPrompt(rawUserPrompt);
  const relevantTools = allowTools
    ? selectRelevantTools(serverTools, rawUserPrompt, mode, false, isFreshGreenfield, enableMultiAgentOmo)
    : [];

  const getThinkingConfigForModel = (gModel: string) => {
    const supportsThinkingLevel =
      /gemini-4-|gemini-3\.8-flash|gemini-3\.1-pro/i.test(gModel) &&
      !/flash-lite|image|tts/i.test(gModel);
    if (!supportsThinkingLevel) return undefined;
    const needsDeepThinking = /(debug|error|architect|plan|refactor|fix|database|migration|এরর|ঠিক|প্ল্যান)/i.test(rawUserPrompt);
    return { thinkingLevel: needsDeepThinking ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW };
  };

  let activeClient = client;
  let activeModel = targetModel;
  let activeTrackedKey = trackedKey;
  let enableBuiltInTools = !isVertexExpress;
  const sysInstruction = getNexusSystemInstruction(mode, { ...systemOptions, compactForFreeApi: isFreeCustomKey });

  const createGeminiChatSession = (
    gClient: GoogleGenAI,
    gModel: string,
    hist: any[],
    useBuiltIn: boolean = enableBuiltInTools
  ) => {
    const hasFnDecls = allowTools && relevantTools.length > 0;
    const builtInSelection = useBuiltIn
      ? selectGeminiBuiltInTools(gModel, rawUserPrompt, mode, allowTools, hasFnDecls, isVertexExpress)
      : { builtInTools: [], labels: [], needsIncludeServerSideInvocations: false };

    const combinedTools: any[] = [];
    if (hasFnDecls) {
      combinedTools.push({ functionDeclarations: relevantTools });
    }
    for (const bt of builtInSelection.builtInTools) {
      combinedTools.push(bt);
    }

    const tConfig = getThinkingConfigForModel(gModel);
    const session = gClient.chats.create({
      model: gModel,
      config: {
        systemInstruction: sysInstruction,
        ...(combinedTools.length > 0 ? { tools: combinedTools } : {}),
        ...(builtInSelection.needsIncludeServerSideInvocations
          ? { toolConfig: { includeServerSideToolInvocations: true } }
          : {}),
        ...(tConfig ? { thinkingConfig: tConfig } : {}),
      },
      history: hist,
    });
    return { session, builtInSelection };
  };

  const initialCreated = createGeminiChatSession(activeClient, activeModel, history, enableBuiltInTools);
  let chat = initialCreated.session;
  let activeBuiltInLabels = initialCreated.builtInSelection.labels;
  if (activeBuiltInLabels.length > 0) {
    sendEvent({
      type: 'action',
      action: `🔌 Gemini Hybrid Tools active: [${activeBuiltInLabels.join(' + ')}]${initialCreated.builtInSelection.needsIncludeServerSideInvocations ? ' + Nexus Custom Tools' : ''}`,
    });
  }

  // Attach multimodal vision parts if the user uploaded a screenshot/design image
  let nextPayload: any =
    lastMessageImages.length > 0
      ? [
          { text: lastMessage },
          ...lastMessageImages.map((img) => ({
            inlineData: { mimeType: img.mimeType, data: img.data },
          })),
        ]
      : lastMessage;

  let committedText = sharedProgress?.committedText || '';
  let didMutateFiles = (sharedProgress?.mutatedFiles.size || 0) > 0;
  let calledAnyTool = (sharedProgress?.executedTools.length || 0) > 0;
  let continuationNudges = 0;
  let selfHealRounds = 0;
  let inlineGeminiSwaps = 0;
  const requiresImplementation = isActionOrBuildPrompt(rawUserPrompt);
  const poolHealthyCount = Number((execCtx as any)?.poolHealthyCount || 1);
  const maxRounds = allowTools ? 60 : 1;
  const signal = execCtx?.signal;

  const compactGeminiHistory = (rawHist: any[]): any[] => {
    if (!Array.isArray(rawHist) || rawHist.length <= 6) return rawHist;
    const tailStart = rawHist.length - 4;
    return rawHist.map((entry, idx) => {
      if (idx >= tailStart || !Array.isArray(entry?.parts)) return entry;
      const compactedParts = entry.parts.map((part: any) => {
        if (part?.functionCall?.args && typeof part.functionCall.args.CodeContent === 'string' && part.functionCall.args.CodeContent.length > 150) {
          const tf = part.functionCall.args.TargetFile || 'file';
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              args: {
                ...part.functionCall.args,
                CodeContent: `[Written to ${tf} — compacted]`,
              },
            },
          };
        }
        if (part?.functionResponse?.response?.output && typeof part.functionResponse.response.output === 'object') {
          const serialized = JSON.stringify(part.functionResponse.response.output);
          if (serialized.length > 280) {
            return {
              ...part,
              functionResponse: {
                ...part.functionResponse,
                response: { output: { compacted: true, summary: serialized.slice(0, 160) } },
              },
            };
          }
        }
        return part;
      });
      return { ...entry, parts: compactedParts };
    });
  };

  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted(signal);
    const geminiDesiredTier: Exclude<KeyRoleTier, 'auto'> =
      (round === 0 && requiresImplementation) || selfHealRounds > 0 ? 'architect' : 'builder';
    let rotatedThisRound = false;

    // Per-round Gemini key load balancing across healthy Gemini keys
    if (round > 0 && activeTrackedKey && poolKeys.length > 1) {
      const otherGeminiKeys = poolKeys.filter(k =>
        k.isActive &&
        k.provider === 'gemini' &&
        k.id !== activeTrackedKey!.id &&
        getOrCreateStats(k.id).cooldownUntil <= Date.now()
      );
      if (otherGeminiKeys.length > 0) {
        const { key: nextGKey } = selectBestKey(otherGeminiKeys, 'gemini', new Set(), null, {
          loadBalance: true,
          desiredTier: geminiDesiredTier,
          estimatedTokens: 2000,
        });
        if (nextGKey) {
          const currStats = getOrCreateStats(activeTrackedKey.id);
          const nextStats = getOrCreateStats(nextGKey.id);
          const currCaps = getKeyEffectiveCaps(activeTrackedKey);
          if (
            otherGeminiKeys.length >= 3 ||
            nextStats.timestamps.length < currStats.timestamps.length ||
            (currStats.timestamps.length + currStats.inFlightCount) >= Math.max(3, Math.floor(currCaps.safeRpmCap * 0.5))
          ) {
            try {
              let rawHist: any[] = history;
              try {
                const h = chat.getHistory();
                if (Array.isArray(h) && h.length > 0) rawHist = h;
              } catch {}
              const savedHist = compactGeminiHistory(rawHist);
              const cleanNextKey = nextGKey.apiKey.trim().replace(/^["']|["']$/g, '');
              const nextClient = new GoogleGenAI({
                apiKey: cleanNextKey,
                httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
              });
              const nextM = getProviderModelChain('gemini', normalizeModelName('gemini', nextGKey.model))[0] || activeModel;
              const swapped = createGeminiChatSession(nextClient, nextM, savedHist, enableBuiltInTools);
              chat = swapped.session;
              activeBuiltInLabels = swapped.builtInSelection.labels;
              activeClient = nextClient;
              activeModel = nextM;
              activeTrackedKey = nextGKey;
              execCtx.geminiApiKey = cleanNextKey;
              execCtx.geminiModel = nextM;
              rotatedThisRound = true;
              sendEvent({
                type: 'key_active',
                keyId: nextGKey.id,
                keyName: nextGKey.name,
                provider: 'gemini',
                model: nextM,
                isCustomKey: nextGKey.id !== 'studio_primary_key',
              });
            } catch {}
          }
        }
      }
    }

    // Same-key rolling compaction on Gemini: strips bulky older file writes/reads even without key rotation (cuts 40-60% TPM)
    if (round >= 2 && !rotatedThisRound) {
      try {
        const curHist = chat.getHistory();
        if (Array.isArray(curHist) && curHist.length > 8 && estimateTokensFromPayload(curHist) > 7000) {
          const compactedSameKey = compactGeminiHistory(curHist);
          const refreshed = createGeminiChatSession(activeClient, activeModel, compactedSameKey, enableBuiltInTools);
          chat = refreshed.session;
          activeBuiltInLabels = refreshed.builtInSelection.labels;
        }
      } catch {}
    }

    await paceAndTrackKeyRound(activeTrackedKey, round, sendEvent, estimateTokensFromPayload(nextPayload), poolHealthyCount, signal);

    let currentResult: any;
    let roundText = '';
    const functionCalls: any[] = [];
    const groundingUrls = new Map<string, string>();
    const urlContextUrls = new Set<string>();
    let executedServerCode = false;
    let gLockKeyId = activeTrackedKey?.id;
    acquireKeyInFlight(gLockKeyId);
    let streamIter: AsyncIterator<any> | null = null;
    try {
    try {
      throwIfAborted(signal);
      currentResult = await raceWithAbort(chat.sendMessageStream({ message: nextPayload }), signal);
    } catch (streamInitErr: any) {
      if (isAbortOrCancelError(streamInitErr, signal)) {
        throw new JobCancelledError();
      }
      const errMsg = String(streamInitErr?.message || streamInitErr || '');
      const isRetryableRateOrBusy =
        streamInitErr?.status === 429 ||
        streamInitErr?.status === 503 ||
        /429|503|quota|rate limit|resource_exhausted|UNAVAILABLE|high demand/i.test(errMsg);

      if (isRetryableRateOrBusy && inlineGeminiSwaps < 10 && poolKeys.length > 1 && activeTrackedKey) {
        recordKeyCooldown(activeTrackedKey.id, streamInitErr?.status === 503 ? 15 : 60, errMsg);
        const backupGeminiKeys = poolKeys.filter(k =>
          k.isActive &&
          k.provider === 'gemini' &&
          k.id !== activeTrackedKey!.id &&
          getOrCreateStats(k.id).cooldownUntil <= Date.now()
        );
        const { key: swapGKey } = selectBestKey(backupGeminiKeys, 'gemini', new Set(), null, { loadBalance: true });
        if (swapGKey) {
          inlineGeminiSwaps++;
          let rawSwapHist: any[] = history;
          try {
            const h = chat.getHistory();
            if (Array.isArray(h) && h.length > 0) rawSwapHist = h;
          } catch {}
          const savedHist = compactGeminiHistory(rawSwapHist);
          const cleanSwapKey = swapGKey.apiKey.trim().replace(/^["']|["']$/g, '');
          activeClient = new GoogleGenAI({
            apiKey: cleanSwapKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
          });
          activeModel = getProviderModelChain('gemini', normalizeModelName('gemini', swapGKey.model))[0] || activeModel;
          releaseKeyInFlight(gLockKeyId);
          activeTrackedKey = swapGKey;
          gLockKeyId = swapGKey.id;
          acquireKeyInFlight(gLockKeyId);
          execCtx.geminiApiKey = cleanSwapKey;
          execCtx.geminiModel = activeModel;
          const swappedErrSession = createGeminiChatSession(activeClient, activeModel, savedHist, enableBuiltInTools);
          chat = swappedErrSession.session;
          activeBuiltInLabels = swappedErrSession.builtInSelection.labels;
          sendEvent({
            type: 'key_active',
            keyId: swapGKey.id,
            keyName: swapGKey.name,
            provider: 'gemini',
            model: activeModel,
            isCustomKey: swapGKey.id !== 'studio_primary_key',
          });
          sendEvent({
            type: 'action',
            action: `⚡ Mid-loop Gemini hot-swap -> ${swapGKey.name} (${activeModel}) without losing progress!`,
          });
          currentResult = await raceWithAbort(chat.sendMessageStream({ message: nextPayload }), signal);
        } else {
          throw streamInitErr;
        }
      } else if (
        enableBuiltInTools &&
        activeBuiltInLabels.length > 0 &&
        (streamInitErr?.status === 400 ||
          /400|INVALID_ARGUMENT|includeServerSideToolInvocations|urlContext|googleSearch|codeExecution|tool.*not.*support|cannot be used together|Function calling with/i.test(errMsg))
      ) {
        enableBuiltInTools = false;
        let rawFallbackHist: any[] = history;
        try {
          const h = chat.getHistory();
          if (Array.isArray(h) && h.length > 0) rawFallbackHist = h;
        } catch {}
        const rebuilt = createGeminiChatSession(activeClient, activeModel, compactGeminiHistory(rawFallbackHist), false);
        chat = rebuilt.session;
        activeBuiltInLabels = [];
        sendEvent({
          type: 'action',
          action: `⚡ ${activeModel} rejected hybrid built-in tools — gracefully falling back to Nexus custom tools.`,
        });
        currentResult = await raceWithAbort(chat.sendMessageStream({ message: nextPayload }), signal);
      } else {
        throw streamInitErr;
      }
    }

    const activeStreamIter: AsyncIterator<any> = currentResult[Symbol.asyncIterator]();
    streamIter = activeStreamIter;
    while (true) {
      throwIfAborted(signal);
      const { value: chunk, done } = await raceWithAbort(activeStreamIter.next(), signal);
      if (done) break;
      if (chunk.text) {
        roundText += chunk.text;
        const previewText = (committedText ? committedText + '\n\n' : '') + getSafeStreamableText(roundText);
        if (previewText.trim()) {
          sendEvent({ type: 'text', text: previewText });
        }
      }
      if (chunk.functionCalls && chunk.functionCalls.length > 0) {
        functionCalls.push(...chunk.functionCalls);
      }
      const cand: any = (chunk as any)?.candidates?.[0];
      const gChunks = cand?.groundingMetadata?.groundingChunks;
      if (Array.isArray(gChunks)) {
        for (const ch of gChunks) {
          if (ch?.web?.uri) {
            groundingUrls.set(ch.web.uri, ch.web.title || ch.web.uri);
          }
        }
      }
      const uMeta = cand?.urlContextMetadata?.urlMetadata;
      if (Array.isArray(uMeta)) {
        for (const um of uMeta) {
          if (um?.retrievedUrl) urlContextUrls.add(String(um.retrievedUrl));
        }
      }
      const cParts = cand?.content?.parts;
      if (Array.isArray(cParts)) {
        for (const p of cParts) {
          if (p?.executableCode || p?.codeExecutionResult) {
            executedServerCode = true;
          }
        }
      }
    }
    } finally {
      if (signal?.aborted && streamIter && typeof streamIter.return === 'function') {
        streamIter.return().catch(() => {});
      }
      releaseKeyInFlight(gLockKeyId);
    }
    throwIfAborted(signal);

    if (groundingUrls.size > 0) {
      emitActionStep(
        sendEvent,
        'command',
        `Gemini Search Grounding (${groundingUrls.size} sources)`,
        Array.from(groundingUrls.values()).slice(0, 3).join(' • '),
        { status: 'done' }
      );
    }
    if (urlContextUrls.size > 0) {
      emitActionStep(
        sendEvent,
        'read',
        `Gemini URL Context (${urlContextUrls.size} URL${urlContextUrls.size > 1 ? 's' : ''})`,
        Array.from(urlContextUrls).slice(0, 3).join(', '),
        { status: 'done' }
      );
    }
    if (executedServerCode) {
      emitActionStep(
        sendEvent,
        'command',
        'Gemini Code Execution',
        'Executed server-side Python computation',
        { status: 'done' }
      );
    }

    const { calls: textParsedCalls, cleanedText: cleanRoundText } = extractAndStripTextToolCalls(roundText);
    if (cleanRoundText) {
      committedText = committedText ? `${committedText}\n\n${cleanRoundText}` : cleanRoundText;
    }
    sendEvent({ type: 'text', text: committedText });

    if (functionCalls.length > 0) {
      throwIfAborted(signal);
      calledAnyTool = true;
      const toolResponses = await Promise.all(
        functionCalls.map(async (call) => {
          throwIfAborted(signal);
          if (!call.name) return null;
          sharedProgress?.executedTools.push(call.name);
          if (FILE_WRITE_TOOL_NAMES.has(call.name)) {
            didMutateFiles = true;
            const tf = (call.args as any)?.TargetFile || (call.args as any)?.filePath;
            if (tf) sharedProgress?.mutatedFiles.add(String(tf));
          }
          const toolResult = await executeToolWithLiveEvents(call.name, call.args, sendEvent, execCtx);
          if ((call.name === 'github_clone' || toolResult?.clonedWorkspace) && toolResult?.success && toolResult?.workspacePath) {
            didMutateFiles = true;
            if (call.name !== 'github_clone') sharedProgress?.executedTools.push('github_clone');
            sharedProgress?.mutatedFiles.add(`${toolResult.workspacePath}/.nexus_cloned`);
          }
          return {
            functionResponse: {
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              response: { output: toolResult }
            }
          };
        })
      );
      throwIfAborted(signal);
      const validResponses = toolResponses.filter(Boolean);
      if (validResponses.length === 0) break;
      if (sharedProgress) sharedProgress.committedText = committedText;
      nextPayload = validResponses;
      continue;
    }

    if (textParsedCalls.length > 0) {
      throwIfAborted(signal);
      calledAnyTool = true;
      const results: any[] = [];
      for (const tc of textParsedCalls) {
        throwIfAborted(signal);
        sharedProgress?.executedTools.push(tc.name);
        if (FILE_WRITE_TOOL_NAMES.has(tc.name)) {
          didMutateFiles = true;
          const tf = tc.args?.TargetFile || tc.args?.filePath;
          if (tf) sharedProgress?.mutatedFiles.add(String(tf));
        }
        const toolResult = await executeToolWithLiveEvents(tc.name, tc.args, sendEvent, execCtx);
        if ((tc.name === 'github_clone' || toolResult?.clonedWorkspace) && toolResult?.success && toolResult?.workspacePath) {
          didMutateFiles = true;
          if (tc.name !== 'github_clone') sharedProgress?.executedTools.push('github_clone');
          sharedProgress?.mutatedFiles.add(`${toolResult.workspacePath}/.nexus_cloned`);
        }
        results.push({ tool: tc.name, result: toolResult });
      }
      throwIfAborted(signal);
      if (sharedProgress) sharedProgress.committedText = committedText;
      nextPayload = `[TOOL EXECUTION RESULTS]:\n${JSON.stringify(results)}\n\nContinue immediately using real function calls (write_to_file / replace_file_content) to write all requested code into workspace files. Do NOT output tool_calls JSON in chat.`;
      continue;
    }

    throwIfAborted(signal);
    const shouldNudge =
      continuationNudges < 4 &&
      ((requiresImplementation && !didMutateFiles && (calledAnyTool || looksLikeUnfinishedNarration(roundText))) ||
        looksLikeUnfinishedNarration(roundText));

    if (shouldNudge) {
      continuationNudges++;
      nextPayload = `Do NOT stop or narrate next steps. Call write_to_file or replace_file_content NOW to write/update the actual files with all requested features, then verify with compile_applet and lint_applet. Never write code or tool_calls JSON in chat.`;
      continue;
    }

    if (allowTools && didMutateFiles && selfHealRounds < 3) {
      const gate = await runMandatorySelfHealingGate(
        sharedProgress?.mutatedFiles || new Set(),
        execCtx?.sessionId,
        sendEvent,
        execCtx?.geminiApiKey,
        {
          originalPrompt: rawUserPrompt,
          poolKeys,
          activeKeyId: activeTrackedKey?.id,
          fallbackInvoker: execCtx?.llmInvoker,
          sharedProgress,
          selfHealRound: selfHealRounds,
          signal,
        }
      );
      if (!gate.passed && gate.feedbackPrompt) {
        selfHealRounds++;
        nextPayload = gate.feedbackPrompt;
        continue;
      }
    } else if (allowTools && didMutateFiles && sharedProgress?.lastGateFailure && sharedProgress?.preEditCheckpointId) {
      sendEvent({
        type: 'action',
        action: `⚠️ Auto-Rollback safety checkpoint available (${sharedProgress.preEditCheckpointId}) — use git_rollback if needed.`,
      });
    }

    break;
  }

  return committedText;
}

export interface OrchestratedChatRequest {
  messages: any[];
  mode?: string;
  userKeys?: KeyConfig[];
  keys?: KeyConfig[];
  preferredProvider?: string;
  safePacing?: boolean;
  sessionId?: string;
  selectedModel?: string;
  developerPersona?: string;
  customSystemInstruction?: string;
  outputFormat?: 'auto' | 'markdown' | 'json';
  multiAgent?: boolean;
  preferOnlyCustomKeys?: boolean;
  stickyKeyId?: string | null;
}

export interface OrchestratedChatSink {
  sendEvent: (data: any) => void;
  signal?: AbortSignal;
}

// Detached Orchestrated Chat Execution (usable both by SSE endpoint and background ChatJobManager)
export async function executeOrchestratedChat(
  req: OrchestratedChatRequest,
  sink: OrchestratedChatSink
): Promise<{ status: 'completed' | 'error' | 'cancelled' }> {
  const { sendEvent, signal } = sink;

  try {
    throwIfAborted(signal);

    const {
      messages: rawMessages,
      mode = "general",
      userKeys: reqUserKeys,
      keys: reqKeys,
      preferredProvider = 'all',
      sessionId,
      selectedModel,
      developerPersona,
      customSystemInstruction,
      outputFormat = 'auto',
      multiAgent = true,
      preferOnlyCustomKeys = false,
      stickyKeyId: reqStickyKeyId = null
    } = req;

    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    if (messages.length === 0) {
      sendEvent({
        type: "error",
        error: "অনুগ্রহ করে একটি বৈধ প্রম্পট বা মেসেজ পাঠান (messages array is empty or missing)।"
      });
      return { status: 'error' };
    }

    const userKeys = reqUserKeys || reqKeys || [];
    const systemOptions: SystemInstructionOptions = {
      developerPersona,
      customSystemInstruction,
      outputFormat,
      multiAgent,
      sessionId,
    };
    const explicitModelOverride: { provider: ApiProviderId; model: string } | null = (() => {
      const clean = (selectedModel || '').trim();
      if (!clean || clean === 'Default' || clean === 'auto') return null;
      if (clean === 'deepseek-chat' || clean === 'deepseek-reasoner') {
        return { provider: 'deepseek', model: clean };
      }
      if (clean === 'openrouter/free' || clean.endsWith(':free')) {
        return { provider: 'openrouter', model: clean };
      }
      if (/^hf:/i.test(clean) || (clean.includes('/') && !clean.endsWith(':free') && !clean.startsWith('gemini-'))) {
        return { provider: 'huggingface', model: normalizeModelName('huggingface', clean) };
      }
      return { provider: 'gemini', model: normalizeModelName('gemini', clean) };
    })();
    const explicitGeminiModel = explicitModelOverride?.provider === 'gemini' ? explicitModelOverride.model : null;

    // Extract and sanitize messages + multimodal vision images once
    const { history, lastMessage: initialLastMessage, lastMessageImages } = prepareGeminiHistoryAndLastMessage(messages);
    let lastMessage = initialLastMessage;
    const isConversationalPrompt = mode !== 'search' && isCasualOrConversationalOnly(initialLastMessage) && lastMessageImages.length === 0;
    const allowTools = !isConversationalPrompt;
    systemOptions.conversational = isConversationalPrompt;

    // Inject active workspace & session preview context ONLY for non-casual prompts (saves tokens and prevents tools on "Hi")
    if (!isConversationalPrompt) {
      try {
        const contextNotes: string[] = [];
        const safeSessId = sanitizeSessionId(sessionId || 'app');
        const wsDir = path.resolve(process.cwd(), 'workspaces', safeSessId);
        try {
          await fs.access(path.join(wsDir, 'src'));
          const wsFiles: string[] = [];
          const walkWs = async (dir: string, prefix: string) => {
            const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const e of ents) {
              if (e.name === 'node_modules' || e.name === 'dist') continue;
              if (e.isDirectory()) await walkWs(path.join(dir, e.name), `${prefix}/${e.name}`);
              else if (/\.(ts|tsx|css|html)$/i.test(e.name)) wsFiles.push(`workspaces/${safeSessId}/${prefix}/${e.name}`);
            }
          };
          await walkWs(path.join(wsDir, 'src'), 'src');
          await walkWs(path.join(wsDir, 'server'), 'server');
          if (wsFiles.length > 0) {
            contextNotes.push(`- Modular workspace workspaces/${safeSessId}/ exists (${wsFiles.length} files): ${wsFiles.slice(0, 18).join(', ')}`);
          }
        } catch {}
        if (contextNotes.length > 0) {
          lastMessage += `\n\n[ACTIVE SESSION WORKSPACE CONTEXT]:
Existing modular workspace:
${contextNotes.join('\n')}
Use the injected [CODEBASE DEPENDENCY GRAPH] and [LOCKED TYPE CONTRACTS] below; only call view_file on the exact file(s) you need to modify (skip package.json/vite.config.ts/index.html unless changing config) inside workspaces/${safeSessId}/ and finish with workspace_run(action: "build") to publish the production static preview to /projects/${safeSessId}/index.html (or action: "start" if server.ts exists).`;
        }

        // Auto-inject compact Domain Design Brief when building/designing websites or apps
        const designBrief = inferWebsiteDesignBrief(initialLastMessage, sessionId);
        if (designBrief) {
          lastMessage += `\n\n${designBrief}`;
        }

        // Harness Pre-Flight Context: package.json deps, AST symbols, codebase dependency graph, Error KB, scaffold & task checklist
        const harnessContext = await buildHarnessPreFlightContext(initialLastMessage, {
          sessionId,
          isConversational: isConversationalPrompt,
        });
        if (harnessContext) {
          lastMessage += `\n\n${harnessContext}`;
        }
      } catch {}
    }

    throwIfAborted(signal);

    // Auto-detect reference website URLs and scrape their structure, layout & copy
    const urlRegex = /(https?:\/\/[^\s<>'"]+)/gi;
    const foundUrls = initialLastMessage.match(urlRegex);
    if (foundUrls && foundUrls.length > 0) {
      const rawTargetUrl = foundUrls[0].replace(/[),.]+$/, '');
      sendEvent({
        type: "action",
        action: `🔍 Analyzing reference website: ${rawTargetUrl}...`
      });

      try {
        const scrapeSignal = combineSignals(AbortSignal.timeout(9000), signal);
        // 1. Try Jina Reader for clean, high-fidelity markdown layout extraction
        const jinaRes = await fetch(`https://r.jina.ai/${rawTargetUrl}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/plain,text/markdown,*/*',
          },
          signal: scrapeSignal,
        });

        if (jinaRes.ok) {
          const pageMarkdown = await jinaRes.text();
          if (pageMarkdown && pageMarkdown.length > 80) {
            sendEvent({
              type: "action",
              action: `✓ Scraped reference structure from ${rawTargetUrl}! Synthesizing matching design...`
            });
            lastMessage += `\n\n[REFERENCE WEBSITE CONTENT - SCRAPED FROM ${rawTargetUrl}]:
---
${pageMarkdown.slice(0, 14000)}
---
MANDATORY WEBSITE REPLICATION GUIDELINES:
1. The user requested to replicate / build a website like ${rawTargetUrl}.
2. Observe its real navbar links, brand title/logo, hero tagline, buttons, content sections, pricing/feature cards, and footer.
3. Faithfully reconstruct all these sections with modern Tailwind CSS and full responsiveness.
4. Make all elements interactive (nav buttons, tabs, modal dialogs, search filters).
5. Build this as a modular React/Vite app inside workspaces/${sanitizeSessionId(sessionId || 'app')}/ using workspace_init + write_to_file and start it with workspace_run(action: "start") (NEVER dump code into chat or write projects/*.html).`;
          }
        }
      } catch (scrapeErr: any) {
        if (isAbortOrCancelError(scrapeErr, signal)) {
          throw new JobCancelledError();
        }
        console.warn("Auto-scrape failed:", scrapeErr);
        lastMessage += `\n\n[SYSTEM DIRECTIVE: The user linked reference website ${rawTargetUrl}. Call webFetch with this URL or webSearch to inspect its actual features and layout before writing code.]`;
      }
    }

    throwIfAborted(signal);

    // Merge user keys with any server-persisted secrets
    const diskSecrets = await loadSecrets();
    const allKeysMap = new Map<string, KeyConfig>();
    for (const k of diskSecrets) {
      k.model = normalizeModelName(k.provider, k.model);
      allKeysMap.set(k.id, k);
    }
    for (const k of userKeys) {
      k.model = normalizeModelName(k.provider, k.model);
      allKeysMap.set(k.id, k);
    }
    const activePool = Array.from(allKeysMap.values()).filter(k =>
      Boolean(k.isActive && k.apiKey)
    );

    if (process.env.GEMINI_API_KEY && !preferOnlyCustomKeys) {
      const hasStudio = activePool.some(k => k.id === 'studio_primary_key');
      if (!hasStudio) {
        activePool.push({
          id: 'studio_primary_key',
          name: 'Primary Studio Engine',
          provider: 'gemini',
          apiKey: process.env.GEMINI_API_KEY,
          model: 'gemini-3.1-flash-lite',
          isActive: true,
          rpmLimit: 60,
          status: 'healthy'
        });
      }
    }

    if (activePool.length === 0) {
      addSystemLog({
        level: 'error',
        category: 'auth',
        message: 'রিকোয়েস্ট বাতিল: কোনো সচল সিক্রেট কী পাওয়া যায়নি। প্রাইমারি ইঞ্জিন নিষ্ক্রিয় রাখা হয়েছে।'
      });
      sendEvent({
        type: "error",
        error: "⚠️ কোনো সচল সিক্রেট কী পাওয়া যায়নি! নেক্সাস এখন শুধুমাত্র আপনার সিক্রেট কী থেকে পরিচালিত হয় (প্রাইমারি ইঞ্জিন বন্ধ রয়েছে)। অনুগ্রহ করে উপরের 🔑 (API Keys) মেনুতে আপনার Google AI Studio অথবা OpenRouter API কী যুক্ত করুন।",
        isAuthError: true
      });
      return { status: 'error' };
    }

    const excludedKeyIds = new Set<string>();
    const maxAttempts = activePool.length;
    let attempts = 0;
    let succeeded = false;
    let sawDailyFreeLimit = false;
    let sawRateLimit = false;
    let sawProviderOverload = false;
    let sawAuthError = false;
    let sawAllOpenRouterFailed = false;
    let lastFailureMessage = '';
    const failedGeminiModels = new Set<string>();

    const buildGeminiModelChain = (primary?: string | null) => {
      return getProviderModelChain('gemini', primary).filter(m => !failedGeminiModels.has(m));
    };

    const sharedProgress: SharedExecutionProgress = {
      mutatedFiles: new Set<string>(),
      readFiles: new Set<string>(),
      executedTools: [],
      committedText: '',
    };

    if (!isConversationalPrompt && isActionOrBuildPrompt(initialLastMessage)) {
      const autoCp = await createCheckpoint(`Auto pre-edit: ${initialLastMessage.slice(0, 40)}`).catch(() => null);
      if (autoCp?.id) {
        sharedProgress.preEditCheckpointId = autoCp.id;
        sendEvent({ type: "action", action: `🛡️ Auto-Checkpoint created (${autoCp.id}) before edits.` });
      }
    }

    throwIfAborted(signal);

    // Reusable mid-task handoff helper (used by both custom keys and Primary Studio Engine fallback)
    const buildEffectivePrompt = async (): Promise<string> => {
      if (sharedProgress.executedTools.length === 0 && sharedProgress.mutatedFiles.size === 0) {
        return lastMessage;
      }
      let onDiskSummary = '';
      if (sessionId) {
        try {
          const safeSessId = sanitizeSessionId(sessionId);
          const wsRoot = path.resolve(process.cwd(), 'workspaces', safeSessId);
          const wsStats: Array<{ file: string; lines: number }> = [];
          const walkHandoff = async (dir: string, relBase: string) => {
            const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            for (const ent of ents) {
              if (ent.isSymbolicLink() || ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.git') continue;
              const fullP = path.join(dir, ent.name);
              const relP = relBase ? `${relBase}/${ent.name}` : ent.name;
              if (ent.isDirectory()) {
                await walkHandoff(fullP, relP);
              } else if (/\.(ts|tsx|js|jsx|css|html|json)$/i.test(ent.name)) {
                const txt = await fs.readFile(fullP, 'utf-8').catch(() => '');
                wsStats.push({ file: `workspaces/${safeSessId}/${relP}`, lines: txt ? txt.split('\n').length : 0 });
              }
            }
          };
          await walkHandoff(wsRoot, '');
          if (wsStats.length > 0) {
            const totalWsLines = wsStats.reduce((sum, x) => sum + x.lines, 0);
            onDiskSummary = `\nCurrent files on disk (${wsStats.length} files, ${totalWsLines} lines total): ${wsStats.slice(0, 35).map(x => `${x.file} (${x.lines}L)`).join(', ')}`;
          }
        } catch {}
      }
      const handoffNote = `\n\n[MID-TASK HANDOFF CONTEXT]: Previous provider already executed [${sharedProgress.executedTools.slice(-10).join(', ')}] and updated files [${Array.from(sharedProgress.mutatedFiles).slice(-25).join(', ') || 'none'}].${onDiskSummary}\nContinue cleanly from the remaining unbuilt files/features on disk—do NOT rewrite already completed files unless fixing an import/compile issue.`;
      return lastMessage + handoffNote;
    };

    const safeSessionId = sessionId ? sanitizeSessionId(sessionId) : '';
    const targetsNexusInternals =
      /(?:server\/|apiOrchestrator|sandboxManager|harnessEngine|websiteDeployer|geminiService|GoogleAIStudioCoderView|SecretsModal|SidebarDrawer|FirebaseModal|GitHubSyncModal|LogsModal|ToolsModal|SettingsModal|AgentStatusStrip|AskQuestionModal|agentStatus|নেক্সাস)/i.test(
        initialLastMessage
      );
    const hasExistingSessionWorkspace = safeSessionId
      ? await fs.access(path.resolve(process.cwd(), 'workspaces', safeSessionId, 'src')).then(() => true).catch(() => false)
      : false;
    const sandboxLockSessionId =
      safeSessionId &&
      !targetsNexusInternals &&
      (shouldUseModularArchitecture(initialLastMessage) || hasExistingSessionWorkspace)
        ? safeSessionId
        : undefined;

    const buildExecCtx = (
      invoker: (sys: string, usr: string) => Promise<string>,
      geminiCreds?: { apiKey: string; model: string }
    ): ToolExecutionContext => ({
      sessionId,
      sandboxLockSessionId,
      readFiles: sharedProgress.readFiles,
      geminiApiKey: geminiCreds?.apiKey,
      geminiModel: geminiCreds?.model,
      llmInvoker: invoker,
      signal,
      allowInteractiveFirebasePrompt:
        /(firebase|firestore|firebaseconfig|ফায়ারবেস|ফায়ারবেস)/i.test(initialLastMessage),
      onAskQuestion: (questions) => {
        if (signal?.aborted) {
          return Promise.resolve({ answers: {}, skipped: true, notes: 'Request cancelled.' });
        }
        const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
          const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
          };
          const timer = setTimeout(() => {
            if (pendingQuestionResolvers.delete(questionId)) {
              cleanup();
              resolve({ answers: {}, skipped: true, notes: 'Timed out waiting for response.' });
            }
          }, 120000);
          const onAbort = () => {
            if (pendingQuestionResolvers.delete(questionId)) {
              clearTimeout(timer);
              cleanup();
              resolve({ answers: {}, skipped: true, notes: 'Request cancelled.' });
            }
          };
          pendingQuestionResolvers.set(questionId, {
            resolve: (val) => {
              cleanup();
              resolve(val);
            },
            timer,
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          sendEvent({
            type: 'ask_question',
            questionId,
            questions,
          });
        });
      },
      onRequestFirebaseSetup: (reqInfo) => {
        if (signal?.aborted) {
          return Promise.resolve({ action: 'scaffold' });
        }
        const requestId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve) => {
          const cleanup = () => {
            signal?.removeEventListener('abort', onAbort);
          };
          const timer = setTimeout(() => {
            if (pendingFirebaseResolvers.delete(requestId)) {
              cleanup();
              resolve({ action: 'scaffold' });
            }
          }, 120000);
          const onAbort = () => {
            if (pendingFirebaseResolvers.delete(requestId)) {
              clearTimeout(timer);
              cleanup();
              resolve({ action: 'scaffold' });
            }
          };
          pendingFirebaseResolvers.set(requestId, {
            resolve: (val) => {
              cleanup();
              resolve(val);
            },
            timer,
          });
          signal?.addEventListener('abort', onAbort, { once: true });
          sendEvent({
            type: 'firebase_setup_request',
            requestId,
            ...reqInfo,
          });
        });
      },
      onAgentStep: (agentStep) => {
        emitActionStep(sendEvent, agentStep.kind, agentStep.label, agentStep.detail, {
          id: agentStep.id,
          agentRole: agentStep.agentRole,
          status: agentStep.status,
          durationSec: agentStep.durationSec,
          isError: agentStep.status === 'error',
        });
      },
    });

    // Pooled Sub-Agent LLM invoker: routes omo_coordinate / debug_error_analysis to idle spare keys in parallel!
    const buildPooledLlmInvoker = (
      primaryKey: KeyConfig,
      primaryFallback: (sys: string, usr: string) => Promise<string>
    ) => {
      return async (sys: string, usr: string): Promise<string> => {
        throwIfAborted(signal);
        const estTokens = estimateTokensFromPayload(sys) + estimateTokensFromPayload(usr) + 600;
        const desiredSubTier: Exclude<KeyRoleTier, 'auto'> =
          estTokens < 1600 && !/(critic|architect|debug|error|audit|plan)/i.test(sys) ? 'fast' : 'architect';
        const spareCandidates = activePool.filter(k =>
          k.isActive &&
          k.id !== primaryKey.id &&
          k.id !== 'studio_primary_key' &&
          k.provider !== 'groq' &&
          getKeyEffectiveCaps(k).rawTpmLimit > 8000 &&
          getOrCreateStats(k.id).cooldownUntil <= Date.now()
        );
        if (spareCandidates.length > 0) {
          const { key: spareKey } = selectBestKey(spareCandidates, 'all', new Set(), null, {
            loadBalance: true,
            desiredTier: desiredSubTier,
            estimatedTokens: estTokens,
          });
          if (spareKey) {
            acquireKeyInFlight(spareKey.id);
            try {
              const spareStats = getOrCreateStats(spareKey.id);
              const tsNow = Date.now();
              spareStats.timestamps.push(tsNow);
              spareStats.tokenTimestamps.push({ ts: tsNow, tokens: estTokens });
              spareStats.dailyRequests++;
              spareStats.lastUsedAt = tsNow;

              if (spareKey.provider === 'gemini') {
                const spareModel = getProviderModelChain('gemini', normalizeModelName('gemini', spareKey.model))[0] || 'gemini-3.5-flash-lite';
                const spareClient = new GoogleGenAI({
                  apiKey: spareKey.apiKey.trim().replace(/^["']|["']$/g, ''),
                  httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
                });
                const r = await raceWithAbort(spareClient.models.generateContent({
                  model: spareModel,
                  contents: usr,
                  config: { systemInstruction: sys },
                }), signal);
                if (r.text) return r.text;
              } else if (spareKey.provider === 'openrouter') {
                const { data } = await raceWithAbort(fetchOpenRouterWithFallback({
                  apiKey: spareKey.apiKey,
                  preferredModel: normalizeModelName('openrouter', spareKey.model),
                  messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: usr },
                  ],
                  timeoutMs: 25000,
                }), signal);
                const txt = data?.choices?.[0]?.message?.content;
                if (txt) return txt;
              } else if (spareKey.provider === 'huggingface') {
                const { data } = await raceWithAbort(fetchHuggingFaceWithFallback({
                  apiKey: spareKey.apiKey,
                  preferredModel: normalizeModelName('huggingface', spareKey.model),
                  messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: usr },
                  ],
                  timeoutMs: 25000,
                }), signal);
                const txt = data?.choices?.[0]?.message?.content;
                if (txt) return txt;
              } else {
                const ep = getOpenAICompatibleEndpoint(spareKey.provider, spareKey.baseUrl);
                const spareModel = getProviderModelChain(spareKey.provider, normalizeModelName(spareKey.provider, spareKey.model))[0]
                  || normalizeModelName(spareKey.provider, spareKey.model);
                const r = await fetch(ep, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${spareKey.apiKey}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    model: spareModel,
                    messages: [
                      { role: 'system', content: sys },
                      { role: 'user', content: usr },
                    ],
                    stream: false,
                  }),
                  signal: combineSignals(AbortSignal.timeout(15000), signal),
                });
                if (r.ok) {
                  const j = await r.json().catch(() => null);
                  const txt = j?.choices?.[0]?.message?.content;
                  if (txt) return txt;
                } else if (r.status === 429) {
                  recordKeyCooldown(spareKey.id, 60, 'Sub-agent 429 rate limit');
                }
              }
            } catch (subErr: any) {
              if (isAbortOrCancelError(subErr, signal)) throw new JobCancelledError();
              // Fall through cleanly to primary key invoker
            } finally {
              releaseKeyInFlight(spareKey.id);
            }
          }
        }
        throwIfAborted(signal);
        return primaryFallback(sys, usr);
      };
    };

    const effectivePreferredProvider =
      preferredProvider === 'all' &&
      explicitModelOverride &&
      explicitModelOverride.provider !== 'gemini' &&
      activePool.some((k) => k.isActive && k.provider === explicitModelOverride.provider)
        ? explicitModelOverride.provider
        : preferredProvider;

    while (attempts < maxAttempts && !succeeded) {
      throwIfAborted(signal);
      attempts++;

      // Select the best key: enforces 80% RPM/TPM guard + role tiering + least-used rotation across 1..40+ keys
      const { key, reason: selectionReason, healthyCount } = selectBestKey(
        activePool,
        effectivePreferredProvider,
        excludedKeyIds,
        reqStickyKeyId,
        {
          requiresVision: lastMessageImages.length > 0,
          desiredTier: isActionOrBuildPrompt(initialLastMessage) ? 'architect' : undefined,
          estimatedTokens: estimateTokensFromPayload(lastMessage) + 1200,
        }
      );

      if (key) {
        excludedKeyIds.add(key.id);
        if (selectionReason) {
          sendEvent({ type: "action", action: `🔑 ${selectionReason}: ${key.name}` });
        }
        const matchedExplicitModel =
          explicitModelOverride && explicitModelOverride.provider === key.provider
            ? explicitModelOverride.model
            : null;
        const activeModel = key.provider === 'gemini'
          ? (explicitGeminiModel || normalizeModelName('gemini', key.model))
          : key.provider === 'openrouter'
            ? getOpenRouterModelChain(matchedExplicitModel || key.model)[0]
            : key.provider === 'huggingface'
              ? getHuggingFaceModelChain(matchedExplicitModel || key.model)[0]
              : key.provider === 'deepseek'
                ? getDeepSeekModelChain(matchedExplicitModel || key.model)[0]
                : (matchedExplicitModel || key.model || 'default');
        sendEvent({
          type: "key_active",
          keyId: key.id,
          keyName: key.name,
          provider: key.provider,
          model: activeModel,
          isCustomKey: key.id !== 'studio_primary_key'
        });
        sendEvent({
          type: "action",
          action: `Routing via ${key.name} (${key.provider.toUpperCase()} • ${activeModel})...`
        });
        emitActionStep(
          sendEvent,
          'command',
          `Connected ${key.name} (${activeModel})`,
          `${key.provider.toUpperCase()} • ${activeModel}`,
          { status: 'done' }
        );

        const effectivePrompt = await buildEffectivePrompt();
        throwIfAborted(signal);

        try {
          if (key.provider === 'gemini') {
            const cleanGeminiKey = key.apiKey.trim().replace(/^["']|["']$/g, '');
            let client = new GoogleGenAI({
              apiKey: cleanGeminiKey,
              httpOptions: {
                headers: {
                  "User-Agent": "aistudio-build"
                }
              }
            });
            const geminiChain = buildGeminiModelChain(explicitGeminiModel || normalizeModelName('gemini', key.model));
            let fullText = '';
            let usedModel = geminiChain[0];
            let geminiChainErr: any = null;
            let triedVertexExpress = false;

            for (const candidateModel of geminiChain) {
              throwIfAborted(signal);
              usedModel = candidateModel;
              try {
                const execCtx: any = buildExecCtx(
                  buildPooledLlmInvoker(key, async (sys, usr) => {
                    const subRes = await raceWithAbort(client.models.generateContent({
                      model: candidateModel,
                      contents: usr,
                      config: { systemInstruction: sys },
                    }), signal);
                    return subRes.text || '';
                  }),
                  { apiKey: cleanGeminiKey, model: candidateModel }
                );
                execCtx.poolHealthyCount = healthyCount;

                fullText = await runGeminiAgentLoop(
                  client,
                  candidateModel,
                  mode,
                  systemOptions,
                  history,
                  effectivePrompt,
                  initialLastMessage,
                  sendEvent,
                  execCtx,
                  key,
                  allowTools,
                  lastMessageImages,
                  sharedProgress,
                  activePool
                );
                geminiChainErr = null;
                break;
              } catch (mErr: any) {
                if (isAbortOrCancelError(mErr, signal)) {
                  throw new JobCancelledError();
                }
                geminiChainErr = mErr;
                const mMsg = mErr?.message || '';
                if (!triedVertexExpress && cleanGeminiKey.startsWith('AQ.') && /ACCESS_TOKEN_TYPE_UNSUPPORTED|API key not valid/i.test(mMsg)) {
                  triedVertexExpress = true;
                  try {
                    client = new GoogleGenAI({
                      vertexai: true,
                      apiKey: cleanGeminiKey,
                      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
                    });
                    const vExecCtx = buildExecCtx(
                      async (sys, usr) => {
                        const subRes = await raceWithAbort(client.models.generateContent({
                          model: candidateModel,
                          contents: usr,
                          config: { systemInstruction: sys },
                        }), signal);
                        return subRes.text || '';
                      },
                      { apiKey: cleanGeminiKey, model: candidateModel }
                    );
                    fullText = await runGeminiAgentLoop(
                      client,
                      candidateModel,
                      mode,
                      systemOptions,
                      history,
                      effectivePrompt,
                      initialLastMessage,
                      sendEvent,
                      vExecCtx,
                      key,
                      allowTools,
                      lastMessageImages,
                      sharedProgress,
                      activePool,
                      true
                    );
                    geminiChainErr = null;
                    break;
                  } catch (vErr: any) {
                    if (isAbortOrCancelError(vErr, signal)) {
                      throw new JobCancelledError();
                    }
                    geminiChainErr = vErr;
                  }
                }
                const isModelDefective =
                  mErr?.status === 404 ||
                  /404|not found|not supported|deprecated/i.test(mMsg);
                if (isModelDefective) {
                  failedGeminiModels.add(candidateModel);
                }
                const isModelRetryable =
                  mErr?.status === 503 ||
                  mErr?.status === 404 ||
                  mErr?.status === 429 ||
                  /503|404|429|high demand|UNAVAILABLE|not found|not supported|quota/i.test(mMsg);
                if (!isModelRetryable) throw geminiChainErr;
                sendEvent({
                  type: "action",
                  action: `⚡ ${candidateModel} unavailable/busy, switching to backup Gemini model...`
                });
              }
            }

            if (geminiChainErr) throw geminiChainErr;
            throwIfAborted(signal);

            recordKeySuccess(key.id);
            addSystemLog({
              level: 'success',
              category: 'execution',
              keyName: key.name,
              provider: key.provider,
              model: usedModel,
              message: `✓ Success: ${key.name} responded successfully (${usedModel}). Saved as sticky key for next turn.`
            });
            await ensureWorkspacePreviewEmitted(sharedProgress, sessionId, sendEvent);
            const deployed = sharedProgress.mutatedFiles.size === 0
              ? await autoDeployWebsiteFromText(fullText, sessionId)
              : { success: false as const };
            if (deployed.success) {
              const previewUrl = deployed.url || "/projects/index.html";
              sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
              sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
              emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
              sendEvent({
                type: "preview_ready",
                url: previewUrl,
                sessionId,
                html: deployed.html,
                timestamp: Date.now()
              });
            }
            emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
            sendEvent({
              type: "done",
              fullText,
              activeKeyId: key.id,
              keyName: key.name,
              provider: key.provider,
              model: usedModel,
              isCustomKey: key.id !== 'studio_primary_key'
            });
            succeeded = true;
            break;
          } else if (['openrouter', 'huggingface', 'deepseek', 'groq', 'cerebras', 'mistral', 'grok', 'custom'].includes(key.provider)) {
            const preferredForKey = matchedExplicitModel || key.model;
            const targetModel = key.provider === 'openrouter'
              ? getOpenRouterModelChain(preferredForKey)[0]
              : key.provider === 'huggingface'
                ? getHuggingFaceModelChain(preferredForKey)[0]
                : key.provider === 'deepseek'
                  ? getDeepSeekModelChain(preferredForKey)[0]
                  : normalizeModelName(key.provider, preferredForKey);
            const endpoint = getOpenAICompatibleEndpoint(key.provider, key.baseUrl);
            const extraHeaders: Record<string, string> = key.provider === 'openrouter'
              ? { 'HTTP-Referer': 'https://nexus-ai.local', 'X-Title': 'Nexus AI' }
              : {};

            const execCtx: any = buildExecCtx(
              buildPooledLlmInvoker(key, async (sys, usr) => {
                throwIfAborted(signal);
                if (key.provider === 'openrouter') {
                  const { data } = await raceWithAbort(fetchOpenRouterWithFallback({
                    apiKey: key.apiKey,
                    preferredModel: targetModel,
                    messages: [
                      { role: 'system', content: sys },
                      { role: 'user', content: usr },
                    ],
                    timeoutMs: 25000,
                  }), signal);
                  return data?.choices?.[0]?.message?.content || '';
                }
                if (key.provider === 'huggingface') {
                  const { data } = await raceWithAbort(fetchHuggingFaceWithFallback({
                    apiKey: key.apiKey,
                    preferredModel: targetModel,
                    messages: [
                      { role: 'system', content: sys },
                      { role: 'user', content: usr },
                    ],
                    timeoutMs: 25000,
                  }), signal);
                  return data?.choices?.[0]?.message?.content || '';
                }
                const subRes = await fetch(endpoint, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${key.apiKey}`,
                    'Content-Type': 'application/json',
                    ...extraHeaders,
                  },
                  body: JSON.stringify({
                    model: targetModel,
                    messages: [
                      { role: 'system', content: sys },
                      { role: 'user', content: usr },
                    ],
                    stream: false,
                  }),
                  ...(signal ? { signal } : {}),
                });
                const j = await subRes.json().catch(() => null);
                return j?.choices?.[0]?.message?.content || '';
              })
            );
            execCtx.poolHealthyCount = healthyCount;

            const fullText = await streamOpenAICompatible(
              endpoint,
              key.apiKey,
              targetModel,
              extraHeaders,
              messages,
              mode,
              sendEvent,
              systemOptions,
              execCtx,
              effectivePrompt,
              initialLastMessage,
              key,
              allowTools,
              lastMessageImages,
              sharedProgress,
              activePool
            );

            throwIfAborted(signal);
            const resolvedModel = sharedProgress.activeModel || targetModel;
            recordKeySuccess(key.id);
            addSystemLog({
              level: 'success',
              category: 'execution',
              keyName: key.name,
              provider: key.provider,
              model: resolvedModel,
              message: `✓ Success: ${key.name} (${key.provider.toUpperCase()} · ${resolvedModel}) responded successfully. Saved as sticky key for next turn.`
            });
            await ensureWorkspacePreviewEmitted(sharedProgress, sessionId, sendEvent);
            const deployed = sharedProgress.mutatedFiles.size === 0
              ? await autoDeployWebsiteFromText(fullText, sessionId)
              : { success: false as const };
            if (deployed.success) {
              const previewUrl = deployed.url || "/projects/index.html";
              sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
              sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
              emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
              sendEvent({
                type: "preview_ready",
                url: previewUrl,
                sessionId,
                html: deployed.html,
                timestamp: Date.now()
              });
            }
            emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
            sendEvent({
              type: "done",
              fullText,
              activeKeyId: key.id,
              keyName: key.name,
              provider: key.provider,
              model: resolvedModel,
              isCustomKey: true
            });
            succeeded = true;
            break;
          }
        } catch (err: any) {
          if (isAbortOrCancelError(err, signal)) {
            throw new JobCancelledError();
          }
          const errMsg = String(err?.message || err || 'Unknown error');
          lastFailureMessage = errMsg;
          if (err?.allOpenRouterModelsFailed) {
            sawAllOpenRouterFailed = true;
          }
          const isDailyFreeLimit = /free-models-per-day|exceeded.*monthly.*credits|insufficient balance/i.test(errMsg) || err.status === 402;
          const is429 = err.status === 429 || errMsg.includes("429") || /quota|rate limit|free-models-per-day/i.test(errMsg);
          const is503 = err.status === 503 || err.status === 502 || /503|502|high demand|provider returned error|unavailable/i.test(errMsg);
          const is404Model = err.status === 404 || /not found|not supported for generateContent/i.test(errMsg);
          const isQuotaExceeded = is429 || /quota exceeded|resource_exhausted/i.test(errMsg);
          const isAuthError = err.status === 401 || (err.status === 403 && key.provider === 'huggingface') || err.code === 401 || /401|API key not valid|UNAUTHENTICATED|User not found|ACCESS_TOKEN_TYPE_UNSUPPORTED|Invalid credentials/i.test(errMsg);

          if (isDailyFreeLimit) sawDailyFreeLimit = true;
          if (isQuotaExceeded) sawRateLimit = true;
          if (is503) sawProviderOverload = true;
          if (isAuthError) sawAuthError = true;

          if (isAuthError) {
            addSystemLog({
              level: 'error',
              category: 'auth',
              keyName: key.name,
              provider: key.provider,
              model: key.model,
              message: `❌ ${key.name}: Invalid API Key (401 Unauthorized / Access Token Unsupported). Key disabled.`,
              details: errMsg
            });
            key.isActive = false;
            loadSecrets().then((allSecrets) => {
              const existing = allSecrets.find(k => k.id === key.id);
              if (existing) {
                existing.isActive = false;
                existing.status = 'error';
                existing.lastError = 'Invalid API key format or unauthorized';
                saveSecrets(allSecrets).catch(() => {});
              }
            }).catch(() => {});
            recordKeyCooldown(key.id, 86400, "Invalid API key");
            sendEvent({
              type: "action",
              action: `❌ ${key.name}: Invalid API Key (Unauthorized). Key has been disabled.`
            });
          } else {
            if ((is404Model || is503 || (isQuotaExceeded && key.model !== 'gemini-3.1-flash-lite')) && key.provider === 'gemini') {
              const oldModel = key.model;
              key.model = 'gemini-3.1-flash-lite';
              loadSecrets().then((allSecrets) => {
                const existing = allSecrets.find(k => k.id === key.id);
                if (existing) {
                  existing.model = 'gemini-3.1-flash-lite';
                  saveSecrets(allSecrets).catch(() => {});
                }
              }).catch(() => {});
              addSystemLog({
                level: 'warn',
                category: 'rotation',
                keyName: key.name,
                provider: key.provider,
                message: `⚡ Auto-healed ${key.name} from ${oldModel} to Gemini 3.1 Flash Lite.`
              });
            }

            const cooldownSec = isDailyFreeLimit ? 1800 : isQuotaExceeded ? 60 : 15;
            addSystemLog({
              level: 'warn',
              category: isQuotaExceeded ? 'rate_limit' : 'execution',
              keyName: key.name,
              provider: key.provider,
              message: `⚠️ ${key.name} rotated (${isDailyFreeLimit ? 'Daily Free Limit' : is429 ? 'Rate limit / 429' : errMsg.slice(0, 120)}).`,
              details: errMsg
            });
            recordKeyCooldown(key.id, cooldownSec, errMsg);
            sendEvent({
              type: "action",
              action: `⚠️ ${key.name} ${isDailyFreeLimit ? 'reached daily free limit' : is429 ? 'hit rate limit (429)' : 'had a provider error'}. Auto-rotating to next healthy API key...`
            });
            sendEvent({
              type: "key_cooldown",
              keyId: key.id,
              reason: isDailyFreeLimit ? 'OpenRouter free-models-per-day limit' : is429 ? 'Rate limit exceeded' : errMsg,
              cooldownSec
            });
          }
        }
      } else {
        addSystemLog({
          level: 'warn',
          category: 'rotation',
          message: 'পুল থেকে আর কোনো সক্রিয় ও প্রস্তুত সিক্রেট কী পাওয়া যায়নি।'
        });
        break;
      }
    }

    throwIfAborted(signal);

    // Seamless Fallback: If custom keys hit errors or rate limits, auto-fallback across resilient Gemini Studio models
    if (!succeeded && !preferOnlyCustomKeys && process.env.GEMINI_API_KEY) {
      const client = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: { headers: { "User-Agent": "aistudio-build" } }
      });
      const fallbackChain = buildGeminiModelChain(explicitGeminiModel);

      for (const fallbackModel of fallbackChain) {
        throwIfAborted(signal);
        try {
          addSystemLog({
            level: 'info',
            category: 'rotation',
            message: `স্বয়ংক্রিয় ব্যাকআপ হিসেবে প্রাইমারি স্টুডিও ইঞ্জিন (${fallbackModel}) চেষ্টা করা হচ্ছে...`
          });
          sendEvent({
            type: "key_active",
            keyId: "studio_primary",
            keyName: "Primary Studio Engine",
            provider: "gemini",
            model: fallbackModel,
            isCustomKey: false
          });
          sendEvent({
            type: "action",
            action: `⚡ প্রাইমারি স্টুডিও ইঞ্জিন (${fallbackModel}) সক্রিয় করা হয়েছে...`
          });

          const fbEffectivePrompt = await buildEffectivePrompt();
          const fbExecCtx = buildExecCtx(async (sys, usr) => {
            const subRes = await raceWithAbort(client.models.generateContent({
              model: fallbackModel,
              contents: usr,
              config: { systemInstruction: sys },
            }), signal);
            return subRes.text || '';
          });

          const fullText = await runGeminiAgentLoop(
            client,
            fallbackModel,
            mode,
            systemOptions,
            history,
            fbEffectivePrompt,
            initialLastMessage,
            sendEvent,
            fbExecCtx,
            undefined,
            allowTools,
            lastMessageImages,
            sharedProgress,
            activePool
          );

          throwIfAborted(signal);
          succeeded = true;
          persistStickyKeyId("studio_primary");

          await ensureWorkspacePreviewEmitted(sharedProgress, sessionId, sendEvent);
          const deployed = sharedProgress.mutatedFiles.size === 0
            ? await autoDeployWebsiteFromText(fullText, sessionId)
            : { success: false as const };
          if (deployed.success) {
            const previewUrl = deployed.url || "/projects/index.html";
            sendEvent({ type: "action", action: `✓ Website deployed to ${previewUrl}! Live Preview ready.` });
            sendEvent({ type: "file_modified", filePath: deployed.path || 'projects/index.html', action: 'created' });
            emitActionStep(sendEvent, 'build', 'Deployed PWA preview', previewUrl, { status: 'done' });
            sendEvent({ type: "preview_ready", url: previewUrl, html: deployed.html, sessionId: sessionId || undefined });
          }

          emitActionStep(sendEvent, 'respond', 'Responded', undefined, { status: 'done' });
          sendEvent({ type: "done", fullText, keyId: "studio_primary", model: fallbackModel });
          break;
        } catch (fbErr: any) {
          if (isAbortOrCancelError(fbErr, signal)) {
            throw new JobCancelledError();
          }
          const fbMsg = String(fbErr?.message || fbErr || '');
          lastFailureMessage = fbMsg;
          if (/503|high demand|UNAVAILABLE/i.test(fbMsg)) sawProviderOverload = true;
          if (/429|quota|rate limit/i.test(fbMsg)) sawRateLimit = true;
          addSystemLog({
            level: 'warn',
            category: 'rotation',
            provider: 'gemini',
            model: fallbackModel,
            message: `প্রাইমারি ব্যাকআপ মডেল (${fallbackModel}) ব্যস্ত/ব্যর্থ: ${fbMsg.slice(0, 120)}`
          });
        }
      }
    }

    if (!succeeded) {
      let finalUserError = "⚠️ প্রোভাইডার সাময়িকভাবে সাড়া দিচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।";
      let finalIsAuthError = false;

      if (sawAllOpenRouterFailed && !sawAuthError) {
        finalUserError = `⚠️ ${lastFailureMessage}`;
      } else if (sawDailyFreeLimit) {
        finalUserError = "⚠️ আপনার OpenRouter ফ্রি কী-টির দৈনিক লিমিট (free-models-per-day) শেষ হয়ে গেছে। চালু রাখতে 🔑 API Keys মেনুতে নতুন একটি Gemini / Groq / OpenRouter কী যুক্ত করুন।";
      } else if (sawRateLimit && !sawAuthError) {
        finalUserError = "⚠️ বর্তমান API কী-গুলোর রেট লিমিট (429 Rate Limit) পূর্ণ হয়েছে। অনুগ্রহ করে ৩০-৬০ সেকেন্ড অপেক্ষা করুন অথবা 🔑 মেনুতে বিকল্প কী যুক্ত করুন।";
      } else if (sawProviderOverload && !sawAuthError) {
        finalUserError = "⚠️ এআই মডেল প্রোভাইডার সাময়িকভাবে অতিরিক্ত ব্যস্ত (503 High Demand / Provider Error)। অনুগ্রহ করে কয়েক সেকেন্ড পর আবার চেষ্টা করুন।";
      } else if (sawAuthError) {
        finalUserError = "⚠️ আপনার যুক্ত করা সিক্রেট কীগুলোতে অনুমোদন সমস্যা রয়েছে (401 Unauthorized / Invalid Key)। অনুগ্রহ করে 🔑 মেনু থেকে কীগুলোর স্থিতি চেক করুন।";
        finalIsAuthError = true;
      } else if (lastFailureMessage) {
        finalUserError = `⚠️ রিকোয়েস্ট সম্পন্ন করা যায়নি: ${lastFailureMessage.slice(0, 180)}`;
      }

      addSystemLog({
        level: 'error',
        category: finalIsAuthError ? 'auth' : sawRateLimit ? 'rate_limit' : 'execution',
        message: finalUserError
      });
      sendEvent({
        type: "error",
        error: finalUserError,
        isAuthError: finalIsAuthError
      });
      return { status: 'error' };
    }

    return { status: 'completed' };
  } catch (err: any) {
    if (isAbortOrCancelError(err, signal)) {
      sendEvent({
        type: "cancelled",
        reason: err?.message || "Request cancelled by user",
      });
      return { status: 'cancelled' };
    }
    throw err;
  }
}

// Legacy direct-SSE Orchestrated Chat Handler (wraps executeOrchestratedChat)
export async function handleOrchestratedChat(
  req: OrchestratedChatRequest,
  res: Response
) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const abortController = new AbortController();
  const sendEvent = (data: any) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Keep SSE proxy connections (Render / Cloudflare / mobile 4G) alive during long tool operations
  const sseKeepalive = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keepalive\n\n'); } catch {}
    }
  }, 12000);
  res.once('close', () => {
    clearInterval(sseKeepalive);
    if (!abortController.signal.aborted) {
      abortController.abort(new JobCancelledError('Client disconnected from direct stream'));
    }
  });

  try {
    await executeOrchestratedChat(req, {
      sendEvent,
      signal: abortController.signal,
    });
  } catch (err: any) {
    if (!res.writableEnded) {
      sendEvent({
        type: 'error',
        error: String(err?.message || err || 'Internal orchestration error'),
      });
    }
  } finally {
    clearInterval(sseKeepalive);
    if (!res.writableEnded) {
      res.end();
    }
  }
}
