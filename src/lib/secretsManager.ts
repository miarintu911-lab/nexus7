import { ApiProviderId, KeyConfig, KeyRoleTier } from '../types/secrets';

const STORAGE_KEY = 'nexus_api_keys_pool';
const FREE_ONLY_KEY = 'nexus_prefer_only_custom_keys';

export interface ModelPreset {
  id: string;
  label: string;
  badge: string;
}

export interface ProviderPresetInfo {
  id: ApiProviderId;
  label: string;
  freeTierNote: string;
  keyPlaceholder: string;
  defaultBaseUrl?: string;
  models: ModelPreset[];
}

export const PROVIDER_CATALOG: ProviderPresetInfo[] = [
  {
    id: 'gemini',
    label: 'Google Gemini (Free Tier · AI Studio)',
    freeTierNote: 'Free API key at aistudio.google.com (AIza... or AQ....) — supports tool calling & coding',
    keyPlaceholder: 'AIzaSy... or AQ.Ab8...',
    models: [
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', badge: 'Free · Ultra Fast' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', badge: 'Free · Coding' },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', badge: 'Free · 1500 RPD' },
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', badge: 'Pro · Architecture' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', badge: 'Deep Reasoning' },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (Free :free Models)',
    freeTierNote: 'Multiple $0 free tool-calling coding models at openrouter.ai/keys with automatic fallback rotation',
    keyPlaceholder: 'sk-or-v1-...',
    models: [
      { id: 'cohere/north-mini-code:free', label: 'Cohere North Mini Code (:free)', badge: 'Primary · Coding' },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', label: 'NVIDIA Nemotron 3 Ultra 550B (:free)', badge: 'Free · 550B' },
      { id: 'google/gemma-4-31b-it:free', label: 'Google Gemma 4 31B (:free)', badge: 'Free · Google' },
      { id: 'nvidia/nemotron-3.5-lightning:free', label: 'NVIDIA Nemotron 3.5 Lightning (:free)', badge: 'Free · 1M Ctx' },
      { id: 'inclusionai/ling-3.2-flash:free', label: 'inclusionAI Ling 3.2 Flash (:free)', badge: 'Free · 1M Ctx' },
      { id: 'google/gemma-4-26b-a4b-it:free', label: 'Google Gemma 4 26B A4B (:free)', badge: 'Free · Fast' },
      { id: 'baidu/ernie-5.5-flash-preview:free', label: 'Baidu ERNIE 5.5 Flash (:free)', badge: 'Free · 1M Ctx' },
      { id: 'recursive/flint-v1.0:free', label: 'Recursive Flint v1.0 (:free)', badge: 'Free · Coding' },
      { id: 'nvidia/nemotron-3.5-super-vl:free', label: 'NVIDIA Nemotron 3.5 Super VL (:free)', badge: 'Free · Vision' },
      { id: 'openrouter/free', label: 'OpenRouter Free Auto-Router', badge: 'Ultimate Backup' },
    ],
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Router (:cheapest · Credits/PRO Required)',
    freeTierNote: 'গুরুত্বপূর্ণ: Hugging Face আনলিমিটেড ফ্রি chat API বন্ধ করেছে — Router-এ কোনো $0 ফ্রি মডেল নেই (ফ্রি অ্যাকাউন্টে ক্রেডিট/PRO বা HF BYOK না থাকলে 402 আসে)। নিচে সবচেয়ে সস্তা `:cheapest` মডেল ($0.05–$0.28/1M) সেট করা আছে; একদম $0 ফ্রিতে চালাতে OpenRouter (:free), Groq বা Cerebras ব্যবহার করুন।',
    keyPlaceholder: 'hf_...',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash:cheapest', label: 'DeepSeek V4 Flash (:cheapest)', badge: 'Primary · $0.18/1M' },
      { id: 'Qwen/Qwen3-32B:cheapest', label: 'Qwen 3 32B (:cheapest)', badge: 'Coding · $0.28/1M' },
      { id: 'Qwen/Qwen3.5-9B:cheapest', label: 'Qwen 3.5 9B (:cheapest)', badge: 'Light · $0.15/1M' },
      { id: 'openai/gpt-oss-20b:cheapest', label: 'GPT-OSS 20B (:cheapest)', badge: 'Fast · $0.14/1M' },
      { id: 'google/gemma-3-27b-it:cheapest', label: 'Gemma 3 27B IT (:cheapest)', badge: '27B · $0.16/1M' },
      { id: 'meta-llama/Llama-3.1-8B-Instruct:cheapest', label: 'Llama 3.1 8B Instruct (:cheapest)', badge: 'Cheapest · $0.05/1M' },
      { id: 'zai-org/GLM-4.7-Flash:cheapest', label: 'GLM 4.7 Flash (:cheapest)', badge: 'Flash · $0.40/1M' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct:cheapest', label: 'Llama 3.3 70B Instruct (:cheapest)', badge: '70B · $0.40/1M' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek API (DeepSeek V3 & R1)',
    freeTierNote: 'DeepSeek API key (sk-...) at platform.deepseek.com — DeepSeek V3 (deepseek-chat) & DeepSeek R1 (deepseek-reasoner)',
    keyPlaceholder: 'sk-...',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3)', badge: 'Coding · Tool Calling' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1)', badge: 'Deep Reasoning' },
    ],
  },
  {
    id: 'groq',
    label: 'Groq Cloud (Free Tier · Ultra-Fast LPU)',
    freeTierNote: 'Free high-speed API key at console.groq.com/keys',
    keyPlaceholder: 'gsk_...',
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', badge: 'Free · Coding' },
      { id: 'qwen/qwen3-32b', label: 'Qwen 3 32B', badge: 'Free · Reasoning' },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', badge: 'Free · Instant' },
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', badge: 'Free · 120B' },
    ],
  },
  {
    id: 'cerebras',
    label: 'Cerebras Inference (Free Tier)',
    freeTierNote: 'Free ultra-low-latency API key at cloud.cerebras.ai',
    keyPlaceholder: 'csk-...',
    models: [
      { id: 'llama-3.3-70b', label: 'Llama 3.3 70B', badge: 'Free · Fast' },
      { id: 'qwen-3-32b', label: 'Qwen 3 32B', badge: 'Free · Coding' },
      { id: 'llama3.1-8b', label: 'Llama 3.1 8B', badge: 'Free · Instant' },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral AI (Free Experiment Tier)',
    freeTierNote: 'Free API key & Codestral at console.mistral.ai',
    keyPlaceholder: 'mistral key...',
    models: [
      { id: 'codestral-latest', label: 'Codestral Latest', badge: 'Free · Coding' },
      { id: 'mistral-small-latest', label: 'Mistral Small Latest', badge: 'Free · Fast' },
      { id: 'devstral-small-latest', label: 'Devstral Small', badge: 'Free · Agents' },
    ],
  },
  {
    id: 'grok',
    label: 'xAI Grok',
    freeTierNote: 'xAI console API key',
    keyPlaceholder: 'xai-...',
    models: [
      { id: 'grok-2-latest', label: 'Grok 2 Latest', badge: 'Default' },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', badge: 'Fast' },
    ],
  },
  {
    id: 'custom',
    label: 'Custom Free OpenAI-Compatible API',
    freeTierNote: 'NVIDIA NIM, Together AI, Azure AI Foundry, Ollama, LM Studio, or any /v1/chat/completions endpoint (Note: GitHub Models was retired on July 30, 2026)',
    keyPlaceholder: 'Bearer / API Key...',
    defaultBaseUrl: 'http://localhost:11434/v1',
    models: [
      { id: 'qwen2.5-coder:32b', label: 'qwen2.5-coder:32b (Ollama / Custom)', badge: 'Custom' },
      { id: 'deepseek-r1', label: 'deepseek-r1', badge: 'Custom' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini', badge: 'Custom' },
    ],
  },
];

export function getProviderPreset(provider: ApiProviderId): ProviderPresetInfo {
  return PROVIDER_CATALOG.find(p => p.id === provider) || PROVIDER_CATALOG[0];
}

export function getProviderFreeDefaults(provider: ApiProviderId): { rpmLimit: number; tpmLimit: number } {
  switch (provider) {
    case 'gemini':
      return { rpmLimit: 15, tpmLimit: 250000 };
    case 'groq':
      return { rpmLimit: 30, tpmLimit: 6000 };
    case 'cerebras':
      return { rpmLimit: 30, tpmLimit: 60000 };
    case 'openrouter':
      return { rpmLimit: 20, tpmLimit: 40000 };
    case 'huggingface':
      return { rpmLimit: 20, tpmLimit: 40000 };
    case 'deepseek':
      return { rpmLimit: 30, tpmLimit: 100000 };
    case 'mistral':
      return { rpmLimit: 20, tpmLimit: 50000 };
    case 'grok':
      return { rpmLimit: 20, tpmLimit: 40000 };
    default:
      return { rpmLimit: 20, tpmLimit: 40000 };
  }
}

export function detectProviderFromApiKey(rawKey: string): ApiProviderId | null {
  const k = rawKey.trim();
  if (!k) return null;
  if (/^AIza[0-9A-Za-z_-]{20,}/.test(k) || /^AQ\.[0-9A-Za-z_.-]{15,}/.test(k)) return 'gemini';
  if (/^sk-or-v1-[0-9a-fA-F]{20,}/.test(k)) return 'openrouter';
  if (/^hf_[0-9A-Za-z_-]{16,}/.test(k)) return 'huggingface';
  if (/^sk-[0-9a-fA-F]{24,}$/.test(k)) return 'deepseek';
  if (/^gsk_[0-9A-Za-z_-]{20,}/.test(k)) return 'groq';
  if (/^csk-[0-9A-Za-z_-]{16,}/.test(k)) return 'cerebras';
  if (/^xai-[0-9A-Za-z_-]{16,}/.test(k)) return 'grok';
  if (/^(github_pat_|ghp_)[0-9A-Za-z_]{16,}/.test(k)) return 'custom';
  return null;
}

export function inferKeyRoleTier(model: string, explicit?: KeyRoleTier): Exclude<KeyRoleTier, 'auto'> {
  if (explicit && explicit !== 'auto') return explicit;
  const m = (model || '').toLowerCase();
  if (/(pro|hydrogen|argon|carbon|deepseek-r1|deepseek-reasoner|deepseek-v3|qwen3-coder|qwen2\.5-coder-32b|qwen2\.5-72b|480b|120b|70b|devstral|deepseek-chat|grok-3)/i.test(m)) {
    return 'architect';
  }
  if (/(flash-lite|8b|7b|9b|20b|instant|nemotron|flint|openrouter\/free|small-latest|small-3\.1)/i.test(m)) {
    return 'fast';
  }
  return 'builder';
}

const HF_REMOVED_MODEL_MAP: Record<string, string> = {
  'Qwen/Qwen2.5-Coder-32B-Instruct': 'Qwen/Qwen3-32B:cheapest',
  'Qwen/Qwen3-Coder-30B-A3B-Instruct': 'Qwen/Qwen3-32B:cheapest',
  'Qwen/Qwen2.5-7B-Instruct': 'Qwen/Qwen3.5-9B:cheapest',
};

const OPENROUTER_REMOVED_MODEL_MAP: Record<string, string> = {
  'google/gemini-2.0-flash-lite:free': 'cohere/north-mini-code:free',
  'qwen/qwen3-coder:free': 'cohere/north-mini-code:free',
  'deepseek/deepseek-r1:free': 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'deepseek/deepseek-chat-v3-0324:free': 'cohere/north-mini-code:free',
  'meta-llama/llama-3.3-70b-instruct:free': 'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-3-27b-it:free': 'google/gemma-4-31b-it:free',
  'mistralai/mistral-small-3.1-24b-instruct:free': 'nvidia/nemotron-3.5-lightning:free',
};

export function getLocalKeys(): KeyConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: KeyConfig[] = JSON.parse(raw);
    return parsed.map((k) => {
      if (k.provider === 'huggingface' && k.model) {
        const mapped = HF_REMOVED_MODEL_MAP[k.model] || (k.model.includes(':') ? k.model : `${k.model}:cheapest`);
        if (mapped !== k.model) return { ...k, model: mapped };
      }
      if (k.provider === 'openrouter' && k.model && OPENROUTER_REMOVED_MODEL_MAP[k.model]) {
        return { ...k, model: OPENROUTER_REMOVED_MODEL_MAP[k.model] };
      }
      return k;
    });
  } catch (err) {
    console.error('Failed to parse local API keys:', err);
    return [];
  }
}

export function saveLocalKeys(keys: KeyConfig[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    }).catch(() => {});
  } catch (err) {
    console.error('Failed to save local API keys:', err);
  }
}

export function addLocalKey(keyData: Partial<KeyConfig>): KeyConfig {
  const current = getLocalKeys();
  const provider = keyData.provider || 'gemini';
  const preset = getProviderPreset(provider);
  const defaults = getProviderFreeDefaults(provider);
  const newKey: KeyConfig = {
    id: `key_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    provider,
    name: keyData.name || `${provider.toUpperCase()} Free Key`,
    apiKey: (keyData.apiKey || '').trim(),
    model: (keyData.model || preset.models[0]?.id || 'gemini-3.8-flash').trim(),
    baseUrl: keyData.baseUrl?.trim() || preset.defaultBaseUrl,
    isActive: keyData.isActive !== false,
    rpmLimit: keyData.rpmLimit || defaults.rpmLimit,
    tpmLimit: keyData.tpmLimit || defaults.tpmLimit,
    roleTier: keyData.roleTier || 'auto',
    status: 'healthy',
  };
  current.push(newKey);
  saveLocalKeys(current);
  return newKey;
}

export function addLocalKeysBatch(
  items: Array<Partial<KeyConfig>>,
  labelPrefix?: string
): { added: KeyConfig[]; skippedDuplicates: number } {
  const current = getLocalKeys();
  const seen = new Set(current.map((k) => `${k.provider}::${(k.apiKey || '').trim()}`));
  const providerCounts = new Map<ApiProviderId, number>();
  for (const k of current) {
    providerCounts.set(k.provider, (providerCounts.get(k.provider) || 0) + 1);
  }

  const added: KeyConfig[] = [];
  let skippedDuplicates = 0;

  items.forEach((item, idx) => {
    const cleanApiKey = (item.apiKey || '').trim().replace(/^["']|["']$/g, '');
    if (!cleanApiKey) return;
    const provider = item.provider || detectProviderFromApiKey(cleanApiKey) || 'gemini';
    const dedupKey = `${provider}::${cleanApiKey}`;
    if (seen.has(dedupKey)) {
      skippedDuplicates++;
      return;
    }
    seen.add(dedupKey);
    const nextNum = (providerCounts.get(provider) || 0) + 1;
    providerCounts.set(provider, nextNum);

    const preset = getProviderPreset(provider);
    const defaults = getProviderFreeDefaults(provider);
    const model = (item.model || preset.models[0]?.id || 'gemini-3.8-flash').trim();
    const baseName = labelPrefix?.trim()
      ? `${labelPrefix.trim()} #${nextNum}`
      : item.name?.trim() || `${provider.toUpperCase()} #${nextNum}`;

    const newKey: KeyConfig = {
      id: `key_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
      provider,
      name: baseName,
      apiKey: cleanApiKey,
      model,
      baseUrl: item.baseUrl?.trim() || preset.defaultBaseUrl,
      isActive: item.isActive !== false,
      rpmLimit: item.rpmLimit || defaults.rpmLimit,
      tpmLimit: item.tpmLimit || defaults.tpmLimit,
      roleTier: item.roleTier || 'auto',
      status: 'healthy',
    };
    current.push(newKey);
    added.push(newKey);
  });

  if (added.length > 0) {
    saveLocalKeys(current);
  }
  return { added, skippedDuplicates };
}

export function updateLocalKey(id: string, patch: Partial<KeyConfig>): void {
  const current = getLocalKeys();
  const updated = current.map(k => k.id === id ? { ...k, ...patch } : k);
  saveLocalKeys(updated);
}

export function removeLocalKey(id: string): void {
  const current = getLocalKeys();
  const filtered = current.filter(k => k.id !== id);
  saveLocalKeys(filtered);
}

export function toggleKeyActive(id: string): void {
  const current = getLocalKeys();
  const updated = current.map(k => k.id === id ? { ...k, isActive: !k.isActive } : k);
  saveLocalKeys(updated);
}

export function getPreferOnlyCustomKeys(): boolean {
  try {
    return localStorage.getItem(FREE_ONLY_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setPreferOnlyCustomKeys(value: boolean): void {
  try {
    localStorage.setItem(FREE_ONLY_KEY, value ? 'true' : 'false');
  } catch {}
}

const STICKY_KEY_STORAGE = 'nexus_last_successful_key_id';

export function getLastSuccessfulKeyId(): string | null {
  try {
    return localStorage.getItem(STICKY_KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setLastSuccessfulKeyId(keyId: string | null): void {
  try {
    if (keyId) {
      localStorage.setItem(STICKY_KEY_STORAGE, keyId);
    } else {
      localStorage.removeItem(STICKY_KEY_STORAGE);
    }
  } catch {}
}
