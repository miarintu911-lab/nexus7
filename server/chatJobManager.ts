import type { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import {
  executeOrchestratedChat,
  JobCancelledError,
  type OrchestratedChatRequest,
} from './apiOrchestrator.ts';

export type ChatJobStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface ChatJobEvent {
  seq: number;
  data: any;
}

export interface ChatJobSnapshot {
  id: string;
  sessionId: string;
  status: ChatJobStatus;
  startedAt: number;
  finishedAt?: number;
  lastSeq: number;
  latestText: string;
  latestImageUrl?: string;
  latestVideoUrl?: string;
  actionLog?: string;
  activityLogs: string[];
  actionSteps: any[];
  modifiedFiles: string[];
  keyInfo?: any;
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
  pendingFirebaseSetup?: {
    requestId: string;
    sessionId?: string;
    projectIdHint?: string;
    collections?: string[];
    reason?: string;
  } | null;
  error?: string;
  isAuthError?: boolean;
  activeKeyId?: string;
  model?: string;
}

interface ChatJobInternal extends ChatJobSnapshot {
  events: ChatJobEvent[];
  abortController?: AbortController;
  subscribers?: Set<(seq: number, data: any) => void>;
  runPromise?: Promise<void>;
}

const JOBS_FILE_PATH = path.resolve(process.cwd(), '.nexus_jobs.json');
const MAX_PERSISTED_JOBS = 30;
const FINISHED_JOB_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_EVENTS_PER_JOB = 250;

const jobsMap = new Map<string, ChatJobInternal>();
let loadPromise: Promise<void> | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let persistInFlight: Promise<void> | null = null;

function pruneAndSerializeJobs(): ChatJobInternal[] {
  const now = Date.now();
  const entries = Array.from(jobsMap.values()).filter((job) => {
    if (job.status === 'running') return true;
    const finishedAt = job.finishedAt || job.startedAt;
    return now - finishedAt < FINISHED_JOB_TTL_MS;
  });

  entries.sort((a, b) => b.startedAt - a.startedAt);
  const kept = entries.slice(0, MAX_PERSISTED_JOBS);

  // Sync pruning back to memory map
  const keptIds = new Set(kept.map((j) => j.id));
  for (const id of jobsMap.keys()) {
    if (!keptIds.has(id)) {
      jobsMap.delete(id);
    }
  }

  return kept.map((job) => ({
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSeq: job.lastSeq,
    latestText: job.latestText,
    latestImageUrl: job.latestImageUrl,
    latestVideoUrl: job.latestVideoUrl,
    actionLog: job.actionLog,
    activityLogs: job.activityLogs.slice(-150),
    actionSteps: job.actionSteps.slice(-100),
    modifiedFiles: job.modifiedFiles.slice(-100),
    keyInfo: job.keyInfo,
    previewReady: job.previewReady,
    pendingQuestion: job.status === 'running' ? job.pendingQuestion : null,
    pendingFirebaseSetup: job.status === 'running' ? job.pendingFirebaseSetup : null,
    error: job.error,
    isAuthError: job.isAuthError,
    activeKeyId: job.activeKeyId,
    model: job.model,
    events: job.events.slice(-MAX_EVENTS_PER_JOB).map((ev) => {
      // Avoid duplicating huge raw HTML snapshots in persisted event log if already saved on job.previewReady
      if (ev.data?.type === 'preview_ready' && ev.data?.html && job.status !== 'running') {
        const { html: _omitHtml, ...rest } = ev.data;
        return { seq: ev.seq, data: rest };
      }
      return ev;
    }),
  }));
}

async function flushJobsToDisk(): Promise<void> {
  if (persistInFlight) {
    await persistInFlight;
    return;
  }
  persistInFlight = (async () => {
    try {
      const payload = pruneAndSerializeJobs();
      const tmpPath = `${JOBS_FILE_PATH}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      await fs.rename(tmpPath, JOBS_FILE_PATH);
    } catch (err) {
      console.warn('[ChatJobManager] Failed to persist jobs:', err);
    } finally {
      persistInFlight = null;
    }
  })();
  await persistInFlight;
}

function schedulePersist(immediate = false): void {
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    void flushJobsToDisk();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushJobsToDisk();
  }, 450);
}

export async function ensureJobsLoaded(): Promise<void> {
  if (loadPromise) {
    await loadPromise;
    return;
  }
  loadPromise = (async () => {
    try {
      const raw = await fs.readFile(JOBS_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        let recoveredStale = false;
        const now = Date.now();
        for (const item of parsed) {
          if (!item || !item.id) continue;
          const job: ChatJobInternal = {
            id: String(item.id),
            sessionId: String(item.sessionId || 'default'),
            status: item.status === 'running' ? 'error' : (item.status || 'error'),
            startedAt: Number(item.startedAt) || now,
            finishedAt: item.status === 'running' ? now : item.finishedAt,
            lastSeq: Number(item.lastSeq) || 0,
            latestText: typeof item.latestText === 'string' ? item.latestText : '',
            latestImageUrl: item.latestImageUrl,
            latestVideoUrl: item.latestVideoUrl,
            actionLog: item.actionLog,
            activityLogs: Array.isArray(item.activityLogs) ? item.activityLogs : [],
            actionSteps: Array.isArray(item.actionSteps) ? item.actionSteps : [],
            modifiedFiles: Array.isArray(item.modifiedFiles) ? item.modifiedFiles : [],
            keyInfo: item.keyInfo,
            previewReady: item.previewReady,
            pendingQuestion: null,
            pendingFirebaseSetup: null,
            error:
              item.status === 'running'
                ? 'Server restarted while task was in progress.'
                : item.error,
            isAuthError: Boolean(item.isAuthError),
            activeKeyId: item.activeKeyId,
            model: item.model,
            events: Array.isArray(item.events) ? item.events : [],
          };
          if (item.status === 'running') {
            recoveredStale = true;
          }
          jobsMap.set(job.id, job);
        }
        if (recoveredStale) {
          schedulePersist(true);
        }
      }
    } catch {
      // File may not exist on first run
    }
  })();
  await loadPromise;
}

function toSnapshot(job: ChatJobInternal): ChatJobSnapshot {
  return {
    id: job.id,
    sessionId: job.sessionId,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSeq: job.lastSeq,
    latestText: job.latestText,
    latestImageUrl: job.latestImageUrl,
    latestVideoUrl: job.latestVideoUrl,
    actionLog: job.actionLog,
    activityLogs: [...job.activityLogs],
    actionSteps: [...job.actionSteps],
    modifiedFiles: [...job.modifiedFiles],
    keyInfo: job.keyInfo,
    previewReady: job.previewReady,
    pendingQuestion: job.pendingQuestion ?? null,
    pendingFirebaseSetup: job.pendingFirebaseSetup ?? null,
    error: job.error,
    isAuthError: job.isAuthError,
    activeKeyId: job.activeKeyId,
    model: job.model,
  };
}

function recordAndBroadcastEvent(job: ChatJobInternal, data: any): void {
  if (!data || typeof data !== 'object') return;
  // Ignore stray non-terminal events once a job has already been cancelled/finished
  if (
    job.status !== 'running' &&
    data.type !== 'cancelled' &&
    data.type !== 'done' &&
    data.type !== 'error'
  ) {
    return;
  }

  const seq = job.lastSeq + 1;
  job.lastSeq = seq;
  const enrichedData = { ...data, seq };

  // Coalesce consecutive text snapshots in replay buffer so long streams don't bloat disk/memory
  const prevEv = job.events[job.events.length - 1];
  if (data.type === 'text' && prevEv?.data?.type === 'text') {
    job.events[job.events.length - 1] = { seq, data: enrichedData };
  } else {
    job.events.push({ seq, data: enrichedData });
    if (job.events.length > MAX_EVENTS_PER_JOB) {
      job.events.splice(0, job.events.length - MAX_EVENTS_PER_JOB);
    }
  }

  let shouldPersistImmediately = false;

  switch (data.type) {
    case 'text':
      if (typeof data.text === 'string') {
        job.latestText = data.text;
      }
      break;

    case 'image':
      if (data.imageUrl) {
        job.latestImageUrl = data.imageUrl;
      }
      break;

    case 'video':
      if (data.videoUrl) {
        job.latestVideoUrl = data.videoUrl;
        shouldPersistImmediately = true;
      }
      break;

    case 'action':
      if (data.action) {
        job.actionLog = data.action;
        if (job.activityLogs[job.activityLogs.length - 1] !== data.action) {
          job.activityLogs.push(data.action);
          if (job.activityLogs.length > 200) {
            job.activityLogs.shift();
          }
        }
      }
      break;

    case 'action_step':
      if (data.step) {
        const normalizedStep = {
          ...data.step,
          details: data.step.details || data.step.detail,
        };
        const idx = job.actionSteps.findIndex((s) => s.id === normalizedStep.id);
        if (idx >= 0) {
          job.actionSteps[idx] = { ...job.actionSteps[idx], ...normalizedStep };
        } else {
          job.actionSteps.push(normalizedStep);
        }
      }
      break;

    case 'file_modified':
      if (data.filePath && !job.modifiedFiles.includes(data.filePath)) {
        job.modifiedFiles.push(data.filePath);
      }
      break;

    case 'ask_question':
      if (data.questionId && Array.isArray(data.questions)) {
        job.pendingQuestion = {
          questionId: data.questionId,
          questions: data.questions,
        };
        shouldPersistImmediately = true;
      }
      break;

    case 'firebase_setup_request':
      if (data.requestId) {
        job.pendingFirebaseSetup = {
          requestId: data.requestId,
          sessionId: data.sessionId || job.sessionId,
          projectIdHint: data.projectIdHint,
          collections: Array.isArray(data.collections) ? data.collections : [],
          reason: data.reason,
        };
        shouldPersistImmediately = true;
      }
      break;

    case 'key_info':
      if (data.keyInfo) {
        job.keyInfo = data.keyInfo;
      }
      break;

    case 'key_active':
      job.keyInfo = {
        keyId: data.keyId,
        keyName: data.keyName,
        model: data.model,
        provider: data.provider,
        isCustomKey: data.isCustomKey,
      };
      job.activeKeyId = data.keyId;
      job.model = data.model;
      break;

    case 'preview_ready':
      if (data.url) {
        job.previewReady = {
          url: data.url,
          html: data.html,
          sessionId: data.sessionId || job.sessionId,
          timestamp: data.timestamp || Date.now(),
        };
        shouldPersistImmediately = true;
      }
      break;

    case 'done':
      if (typeof data.fullText === 'string' && data.fullText.length > 0) {
        job.latestText = data.fullText;
      }
      job.activeKeyId = data.activeKeyId || data.keyId || job.activeKeyId;
      job.model = data.model || job.model;
      job.pendingQuestion = null;
      job.pendingFirebaseSetup = null;
      job.status = 'completed';
      job.finishedAt = Date.now();
      shouldPersistImmediately = true;
      break;

    case 'error':
      job.error = data.error || 'Server processing error';
      job.isAuthError = Boolean(data.isAuthError);
      job.pendingQuestion = null;
      job.pendingFirebaseSetup = null;
      job.status = 'error';
      job.finishedAt = Date.now();
      shouldPersistImmediately = true;
      break;

    case 'cancelled':
      job.pendingQuestion = null;
      job.pendingFirebaseSetup = null;
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      shouldPersistImmediately = true;
      break;
  }

  if (job.subscribers && job.subscribers.size > 0) {
    for (const notify of Array.from(job.subscribers)) {
      try {
        notify(seq, enrichedData);
      } catch {}
    }
  }

  schedulePersist(shouldPersistImmediately);
}

export async function startChatJob(
  payload: OrchestratedChatRequest & {
    cancelPrevious?: boolean;
    cancelJobId?: string | null;
  }
): Promise<{
  jobId: string;
  sessionId: string;
  startedAt: number;
  status: ChatJobStatus;
  cancelledJobIds: string[];
}> {
  await ensureJobsLoaded();

  const sessionId = String(payload.sessionId || 'default');
  const cancelPrevious = payload.cancelPrevious !== false;
  const cancelledJobIds: string[] = [];

  if (payload.cancelJobId) {
    const res = await cancelChatJob(payload.cancelJobId, undefined, 'Superseded by new request');
    cancelledJobIds.push(...res.cancelledIds);
  }
  if (cancelPrevious) {
    const res = await cancelChatJob(undefined, sessionId, 'Superseded by new request');
    for (const cid of res.cancelledIds) {
      if (!cancelledJobIds.includes(cid)) cancelledJobIds.push(cid);
    }
  }

  const startedAt = Date.now();
  const jobId = `job_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();

  const job: ChatJobInternal = {
    id: jobId,
    sessionId,
    status: 'running',
    startedAt,
    lastSeq: 0,
    latestText: '',
    activityLogs: [],
    actionSteps: [],
    modifiedFiles: [],
    pendingQuestion: null,
    pendingFirebaseSetup: null,
    events: [],
    abortController,
    subscribers: new Set(),
  };

  jobsMap.set(jobId, job);
  schedulePersist(true);

  const runPromise = (async () => {
    try {
      const result = await executeOrchestratedChat(payload, {
        sendEvent: (ev) => {
          // If job was already cancelled externally, avoid emitting non-cancelled events
          if (abortController.signal.aborted && ev?.type !== 'cancelled') return;
          recordAndBroadcastEvent(job, ev);
        },
        signal: abortController.signal,
      });

      if (job.status === 'running') {
        if (result.status === 'cancelled' || abortController.signal.aborted) {
          recordAndBroadcastEvent(job, { type: 'cancelled', reason: 'Request cancelled' });
        } else if (result.status === 'error') {
          recordAndBroadcastEvent(job, {
            type: 'error',
            error: job.error || 'Request failed without error details.',
          });
        } else {
          recordAndBroadcastEvent(job, {
            type: 'done',
            fullText: job.latestText,
          });
        }
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        if (job.status === 'running') {
          recordAndBroadcastEvent(job, { type: 'cancelled', reason: 'Request cancelled' });
        }
      } else if (job.status === 'running') {
        recordAndBroadcastEvent(job, {
          type: 'error',
          error: String(err?.message || err || 'Internal job execution error'),
        });
      }
    }
  })();

  job.runPromise = runPromise;

  return {
    jobId,
    sessionId,
    startedAt,
    status: job.status,
    cancelledJobIds,
  };
}

export async function cancelChatJob(
  jobId?: string | null,
  sessionId?: string | null,
  reason: string = 'Cancelled by user'
): Promise<{ cancelledIds: string[] }> {
  await ensureJobsLoaded();

  const targets: ChatJobInternal[] = [];
  if (jobId) {
    const exact = jobsMap.get(jobId);
    if (exact && exact.status === 'running') {
      targets.push(exact);
    }
  }
  if (sessionId) {
    for (const job of jobsMap.values()) {
      if (job.sessionId === sessionId && job.status === 'running' && !targets.includes(job)) {
        targets.push(job);
      }
    }
  }

  const cancelledIds: string[] = [];
  for (const job of targets) {
    cancelledIds.push(job.id);
    if (job.abortController && !job.abortController.signal.aborted) {
      job.abortController.abort(new JobCancelledError(reason));
    }
    if (job.status === 'running') {
      recordAndBroadcastEvent(job, { type: 'cancelled', reason });
    }
    if (job.runPromise) {
      await Promise.race([
        job.runPromise.catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
    }
  }

  return { cancelledIds };
}

export function clearPendingQuestionInJobs(questionId: string): void {
  if (!questionId) return;
  let dirty = false;
  for (const job of jobsMap.values()) {
    if (job.pendingQuestion?.questionId === questionId) {
      job.pendingQuestion = null;
      dirty = true;
    }
  }
  if (dirty) schedulePersist(true);
}

export function clearPendingFirebaseInJobs(requestId: string): void {
  if (!requestId) return;
  let dirty = false;
  for (const job of jobsMap.values()) {
    if (job.pendingFirebaseSetup?.requestId === requestId) {
      job.pendingFirebaseSetup = null;
      dirty = true;
    }
  }
  if (dirty) schedulePersist(true);
}

export async function getJobSnapshot(params: {
  jobId?: string | null;
  sessionId?: string | null;
}): Promise<ChatJobSnapshot | null> {
  await ensureJobsLoaded();

  const { jobId, sessionId } = params;

  if (jobId) {
    const exact = jobsMap.get(jobId);
    if (exact) return toSnapshot(exact);
  }

  if (sessionId) {
    const sessionJobs = Array.from(jobsMap.values()).filter((j) => j.sessionId === sessionId);
    const running = sessionJobs.find((j) => j.status === 'running');
    if (running) return toSnapshot(running);
    sessionJobs.sort((a, b) => b.startedAt - a.startedAt);
    if (sessionJobs[0]) return toSnapshot(sessionJobs[0]);
    return null;
  }

  const anyRunning = Array.from(jobsMap.values()).find((j) => j.status === 'running');
  return anyRunning ? toSnapshot(anyRunning) : null;
}

export async function subscribeToJobSSE(
  jobId: string,
  afterSeq: number,
  _req: Request,
  res: Response
): Promise<void> {
  await ensureJobsLoaded();

  const job = jobsMap.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  const writeSse = (data: any) => {
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {}
    }
  };

  let lastSentSeq = Number.isFinite(afterSeq) ? afterSeq : -1;

  // Replay buffered events newer than afterSeq
  for (const ev of job.events) {
    if (ev.seq > lastSentSeq) {
      writeSse(ev.data);
      lastSentSeq = ev.seq;
    }
  }

  // If the job is already terminal, ensure final state is emitted & close stream cleanly
  if (job.status !== 'running') {
    const hasTerminal = job.events.some(
      (ev) => ev.seq <= lastSentSeq && (ev.data?.type === 'done' || ev.data?.type === 'error' || ev.data?.type === 'cancelled')
    );
    if (!hasTerminal) {
      if (job.status === 'completed') {
        writeSse({ type: 'done', fullText: job.latestText, activeKeyId: job.activeKeyId, model: job.model, seq: job.lastSeq });
      } else if (job.status === 'error') {
        writeSse({ type: 'error', error: job.error || 'Task failed', isAuthError: job.isAuthError, seq: job.lastSeq });
      } else if (job.status === 'cancelled') {
        writeSse({ type: 'cancelled', reason: 'Request cancelled', seq: job.lastSeq });
      }
    }
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  if (!job.subscribers) {
    job.subscribers = new Set();
  }

  let closed = false;
  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      try {
        res.write(': keepalive\n\n');
      } catch {}
    }
  }, 12000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    job.subscribers?.delete(listener);
  };

  const listener = (seq: number, data: any) => {
    if (closed) return;
    if (seq <= lastSentSeq) return;
    lastSentSeq = seq;
    writeSse(data);

    if (data?.type === 'done' || data?.type === 'error' || data?.type === 'cancelled') {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  job.subscribers.add(listener);

  // IMPORTANT: Browser closing / refreshing ONLY unsubscribes this SSE client; it NEVER cancels the server job!
  res.once('close', () => {
    cleanup();
  });
}
