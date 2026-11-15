import { ActionStep, KeyMetadata } from '../types/secrets';
import { getLocalKeys, getPreferOnlyCustomKeys, getLastSuccessfulKeyId, setLastSuccessfulKeyId } from './secretsManager';

export type { KeyMetadata };

export interface ChatAIOptions {
  selectedModel?: string;
  developerPersona?: string;
  customSystemInstruction?: string;
  outputFormat?: 'auto' | 'markdown' | 'json';
  multiAgent?: boolean;
  signal?: AbortSignal;
}

export interface PendingFirebaseSetupRequest {
  requestId: string;
  sessionId?: string;
  projectIdHint?: string;
  collections?: string[];
  reason?: string;
}

export type ChatJobStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface ChatJobSnapshot {
  id: string;
  sessionId: string;
  status: ChatJobStatus;
  startedAt: number;
  finishedAt?: number;
  lastSeq: number;
  latestText: string;
  latestImageUrl?: string;
  actionLog?: string;
  activityLogs: string[];
  actionSteps: ActionStep[];
  modifiedFiles: string[];
  keyInfo?: KeyMetadata;
  previewReady?: {
    url: string;
    html?: string;
    sessionId?: string;
    timestamp?: number;
  };
  pendingQuestion?: {
    questionId: string;
    questions: any[];
  } | null;
  pendingFirebaseSetup?: PendingFirebaseSetupRequest | null;
  error?: string;
  isAuthError?: boolean;
  activeKeyId?: string;
  model?: string;
}

export interface ChatStreamCallbacks {
  onUpdateText: (text: string, imageUrl?: string) => void;
  onAction: (action: string) => void;
  onRotateKey: (keyId: string, cooldownSec: number) => void;
  onPreviewReady: (url: string, html?: string, sessionId?: string) => void;
  onKeyInfo?: (keyInfo: KeyMetadata) => void;
  onActionStep?: (step: ActionStep) => void;
  onFileModified?: (file: { filePath: string; action?: string }) => void;
  onAskQuestion?: (payload: { questionId: string; questions: any[] }) => void;
  onFirebaseSetupRequest?: (payload: PendingFirebaseSetupRequest) => void;
  onCancelled?: (reason?: string) => void;
}

async function consumeChatSSEStream(
  response: Response,
  callbacks: ChatStreamCallbacks,
  defaultSessionId?: string,
  initialText: string = '',
  initialImageUrl?: string,
  signal?: AbortSignal
): Promise<'completed' | 'cancelled' | 'unsubscribed'> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming not supported or failed to obtain response stream reader.');
  }

  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedText = initialText;
  let latestImageUrl: string | undefined = initialImageUrl;

  try {
    while (true) {
      if (signal?.aborted) {
        return 'unsubscribed';
      }

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (readErr: any) {
        if (signal?.aborted || readErr?.name === 'AbortError') {
          return 'unsubscribed';
        }
        throw readErr;
      }

      const { done, value } = chunk;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.replace(/^data:\s*/, '');
        if (!jsonStr) continue;

        let event: any = null;
        try {
          event = JSON.parse(jsonStr);
        } catch (parseErr) {
          console.warn('Failed to parse SSE event data:', jsonStr, parseErr);
          continue;
        }

        switch (event.type) {
          case 'text':
            accumulatedText = event.text ?? '';
            callbacks.onUpdateText(accumulatedText, latestImageUrl);
            break;

          case 'image':
            latestImageUrl = event.imageUrl;
            callbacks.onUpdateText(accumulatedText, latestImageUrl);
            break;

          case 'action':
            if (event.action) {
              callbacks.onAction(event.action);
            }
            break;

          case 'action_step':
            if (event.step && callbacks.onActionStep) {
              callbacks.onActionStep({
                ...event.step,
                details: event.step.details || event.step.detail,
              });
            }
            break;

          case 'file_modified':
            if (event.filePath && callbacks.onFileModified) {
              callbacks.onFileModified({
                filePath: event.filePath,
                action: event.action,
              });
            }
            break;

          case 'ask_question':
            if (event.questionId && Array.isArray(event.questions) && callbacks.onAskQuestion) {
              callbacks.onAskQuestion({
                questionId: event.questionId,
                questions: event.questions,
              });
            }
            break;

          case 'firebase_setup_request':
            if (event.requestId && callbacks.onFirebaseSetupRequest) {
              callbacks.onFirebaseSetupRequest({
                requestId: event.requestId,
                sessionId: event.sessionId,
                projectIdHint: event.projectIdHint,
                collections: Array.isArray(event.collections) ? event.collections : [],
                reason: event.reason,
              });
            }
            break;

          case 'key_info':
            if (event.keyInfo && callbacks.onKeyInfo) {
              callbacks.onKeyInfo(event.keyInfo);
            }
            break;

          case 'key_active':
            if (callbacks.onKeyInfo) {
              callbacks.onKeyInfo({
                keyId: event.keyId,
                keyName: event.keyName,
                model: event.model,
                provider: event.provider,
                isCustomKey: event.isCustomKey,
              });
            }
            break;

          case 'preview_ready':
            if (event.url) {
              callbacks.onPreviewReady(event.url, event.html, event.sessionId || defaultSessionId);
            }
            break;

          case 'rotate_key':
          case 'key_cooldown':
            if (event.keyId) {
              callbacks.onRotateKey(event.keyId, event.cooldownSec || 60);
            }
            break;

          case 'cancelled':
            callbacks.onCancelled?.(event.reason);
            return 'cancelled';

          case 'error': {
            const serverErr: any = new Error(event.error || 'Server processing error');
            serverErr.isAuthError = Boolean(event.isAuthError);
            throw serverErr;
          }

          case 'done':
            if (typeof event.fullText === 'string' && event.fullText.length > 0 && event.fullText !== accumulatedText) {
              accumulatedText = event.fullText;
              callbacks.onUpdateText(accumulatedText, latestImageUrl);
            }
            if (event.activeKeyId || event.keyId) {
              setLastSuccessfulKeyId(event.activeKeyId || event.keyId);
            }
            return 'completed';
        }
      }
    }
    return 'completed';
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function startChatJob(params: {
  messages: any[];
  mode?: string;
  sessionId?: string;
  options?: ChatAIOptions;
  cancelPrevious?: boolean;
  cancelJobId?: string | null;
}): Promise<{
  jobId: string;
  sessionId: string;
  startedAt: number;
  status: ChatJobStatus;
  cancelledJobIds: string[];
}> {
  const localKeys = getLocalKeys().filter(k => k.isActive);
  const preferOnlyCustomKeys = getPreferOnlyCustomKeys();
  const stickyKeyId = getLastSuccessfulKeyId();

  const response = await fetch('/api/gemini/jobs/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: params.messages,
      mode: params.mode || 'coding',
      sessionId: params.sessionId,
      userKeys: localKeys,
      keys: localKeys,
      preferOnlyCustomKeys,
      stickyKeyId,
      selectedModel: params.options?.selectedModel,
      developerPersona: params.options?.developerPersona,
      customSystemInstruction: params.options?.customSystemInstruction,
      outputFormat: params.options?.outputFormat,
      multiAgent: params.options?.multiAgent,
      cancelPrevious: params.cancelPrevious !== false,
      cancelJobId: params.cancelJobId || undefined,
    }),
  });

  if (!response.ok) {
    let errorMsg = `Server error ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }

  return response.json();
}

export async function streamChatJob(
  jobId: string,
  callbacks: ChatStreamCallbacks,
  opts?: {
    afterSeq?: number;
    signal?: AbortSignal;
    sessionId?: string;
    initialText?: string;
    initialImageUrl?: string;
  }
): Promise<'completed' | 'cancelled' | 'unsubscribed'> {
  const after = opts?.afterSeq ?? -1;
  let response: Response;
  try {
    response = await fetch(`/api/gemini/jobs/${encodeURIComponent(jobId)}/stream?after=${encodeURIComponent(String(after))}`, {
      method: 'GET',
      signal: opts?.signal,
    });
  } catch (err: any) {
    if (opts?.signal?.aborted || err?.name === 'AbortError') {
      return 'unsubscribed';
    }
    throw err;
  }

  if (!response.ok) {
    let errorMsg = `Server error ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }

  return consumeChatSSEStream(
    response,
    callbacks,
    opts?.sessionId,
    opts?.initialText || '',
    opts?.initialImageUrl,
    opts?.signal
  );
}

export async function fetchActiveChatJob(
  sessionId?: string,
  jobId?: string
): Promise<ChatJobSnapshot | null> {
  const qs = new URLSearchParams();
  if (sessionId) qs.set('sessionId', sessionId);
  if (jobId) qs.set('jobId', jobId);
  const res = await fetch(`/api/gemini/jobs/active?${qs.toString()}`);
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({ job: null }));
  return data?.job || null;
}

export async function cancelChatJob(
  jobId?: string | null,
  sessionId?: string | null,
  reason?: string
): Promise<{ cancelledIds: string[] }> {
  const res = await fetch('/api/gemini/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: jobId || undefined,
      sessionId: sessionId || undefined,
      reason: reason || 'Cancelled by user',
    }),
  });
  if (!res.ok) return { cancelledIds: [] };
  const data = await res.json().catch(() => ({ cancelledIds: [] }));
  return { cancelledIds: Array.isArray(data?.cancelledIds) ? data.cancelledIds : [] };
}

export async function chatWithAI(
  messages: any[],
  onUpdateText: (text: string, imageUrl?: string) => void,
  onAction: (action: string) => void,
  mode: string = 'coding',
  onRotateKey: (keyId: string, cooldownSec: number) => void,
  onPreviewReady: (url: string, html?: string, sessionId?: string) => void,
  sessionId?: string,
  onKeyInfo?: (keyInfo: KeyMetadata) => void,
  onActionStep?: (step: ActionStep) => void,
  options?: ChatAIOptions,
  onFileModified?: (file: { filePath: string; action?: string }) => void,
  onAskQuestion?: (payload: { questionId: string; questions: any[] }) => void,
  onFirebaseSetupRequest?: (payload: PendingFirebaseSetupRequest) => void,
  onCancelled?: (reason?: string) => void
): Promise<void> {
  const localKeys = getLocalKeys().filter(k => k.isActive);
  const preferOnlyCustomKeys = getPreferOnlyCustomKeys();
  const stickyKeyId = getLastSuccessfulKeyId();

  let response: Response;
  try {
    response = await fetch('/api/gemini/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: options?.signal,
      body: JSON.stringify({
        messages,
        mode,
        sessionId,
        userKeys: localKeys,
        keys: localKeys,
        preferOnlyCustomKeys,
        stickyKeyId,
        selectedModel: options?.selectedModel,
        developerPersona: options?.developerPersona,
        customSystemInstruction: options?.customSystemInstruction,
        outputFormat: options?.outputFormat,
        multiAgent: options?.multiAgent,
      }),
    });
  } catch (err: any) {
    if (options?.signal?.aborted || err?.name === 'AbortError') {
      onCancelled?.('Request aborted');
      return;
    }
    throw err;
  }

  if (!response.ok) {
    let errorMsg = `Server error ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }

  await consumeChatSSEStream(
    response,
    {
      onUpdateText,
      onAction,
      onRotateKey,
      onPreviewReady,
      onKeyInfo,
      onActionStep,
      onFileModified,
      onAskQuestion,
      onFirebaseSetupRequest,
      onCancelled,
    },
    sessionId,
    '',
    undefined,
    options?.signal
  );
}
