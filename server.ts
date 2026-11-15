import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import cors from 'cors';
import dotenv from 'dotenv';
import { Octokit } from 'octokit';
import AdmZip from 'adm-zip';
import {
  handleServerGeminiChat,
  executeServerTool,
  manageBackgroundTask,
  runCodeInSandbox,
  runDebugErrorAnalysis,
  runClawDoctor,
  getClawStatus,
  getClawAcpInfo,
  runClawPrompt,
  runOmoCoordinate,
  runOmxProtocol,
  routeClawHipEvent,
  runLazyCodex,
  serverTools
} from './server/geminiService.ts';
import { CODING_SKILLS_REGISTRY, getSkillByName } from './server/skillsRegistry.ts';
import { 
  handleOrchestratedChat, 
  resolvePendingQuestion,
  resolvePendingFirebaseSetup,
  loadSecrets, 
  saveSecrets, 
  testApiKey, 
  fetchLiveProviderModels,
  getKeyPoolStatus,
  getLastSuccessfulKeyId,
  getSystemLogs,
  clearSystemLogs
} from './server/apiOrchestrator.ts';
import {
  ensureJobsLoaded,
  startChatJob,
  cancelChatJob,
  getJobSnapshot,
  subscribeToJobSSE,
  clearPendingQuestionInJobs,
  clearPendingFirebaseInJobs,
} from './server/chatJobManager.ts';
import {
  verifyLivePreviewWithDom,
  freeWebSearch,
  createCheckpoint,
  listCheckpoints,
  rollbackToCheckpoint,
  buildCodebaseGraph,
  runAutomatedTests,
  listScheduledTasks,
  cancelScheduledTask,
} from './server/workspaceEngine.ts';
import {
  initSessionWorkspace,
  startWorkspaceServer,
  stopWorkspaceServer,
  buildWorkspaceToStaticPreview,
  getWorkspaceStatus,
  handleWorkspaceProxyRequest,
  sanitizeSessionId,
  installPackagesInTarget,
} from './server/sandboxManager.ts';
import { rankAstContext } from './server/astContextRanker.ts';
import { initPersistenceStore, getPersistenceStatus, saveSecretsToPersistence } from './server/persistenceStore.ts';
import { runVisualQaReview } from './server/visualQa.ts';
import {
  inspectSessionProject,
  deploySessionToGitHubPages,
  getGitHubPagesBuildStatus,
} from './server/githubPagesDeployer.ts';
import {
  auditFirestoreRules,
  deployRulesToFirebaseCloud,
  generateRulesFromBlueprint,
  isPlaceholderValue,
  loadFirebaseProfile,
  parseFirebaseConfigInput,
  provisionFirebaseForTarget,
  resolveFirebaseTargetDir,
  sanitizeFirebaseSessionId,
  saveFirebaseProfile,
  testFirebaseAdminConnection,
} from './server/firebaseProvisioner.ts';

dotenv.config();

const execPromise = promisify(exec);

function resolvePort(): number {
  const portFlagIdx = process.argv.findIndex((arg) => arg === '--port' || arg === '-p');
  if (portFlagIdx !== -1 && process.argv[portFlagIdx + 1]) {
    const parsed = Number(process.argv[portFlagIdx + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  const eqFlag = process.argv.find((arg) => arg.startsWith('--port='));
  if (eqFlag) {
    const parsed = Number(eqFlag.split('=')[1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT) || 3000;
}

function resolveWorkspacePath(rawPath: string): { absolutePath: string; allowed: boolean } {
  const clean = String(rawPath || '.').trim().replace(/^[/\\]+/, '') || '.';
  const absolutePath = path.resolve(process.cwd(), clean);
  return { absolutePath, allowed: absolutePath.startsWith(process.cwd()) };
}

process.on('unhandledRejection', (reason) => {
  console.warn('[Server] Unhandled Promise Rejection prevented crash:', reason);
});

process.on('uncaughtException', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error('[Server] Port already in use:', err?.message);
    process.exit(1);
  }
  console.warn('[Server] Uncaught Exception prevented crash:', err?.message || err);
});

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);
  const PORT = resolvePort();

  await fs.mkdir(path.join(process.cwd(), 'projects'), { recursive: true }).catch(() => {});
  await fs.mkdir(path.join(process.cwd(), 'workspaces'), { recursive: true }).catch(() => {});
  await fs.mkdir(path.join(process.cwd(), 'public', 'generated'), { recursive: true }).catch(() => {});
  void initPersistenceStore().catch((err) => {
    console.warn('[Server] Background persistence init skipped:', err?.message || err);
  });
  void ensureJobsLoaded().catch((err) => {
    console.warn('[Server] Background job recovery skipped:', err?.message || err);
  });

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Render / Cloud health check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      timestamp: Date.now(),
    });
  });

  // Serve generated images statically
  app.use('/generated', express.static(path.join(process.cwd(), 'public', 'generated')));

  // Handle /projects requests: redirect workspace sessions, guard against 0-byte HTML files, and delegate valid assets to static
  app.get(['/projects', '/projects/*'], async (req, res, next) => {
    const rawParam = (req.params as any)[0] || '';
    const cleanParam = rawParam.replace(/^\/+/, '');
    const requestedFile = cleanParam || 'index.html';
    const firstSegment = cleanParam.split('/')[0] || '';
    const isSessionRequest = firstSegment.startsWith('session_');

    let filePath = path.join(process.cwd(), 'projects', requestedFile);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (requestedFile.endsWith('.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    } else if (requestedFile.endsWith('.webmanifest') || requestedFile.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }

    // If a static production build exists in projects/<sessionId>/index.html, serve it directly;
    // otherwise redirect workspace sessions seamlessly to /w/:sessionId/
    if (isSessionRequest) {
      const safeSessId = firstSegment.replace(/[^a-zA-Z0-9_-]/g, '_');
      const staticIndex = path.join(process.cwd(), 'projects', safeSessId, 'index.html');
      const hasStaticBuild = await fs.access(staticIndex).then(() => true).catch(() => false);
      if (!hasStaticBuild) {
        const wsDir = path.join(process.cwd(), 'workspaces', safeSessId);
        const hasWorkspace = await fs.access(wsDir).then(() => true).catch(() => false);
        if (hasWorkspace) {
          return res.redirect(302, `/w/${safeSessId}/`);
        }
      }
    }

    try {
      let stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        stat = await fs.stat(filePath);
      }
      const isHtmlTarget = filePath.endsWith('.html') || filePath.endsWith('.htm');
      if (isHtmlTarget ? stat.size > 20 : stat.size > 0) {
        return next();
      }
    } catch {
      // SPA client-side route fallback for built session apps under /projects/<sessionId>/...
      if (isSessionRequest && !path.extname(requestedFile)) {
        const safeSessId = firstSegment.replace(/[^a-zA-Z0-9_-]/g, '_');
        const spaIndex = path.join(process.cwd(), 'projects', safeSessId, 'index.html');
        const spaStat = await fs.stat(spaIndex).catch(() => null);
        if (spaStat && spaStat.size > 20) {
          return res.sendFile(spaIndex);
        }
      }
    }

    // Only fall back to global projects/index.html when /projects or /projects/index.html itself was requested
    if (!isSessionRequest && (requestedFile === 'index.html' || cleanParam === '')) {
      try {
        const fallbackPath = path.join(process.cwd(), 'projects', 'index.html');
        const fbStat = await fs.stat(fallbackPath);
        if (fbStat.size > 20) {
          return res.sendFile(fallbackPath);
        }
      } catch {}
    }

    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-3xl p-8 text-center shadow-2xl">
    <div class="w-14 h-14 bg-indigo-600/20 border border-indigo-500/30 rounded-2xl flex items-center justify-center mx-auto mb-4 text-indigo-400">
      <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
    </div>
    <h2 class="text-xl font-bold text-white mb-2">Live Canvas Ready</h2>
    <p class="text-slate-400 text-xs leading-relaxed mb-4">${isSessionRequest ? 'এই চ্যাটের জন্য এখনো কোনো লাইভ ওয়েবসাইট বা প্রিভিউ ফাইল তৈরি হয়নি। চ্যাটে কোনো অ্যাপ বা ওয়েবসাইট বানাতে বলুন।' : 'Nexus AI is ready. Request any design or website to see it live.'}</p>
    <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 text-xs font-semibold">
      <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
      Workspace Online
    </div>
  </div>
</body>
</html>`);
  });

  // Serve generated projects statically with PWA headers
  app.use('/projects', express.static(path.join(process.cwd(), 'projects'), {
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      if (filePath.endsWith('.js')) {
        res.setHeader('Service-Worker-Allowed', '/');
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      } else if (filePath.endsWith('.webmanifest') || filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      }
    }
  }));

  // Reverse proxy & static serving for isolated per-session sandbox workspaces (/w/:sessionId/*)
  app.use('/w/:sessionId', handleWorkspaceProxyRequest);

  // Server-side Multi-Provider Orchestrated Streaming Chat endpoint
  app.post('/api/gemini/chat', async (req, res) => {
    try {
      await handleOrchestratedChat(req.body, res);
    } catch (err: any) {
      console.error("Orchestrated chat error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || "Failed to process chat" });
      }
    }
  });

  // Detached background chat job endpoints (survive page reload, support Cancel-on-Send & SSE replay)
  app.post('/api/gemini/jobs/start', async (req, res) => {
    try {
      const result = await startChatJob(req.body || {});
      res.json(result);
    } catch (err: any) {
      console.error('Failed to start chat job:', err);
      res.status(500).json({ error: err.message || 'Failed to start chat job' });
    }
  });

  app.get('/api/gemini/jobs/active', async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
      const job = await getJobSnapshot({ sessionId, jobId });
      res.json({ job });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to inspect active job' });
    }
  });

  app.get('/api/gemini/jobs/:jobId/stream', async (req, res) => {
    try {
      const afterSeq = req.query.after !== undefined ? Number(req.query.after) : -1;
      await subscribeToJobSSE(req.params.jobId, afterSeq, req, res);
    } catch (err: any) {
      console.error('Failed to stream chat job:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Failed to stream chat job' });
      }
    }
  });

  app.post('/api/gemini/jobs/:jobId/cancel', async (req, res) => {
    try {
      const result = await cancelChatJob(req.params.jobId, undefined, req.body?.reason || 'Cancelled by user');
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to cancel chat job' });
    }
  });

  app.post('/api/gemini/cancel', async (req, res) => {
    try {
      const { jobId, sessionId, reason } = req.body || {};
      const result = await cancelChatJob(jobId, sessionId, reason || 'Cancelled by user');
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to cancel chat job' });
    }
  });

  // Resume a paused ask_question tool call with user answers
  app.post('/api/gemini/answer-question', (req, res) => {
    const { questionId, answers, skipped, notes } = req.body || {};
    if (!questionId || typeof questionId !== 'string') {
      return res.status(400).json({ success: false, error: 'questionId is required' });
    }
    clearPendingQuestionInJobs(questionId);
    const resolved = resolvePendingQuestion(questionId, { answers, skipped, notes });
    if (!resolved) {
      return res.status(404).json({ success: false, error: 'Question session expired or not found' });
    }
    res.json({ success: true });
  });

  // Resume a paused set_up_firebase tool call with user credentials or scaffold confirmation
  app.post('/api/firebase/setup-response', (req, res) => {
    const { requestId, ...payload } = req.body || {};
    if (!requestId || typeof requestId !== 'string') {
      return res.status(400).json({ success: false, error: 'requestId is required' });
    }
    clearPendingFirebaseInJobs(requestId);
    const resolved = resolvePendingFirebaseSetup(requestId, payload);
    if (!resolved) {
      return res.status(404).json({ success: false, error: 'Firebase setup session expired or not found' });
    }
    res.json({ success: true });
  });

  // Secrets: Get stored keys with masked values and real-time status
  app.get('/api/secrets', async (_req, res) => {
    try {
      const keys = await loadSecrets();
      const statusList = getKeyPoolStatus(keys);
      res.json({
        keys: keys.map((k, index) => ({
          ...k,
          apiKeyMasked: k.apiKey ? (k.apiKey.length > 8 ? `${k.apiKey.slice(0, 4)}...${k.apiKey.slice(-4)}` : '****') : '',
          status: statusList[index]?.status || 'healthy',
          cooldownRemainingSec: statusList[index]?.cooldownRemainingSec || 0,
          requestsThisMinute: statusList[index]?.requestsThisMinute || 0,
          tokensThisMinute: statusList[index]?.tokensThisMinute || 0,
          requestsToday: statusList[index]?.requestsToday || 0,
          totalRequests: statusList[index]?.totalRequests || 0,
          lastError: statusList[index]?.lastError || null,
        }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secrets: Save / sync API keys
  app.post('/api/secrets', async (req, res) => {
    try {
      const { keys } = req.body;
      if (!Array.isArray(keys)) {
        return res.status(400).json({ error: "Expected an array of keys" });
      }
      await saveSecrets(keys);
      res.json({ success: true, count: keys.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Secrets: Test an API key connectivity
  app.post('/api/secrets/test-key', async (req, res) => {
    try {
      const { provider, apiKey, model, baseUrl } = req.body;
      if (!provider || !apiKey) {
        return res.status(400).json({ success: false, error: "Provider and apiKey are required" });
      }
      const result = await testApiKey(provider, apiKey, model, baseUrl);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Secrets: Fetch live available models (especially :free models) for a provider
  app.post('/api/secrets/models', async (req, res) => {
    try {
      const { provider = 'openrouter', apiKey, baseUrl } = req.body || {};
      const models = await fetchLiveProviderModels(provider, apiKey, baseUrl);
      res.json({ success: true, provider, models });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Secrets: Get real-time status of current pool
  app.get('/api/secrets/pool-status', async (_req, res) => {
    try {
      const keys = await loadSecrets();
      const poolStatus = getKeyPoolStatus(keys);
      res.json({
        pool: poolStatus,
        lastSuccessfulKeyId: getLastSuccessfulKeyId(),
        hasEnvGeminiKey: !!process.env.GEMINI_API_KEY
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // System Logs: Diagnostic logs for error tracking, key rotation & execution
  app.get('/api/system-logs', (_req, res) => {
    try {
      res.json({ logs: getSystemLogs() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/system-logs', (_req, res) => {
    try {
      clearSystemLogs();
      res.json({ success: true, message: 'লগ মুছে ফেলা হয়েছে' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Tool Endpoints ---

  // Helper: collect non-symlink files from a directory safely for ZIP or listing
  const ignoreArchiveDirs = new Set(['node_modules', 'dist', '.git', '.next', 'nexus-project.zip']);
  const resolveSessionWebsiteRoot = async (rawSessionId: string): Promise<{ rootDir: string; source: 'workspace' | 'projects' | 'none'; safeId: string }> => {
    const safeId = sanitizeSessionId(rawSessionId);
    const wsDir = path.join(process.cwd(), 'workspaces', safeId);
    const wsExists = await fs.access(wsDir).then(() => true).catch(() => false);
    if (wsExists) {
      return { rootDir: wsDir, source: 'workspace', safeId };
    }
    const projDir = path.join(process.cwd(), 'projects', safeId);
    const projExists = await fs.access(projDir).then(() => true).catch(() => false);
    if (projExists) {
      return { rootDir: projDir, source: 'projects', safeId };
    }
    return { rootDir: '', source: 'none', safeId };
  };

  const addFilesToZipSafe = async (zip: AdmZip, dir: string, zipPath: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (ignoreArchiveDirs.has(entry.name) || entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await addFilesToZipSafe(zip, fullPath, relativePath);
      } else if (entry.isFile()) {
        const content = await fs.readFile(fullPath);
        zip.addFile(relativePath, content);
      }
    }
  };

  // Project / Per-Chat Website Download (ZIP)
  app.get(['/api/project/download', '/api/workspaces/:sessionId/download'], async (req, res) => {
    try {
      const requestedSessionId =
        (typeof req.params.sessionId === 'string' && req.params.sessionId) ||
        (typeof req.query.sessionId === 'string' && req.query.sessionId) ||
        '';
      const requestedTitle =
        typeof req.query.title === 'string' && req.query.title.trim()
          ? req.query.title.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
          : '';

      const zip = new AdmZip();
      let downloadFilename = 'nexus-project.zip';

      if (requestedSessionId) {
        const { rootDir, source, safeId } = await resolveSessionWebsiteRoot(requestedSessionId);
        if (source === 'none' || !rootDir) {
          return res.status(404).json({
            error: 'এই চ্যাটের জন্য এখনো কোনো জেনারেটেড ওয়েবসাইট ফাইল পাওয়া যায়নি।',
            sessionId: safeId,
          });
        }
        await addFilesToZipSafe(zip, rootDir, '');
        if (zip.getEntries().length === 0) {
          return res.status(404).json({
            error: 'এই চ্যাটের ওয়ার্কস্পেসে এখনো কোনো ডাউনলোডযোগ্য ফাইল নেই।',
            sessionId: safeId,
          });
        }
        const slug = requestedTitle || safeId;
        downloadFilename = `${slug}-website.zip`;
      } else {
        await addFilesToZipSafe(zip, process.cwd(), '');
      }

      const buffer = zip.toBuffer();
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.send(buffer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Read
  app.post('/api/tools/file-read', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath is required' });
      const { absolutePath, allowed } = resolveWorkspacePath(filePath);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      const content = await fs.readFile(absolutePath, 'utf-8');
      res.json({ content });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Write
  app.post('/api/tools/file-write', async (req, res) => {
    try {
      const { filePath, content } = req.body;
      if (!filePath || content === undefined) return res.status(400).json({ error: 'filePath and content are required' });
      const { absolutePath, allowed } = resolveWorkspacePath(filePath);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf-8');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // File Edit
  app.post('/api/tools/file-edit', async (req, res) => {
    try {
      const { filePath, oldText, newText } = req.body;
      const { absolutePath, allowed } = resolveWorkspacePath(filePath);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      const content = await fs.readFile(absolutePath, 'utf-8');
      if (!content.includes(oldText)) {
        return res.status(400).json({ error: 'Target text not found in file.' });
      }

      const newContent = content.replace(oldText, newText);
      await fs.writeFile(absolutePath, newContent, 'utf-8');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Glob (File Search)
  app.post('/api/tools/glob', async (req, res) => {
    try {
      const { pattern = '*' } = req.body || {};
      const safePattern = String(pattern).replace(/"/g, '\\"');
      const { stdout } = await execPromise(
        `find . -name "${safePattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -n 150`,
        { cwd: process.cwd(), timeout: 15000 }
      );
      const files = stdout.split('\n').filter(f => f.trim() !== '').map(f => f.replace('./', ''));
      res.json({ files });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Grep (Content Search with line numbers)
  app.post('/api/tools/grep', async (req, res) => {
    try {
      const { pattern, searchPath = '.' } = req.body || {};
      if (!pattern) return res.status(400).json({ error: 'pattern is required' });
      const safePattern = String(pattern).replace(/"/g, '\\"');
      const safePath = String(searchPath).replace(/"/g, '\\"');
      try {
        const { stdout } = await execPromise(
          `grep -rnE "${safePattern}" "${safePath}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -n 100`,
          { cwd: process.cwd(), timeout: 15000 }
        );
        const matches = stdout.split('\n').filter(f => f.trim() !== '').map(f => f.replace(/^\.\//, ''));
        res.json({ matches, files: Array.from(new Set(matches.map(m => m.split(':')[0]))) });
      } catch (err: any) {
        if (err.code === 1) return res.json({ matches: [], files: [] });
        throw err;
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Bash Execution
  app.post('/api/tools/bash', async (req, res) => {
    try {
      const { command, sessionId, cwd: requestedCwd } = req.body || {};
      if (!command) return res.status(400).json({ error: 'command is required' });
      if (/(rm\s+-rf\s+\/\s*$|rm\s+-rf\s+\/\*|\.secrets\.json)/i.test(String(command))) {
        return res.status(403).json({ error: 'Safety guard: blocked destructive or secret access command.' });
      }
      const result = await executeServerTool('run_command', { CommandLine: command, Cwd: requestedCwd }, undefined, { sessionId });
      if (result?.error && result?.exitCode !== 0) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message, stdout: error.stdout, stderr: error.stderr });
    }
  });

  // Web Fetch
  app.post('/api/tools/web-fetch', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const response = await fetch(url);
      const data = await response.text();
      res.json({ data });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Web Search (Free Multi-Source: Gemini Google Grounding + Jina Reader + npm + DuckDuckGo + Wikipedia)
  app.post('/api/tools/web-search', async (req, res) => {
    try {
      const { query } = req.body || {};
      if (!query) return res.status(400).json({ error: 'query is required' });
      const storedKeys = await loadSecrets().catch(() => []);
      const geminiKey =
        storedKeys.find((k) => k.isActive && k.provider === 'gemini')?.apiKey ||
        process.env.GEMINI_API_KEY;
      const result = await freeWebSearch(query, { geminiApiKey: geminiKey });
      res.json(result);
    } catch (error: any) {
      console.error('Search error:', error);
      res.status(500).json({
        error: error.message || "Search failed.",
        searchUrl: `https://www.google.com/search?q=${encodeURIComponent(req.body?.query || '')}`
      });
    }
  });

  // Project Analysis
  app.post('/api/tools/analyze-project', async (req, res) => {
    try {
      const { type } = req.body;
      const getFilesRecursively = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return [];
          return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
        }));
        return files.flat();
      };
      const allFiles = await getFilesRecursively(process.cwd());
      const relevantFiles = allFiles.filter(f => f.endsWith('.html') || f.endsWith('.tsx') || f.endsWith('.ts') || f.endsWith('.css'));
      const fileContents = await Promise.all(relevantFiles.slice(0, 10).map(async (f) => ({
        path: path.relative(process.cwd(), f),
        content: await fs.readFile(f, 'utf-8')
      })));
      res.json({ files: fileContents, analysisType: type });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GitHub Status
  app.get('/api/github/status', async (_req, res) => {
    try {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return res.json({ configured: false });
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      res.json({
        configured: true,
        user: user.login,
        name: user.name || user.login,
        avatar: user.avatar_url
      });
    } catch (err: any) {
      res.json({ configured: false, error: err.message });
    }
  });

  // Verify Personal Access Token
  app.post('/api/github/verify-token', async (req, res) => {
    try {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'Token is required' });
      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();
      res.json({
        valid: true,
        user: user.login,
        name: user.name || user.login,
        avatar: user.avatar_url
      });
    } catch (err: any) {
      res.status(400).json({ valid: false, error: 'Invalid GitHub Token or insufficient permissions.' });
    }
  });

  // GitHub Full Sync (Create Repo & Push Code)
  app.post('/api/github/sync', async (req, res) => {
    try {
      const {
        token: clientToken,
        repoName: rawRepoName,
        repo: legacyRepo,
        isPrivate = false,
        commitMessage: rawCommitMsg,
        message: legacyMsg,
      } = req.body || {};
      const resolvedRepoInput = String(rawRepoName || legacyRepo || '').trim();
      const repoName = resolvedRepoInput.includes('/') ? resolvedRepoInput.split('/').pop()! : resolvedRepoInput;
      const commitMessage = String(rawCommitMsg || legacyMsg || 'Sync project from Nexus AI');
      const token = clientToken || process.env.GITHUB_TOKEN;
      if (!token) return res.status(401).json({ error: 'GitHub Personal Access Token is required.' });
      if (!repoName) return res.status(400).json({ error: 'Repository name is required.' });

      const octokit = new Octokit({ auth: token });
      const { data: user } = await octokit.rest.users.getAuthenticated();

      // Check if repo already exists, if not, create it
      let repoUrl = `https://github.com/${user.login}/${repoName}`;
      try {
        const { data: repo } = await octokit.rest.repos.get({
          owner: user.login,
          repo: repoName
        });
        repoUrl = repo.html_url;
      } catch (e: any) {
        if (e.status === 404) {
          const { data: newRepo } = await octokit.rest.repos.createForAuthenticatedUser({
            name: repoName,
            private: isPrivate,
            description: "Built and synced with Nexus AI",
            auto_init: false
          });
          repoUrl = newRepo.html_url;
        } else {
          throw e;
        }
      }

      // Configure git locally
      await execPromise(`git config --global --add safe.directory '*' || true`, { cwd: process.cwd() });
      await execPromise(`git init -b main || git checkout -B main`, { cwd: process.cwd() });
      await execPromise(`git config user.name "${(user.name || user.login).replace(/"/g, '')}"`, { cwd: process.cwd() });
      await execPromise(`git config user.email "${(user.email || user.login + '@users.noreply.github.com').replace(/"/g, '')}"`, { cwd: process.cwd() });
      
      // Stage files and commit
      await execPromise(`git add -A`, { cwd: process.cwd() });
      await execPromise(`git commit -m "${commitMessage.replace(/"/g, '\\"')}" || echo "No changes to commit"`, { cwd: process.cwd() });

      // Configure remote and push
      const remoteUrl = `https://x-access-token:${token}@github.com/${user.login}/${repoName}.git`;
      await execPromise(`git remote remove origin 2>/dev/null || true`, { cwd: process.cwd() });
      await execPromise(`git remote add origin ${remoteUrl}`, { cwd: process.cwd() });
      const { stdout, stderr } = await execPromise(`git push -u origin main --force`, { cwd: process.cwd() });

      res.json({
        success: true,
        repoUrl,
        message: `Successfully synced project to ${repoUrl}!`,
        stdout,
        stderr
      });
    } catch (error: any) {
      console.error('GitHub Sync Error:', error);
      res.status(500).json({ error: error.message || 'Failed to sync to GitHub.' });
    }
  });

  // Inspect current session's generated project before deploying to GitHub Pages
  app.post('/api/github/session-info', async (req, res) => {
    try {
      const { sessionId, sessionTitle, hasHtmlFallback } = req.body || {};
      const info = await inspectSessionProject(
        typeof sessionId === 'string' ? sessionId : undefined,
        typeof sessionTitle === 'string' ? sessionTitle : undefined,
        Boolean(hasHtmlFallback)
      );
      res.json(info);
    } catch (error: any) {
      res.status(500).json({ exists: false, error: error.message });
    }
  });

  // Deploy current session's generated project to a new GitHub repository + enable GitHub Pages
  app.post('/api/github/deploy-pages', async (req, res) => {
    const {
      token,
      sessionId,
      sessionTitle,
      repoName,
      description,
      isPrivate = false,
      ifExists = 'error',
      htmlFallback,
      stream = false,
    } = req.body || {};

    if (!stream) {
      try {
        const result = await deploySessionToGitHubPages({
          token,
          sessionId,
          sessionTitle,
          repoName,
          description,
          isPrivate: Boolean(isPrivate),
          ifExists: ifExists === 'update' ? 'update' : 'error',
          htmlFallback,
        });
        res.status(result.success ? 200 : 400).json(result);
      } catch (error: any) {
        res.status(500).json({ success: false, error: error.message || 'Deployment failed.' });
      }
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');

    const writeEvent = (payload: any) => {
      if (!res.writableEnded) {
        res.write(JSON.stringify(payload) + '\n');
      }
    };

    try {
      const result = await deploySessionToGitHubPages({
        token,
        sessionId,
        sessionTitle,
        repoName,
        description,
        isPrivate: Boolean(isPrivate),
        ifExists: ifExists === 'update' ? 'update' : 'error',
        htmlFallback,
        onProgress: (ev) => writeEvent({ type: 'progress', ...ev }),
      });
      writeEvent({ type: 'result', ...result });
      res.end();
    } catch (error: any) {
      writeEvent({ type: 'result', success: false, error: error.message || 'Deployment failed.' });
      res.end();
    }
  });

  // Poll GitHub Pages build & live deployment status
  app.post('/api/github/pages-status', async (req, res) => {
    try {
      const { token, owner, repo } = req.body || {};
      if (!owner || !repo) {
        return res.status(400).json({ configured: false, error: 'owner and repo are required' });
      }
      const status = await getGitHubPagesBuildStatus({ token, owner, repo });
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ configured: false, error: error.message });
    }
  });

  // Firebase Status (Global Profile + Active Session Workspace)
  app.get('/api/firebase/status', async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const { targetDir, relativeRoot } = await resolveFirebaseTargetDir(sessionId);
      const configPath = path.join(targetDir, 'firebase-config.json');
      const rulesPath = path.join(targetDir, 'firestore.rules');
      const libPath = path.join(targetDir, 'src/lib/firebase.ts');
      const blueprintPath = path.join(targetDir, 'firebase-blueprint.json');

      const profile = await loadFirebaseProfile();

      let config: any = null;
      try {
        config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      } catch {}

      const effectiveConfig = config || (profile.webConfig?.projectId ? profile.webConfig : null);
      const configured = Boolean(
        effectiveConfig &&
          !isPlaceholderValue(effectiveConfig.projectId) &&
          !isPlaceholderValue(effectiveConfig.apiKey)
      );

      const hasRules = await fs.access(rulesPath).then(() => true).catch(() => false);
      const hasSdk = await fs.access(libPath).then(() => true).catch(() => false);
      const blueprint = await fs.readFile(blueprintPath, 'utf-8').then(JSON.parse).catch(() => null);
      const rulesContent = await fs.readFile(rulesPath, 'utf-8').catch(() => '');
      const audit = rulesContent ? auditFirestoreRules(rulesContent, blueprint) : null;

      res.json({
        configured,
        projectId: effectiveConfig?.projectId || '',
        targetRoot: relativeRoot || '.',
        config: effectiveConfig
          ? {
              projectId: effectiveConfig.projectId || '',
              apiKey: effectiveConfig.apiKey || '',
              authDomain: effectiveConfig.authDomain || '',
              storageBucket: effectiveConfig.storageBucket || '',
              messagingSenderId: effectiveConfig.messagingSenderId || '',
              appId: effectiveConfig.appId || '',
              firestoreDatabaseId: effectiveConfig.firestoreDatabaseId || '',
            }
          : null,
        hasRules,
        hasSdk,
        hasBlueprint: Boolean(blueprint),
        blueprint,
        audit,
        globalProfile: {
          autoInject: profile.autoInject,
          hasWebConfig: Boolean(
            profile.webConfig?.projectId &&
              profile.webConfig?.apiKey &&
              !isPlaceholderValue(profile.webConfig.apiKey)
          ),
          projectId: profile.webConfig?.projectId || '',
          hasServiceAccount: Boolean(profile.serviceAccount?.client_email && profile.serviceAccount?.private_key),
          serviceAccountEmail: profile.serviceAccount?.client_email || '',
          hasFirebaseToken: Boolean(profile.firebaseToken || process.env.FIREBASE_TOKEN),
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Firebase Setup & Auto-Connect (supports pasted JS/JSON firebaseConfig snippet)
  app.post('/api/firebase/setup', async (req, res) => {
    try {
      const {
        sessionId,
        configSnippet,
        apiKey,
        authDomain,
        projectId,
        storageBucket,
        messagingSenderId,
        appId,
        firestoreDatabaseId,
        autoInject,
        saveToGlobalProfile = true,
      } = req.body || {};

      const parsed = configSnippet ? parseFirebaseConfigInput(configSnippet) : {};
      const finalProjectId = (projectId || parsed.projectId || '').trim();
      const finalApiKey = (apiKey || parsed.apiKey || '').trim();

      if (!finalProjectId || !finalApiKey) {
        return res.status(400).json({
          error: 'Firebase Project ID এবং Web API Key প্রয়োজন (অথবা পুরো firebaseConfig JSON/JS পেস্ট করুন)।',
        });
      }

      const webConfigPayload = {
        projectId: finalProjectId,
        apiKey: finalApiKey,
        authDomain: (authDomain || parsed.authDomain || `${finalProjectId}.firebaseapp.com`).trim(),
        storageBucket: (storageBucket || parsed.storageBucket || `${finalProjectId}.appspot.com`).trim(),
        messagingSenderId: (messagingSenderId || parsed.messagingSenderId || '').trim(),
        appId: (appId || parsed.appId || '').trim(),
        ...(firestoreDatabaseId || parsed.firestoreDatabaseId
          ? { firestoreDatabaseId: String(firestoreDatabaseId || parsed.firestoreDatabaseId).trim() }
          : {}),
      };

      if (saveToGlobalProfile !== false || autoInject !== undefined) {
        await saveFirebaseProfile({
          ...(saveToGlobalProfile !== false ? { webConfig: webConfigPayload } : {}),
          ...(autoInject !== undefined ? { autoInject: Boolean(autoInject) } : {}),
        });
      }

      const safeSid = sanitizeFirebaseSessionId(sessionId);
      const wsDir = safeSid ? path.join(process.cwd(), 'workspaces', safeSid) : '';
      const hasInitializedWs = wsDir
        ? await fs.access(path.join(wsDir, 'package.json')).then(() => true).catch(() => false)
        : false;
      const projDir = safeSid ? path.join(process.cwd(), 'projects', safeSid) : '';
      const hasStaticProj = projDir
        ? await fs.access(path.join(projDir, 'index.html')).then(() => true).catch(() => false)
        : false;

      if (!hasInitializedWs && !hasStaticProj) {
        return res.json({
          success: true,
          savedGlobalProfileOnly: true,
          projectId: finalProjectId,
          message: `Firebase "${finalProjectId}" সেটিংসে সেভ হয়েছে! এখন চ্যাটে যেকোনো সময় ফায়ারবেজ সেটআপ করতে বললেই এটি স্বয়ংক্রিয়ভাবে কানেক্ট হবে।`,
        });
      }

      const result = await provisionFirebaseForTarget({
        sessionId: safeSid,
        platform: 'web',
        ...webConfigPayload,
        saveToGlobalProfile: Boolean(saveToGlobalProfile),
        preferSavedProfile: true,
      });

      res.json(result);
    } catch (err: any) {
      console.error('Firebase Setup Error:', err);
      res.status(500).json({ error: err.message || 'Failed to setup Firebase.' });
    }
  });

  // Save Global Firebase Auto-Inject & Service Account / Token Credentials
  app.post('/api/firebase/profile', async (req, res) => {
    try {
      const { autoInject, webConfig, serviceAccountJson, firebaseToken, clearServiceAccount } = req.body || {};
      const updates: any = {};
      if (autoInject !== undefined) updates.autoInject = Boolean(autoInject);
      if (webConfig && typeof webConfig === 'object') updates.webConfig = webConfig;
      if (typeof firebaseToken === 'string') updates.firebaseToken = firebaseToken.trim();

      if (clearServiceAccount) {
        updates.serviceAccount = null;
      } else if (serviceAccountJson) {
        const parsedSa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
        if (!parsedSa?.client_email || !parsedSa?.private_key || !parsedSa?.project_id) {
          return res.status(400).json({
            error: 'Invalid Service Account JSON: project_id, client_email, and private_key are required.',
          });
        }
        updates.serviceAccount = parsedSa;
        if (!updates.webConfig?.projectId) {
          const cur = await loadFirebaseProfile();
          if (!cur.webConfig?.projectId) {
            updates.webConfig = { ...(cur.webConfig || {}), projectId: parsedSa.project_id };
          }
        }
      }

      const saved = await saveFirebaseProfile(updates);
      res.json({
        success: true,
        autoInject: saved.autoInject,
        projectId: saved.webConfig?.projectId || '',
        hasServiceAccount: Boolean(saved.serviceAccount?.client_email),
        serviceAccountEmail: saved.serviceAccount?.client_email || '',
        hasFirebaseToken: Boolean(saved.firebaseToken),
        message: 'Global Firebase profile updated.',
      });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to save Firebase profile' });
    }
  });

  // Test live Service Account connection to Google Cloud Firebaserules API
  app.post('/api/firebase/test', async (_req, res) => {
    try {
      const result = await testFirebaseAdminConnection();
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err: any) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // Get firestore.rules (active session workspace or root)
  app.get('/api/firebase/rules', async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const { targetDir } = await resolveFirebaseTargetDir(sessionId);
      const rulesPath = path.join(targetDir, 'firestore.rules');
      const bpPath = path.join(targetDir, 'firebase-blueprint.json');
      const blueprint = await fs.readFile(bpPath, 'utf-8').then(JSON.parse).catch(() => null);
      const content = await fs.readFile(rulesPath, 'utf-8');
      res.json({ rules: content, audit: auditFirestoreRules(content, blueprint) });
    } catch {
      const fallbackRules = generateRulesFromBlueprint(null);
      res.json({ rules: fallbackRules, audit: auditFirestoreRules(fallbackRules) });
    }
  });

  // Save / Audit / Live-Deploy firestore.rules
  app.post('/api/firebase/rules', async (req, res) => {
    try {
      const { rules, sessionId } = req.body || {};
      if (!rules) return res.status(400).json({ error: 'Rules content is required' });
      const { targetDir } = await resolveFirebaseTargetDir(sessionId);
      const rulesPath = path.join(targetDir, 'firestore.rules');
      await fs.writeFile(rulesPath, rules, 'utf-8');

      const fbCfg = await fs.readFile(path.join(targetDir, 'firebase-config.json'), 'utf-8').then(JSON.parse).catch(() => null);
      const deployResult = await deployRulesToFirebaseCloud(fbCfg?.projectId || '', rules);
      res.status(deployResult.success ? 200 : 400).json(deployResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Audit firestore.rules without writing
  app.post('/api/firebase/audit-rules', async (req, res) => {
    try {
      const { rules, sessionId } = req.body || {};
      const { targetDir } = await resolveFirebaseTargetDir(sessionId);
      const bpPath = path.join(targetDir, 'firebase-blueprint.json');
      const blueprint = await fs.readFile(bpPath, 'utf-8').then(JSON.parse).catch(() => null);
      res.json(auditFirestoreRules(String(rules || ''), blueprint));
    } catch (err: any) {
      res.status(500).json({ valid: false, error: err.message });
    }
  });

  // File Delete
  app.post('/api/tools/file-delete', async (req, res) => {
    try {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath is required' });
      const { absolutePath, allowed } = resolveWorkspacePath(filePath);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });
      
      const stat = await fs.stat(absolutePath);
      if (stat.isDirectory()) {
        await fs.rm(absolutePath, { recursive: true, force: true });
      } else {
        await fs.unlink(absolutePath);
      }
      res.json({ success: true, message: `Deleted ${filePath}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // List Directory
  app.post('/api/tools/list-dir', async (req, res) => {
    try {
      const { dirPath = '.' } = req.body;
      const { absolutePath: targetDir, allowed } = resolveWorkspacePath(dirPath);
      if (!allowed) return res.status(403).json({ error: 'Access denied' });

      const entries = await fs.readdir(targetDir, { withFileTypes: true });
      const items = entries.map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: path.relative(process.cwd(), path.join(targetDir, entry.name))
      }));
      res.json({ items });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Move or Rename File
  app.post('/api/tools/move-file', async (req, res) => {
    try {
      const { sourcePath, destinationPath } = req.body;
      if (!sourcePath || !destinationPath) {
        return res.status(400).json({ error: 'sourcePath and destinationPath are required' });
      }
      const { absolutePath: absSrc, allowed: srcAllowed } = resolveWorkspacePath(sourcePath);
      const { absolutePath: absDest, allowed: destAllowed } = resolveWorkspacePath(destinationPath);
      if (!srcAllowed || !destAllowed) {
        return res.status(403).json({ error: 'Access denied' });
      }

      await fs.mkdir(path.dirname(absDest), { recursive: true });
      await fs.rename(absSrc, absDest);
      res.json({ success: true, message: `Moved ${sourcePath} to ${destinationPath}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Install Package (uses safe --legacy-peer-deps & workspace isolation)
  app.post('/api/tools/install-package', async (req, res) => {
    try {
      const { packageName, packages, isDev = false, sessionId, targetDir } = req.body || {};
      const list = Array.isArray(packages)
        ? packages
        : String(packageName || '').trim().split(/\s+/).filter(Boolean);
      if (list.length === 0) return res.status(400).json({ error: 'packageName is required' });
      const result = await installPackagesInTarget({ packages: list, isDev: Boolean(isDev), sessionId, targetDir });
      res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message, stderr: error.stderr });
    }
  });

  // Compile / Build Project (Real TypeScript check + Vite build, workspace-aware)
  app.post('/api/tools/compile-project', async (req, res) => {
    try {
      const { sessionId, targetDir } = req.body || {};
      const result = await executeServerTool('compile_applet', { TargetDir: targetDir, sessionId }, undefined, { sessionId });
      res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Compilation or Vite build failed.',
        error: error.message,
      });
    }
  });

  // Lint Project (workspace-aware)
  app.post('/api/tools/lint-project', async (req, res) => {
    try {
      const { sessionId, targetDir } = req.body || {};
      const result = await executeServerTool('lint_applet', { TargetDir: targetDir, sessionId }, undefined, { sessionId });
      res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: 'Lint found issues.',
        error: error.message,
      });
    }
  });

  // Restart / Health Probe Dev Server
  app.post('/api/tools/restart-server', async (_req, res) => {
    try {
      const healthRes = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      const healthData = await healthRes.json().catch(() => null);
      res.json({
        success: healthRes.ok,
        port: PORT,
        health: healthData,
        message: healthRes.ok
          ? `Server healthy & active on port ${PORT} (uptime ${healthData?.uptime ?? 0}s).`
          : `Health check returned status ${healthRes.status}.`
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Checkpoints & 1-Click Rollback Endpoints
  app.get('/api/git/checkpoints', async (_req, res) => {
    try {
      const checkpoints = await listCheckpoints();
      res.json({ success: true, checkpoints });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/git/checkpoints', async (req, res) => {
    try {
      const { label = 'Manual checkpoint' } = req.body || {};
      const cp = await createCheckpoint(label);
      res.json({ success: true, checkpoint: cp });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/git/rollback', async (req, res) => {
    try {
      const { checkpointId } = req.body || {};
      const result = await rollbackToCheckpoint(checkpointId);
      res.status(result.success ? 200 : 400).json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Headless DOM / Runtime Preview Verification
  app.post('/api/tools/verify-preview', async (req, res) => {
    try {
      const { targetUrl, filePath, sessionId } = req.body || {};
      const result = await verifyLivePreviewWithDom(targetUrl || filePath, true, sessionId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Codebase Dependency & Symbol Graph
  app.get('/api/tools/codebase-graph', async (req, res) => {
    try {
      const targetDir = typeof req.query.dir === 'string' ? req.query.dir : '.';
      const graph = await buildCodebaseGraph(targetDir);
      res.json(graph);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Automated Test Runner
  app.post('/api/tools/run-tests', async (req, res) => {
    try {
      const { target } = req.body || {};
      const result = await runAutomatedTests(target);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Background Scheduler Inspection & Cancellation
  app.get('/api/tools/schedule', (_req, res) => {
    res.json({ success: true, jobs: listScheduledTasks() });
  });

  app.delete('/api/tools/schedule/:id', (req, res) => {
    res.json(cancelScheduledTask(req.params.id));
  });

  // Sandboxed Multi-App Workspace Endpoints (/api/workspaces/*)
  app.get('/api/workspaces', async (_req, res) => {
    try {
      res.json(await getWorkspaceStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/workspaces/:sessionId/init', async (req, res) => {
    try {
      const { template = 'react-vite', appTitle = 'Sandboxed Nexus App' } = req.body || {};
      res.json(await initSessionWorkspace(req.params.sessionId, template, appTitle));
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/workspaces/:sessionId/build', async (req, res) => {
    try {
      res.json(await buildWorkspaceToStaticPreview(req.params.sessionId));
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/workspaces/:sessionId/start', async (req, res) => {
    try {
      const { command } = req.body || {};
      res.json(await startWorkspaceServer(req.params.sessionId, command));
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/workspaces/:sessionId/stop', async (req, res) => {
    try {
      res.json(await stopWorkspaceServer(req.params.sessionId));
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get('/api/workspaces/:sessionId/status', async (req, res) => {
    try {
      res.json(await getWorkspaceStatus(req.params.sessionId));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/workspaces/:sessionId/files', async (req, res) => {
    try {
      const { rootDir, source, safeId } = await resolveSessionWebsiteRoot(req.params.sessionId);
      if (source === 'none' || !rootDir) {
        return res.json({ sessionId: safeId, exists: false, source: 'none', files: [] });
      }
      const files: string[] = [];
      const walkSessionFiles = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (ignoreArchiveDirs.has(entry.name) || entry.isSymbolicLink()) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkSessionFiles(fullPath);
          } else if (entry.isFile()) {
            const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
            files.push(rel);
          }
        }
      };
      await walkSessionFiles(rootDir);
      files.sort((a, b) => a.localeCompare(b));
      res.json({ sessionId: safeId, exists: files.length > 0, source, files });
    } catch (error: any) {
      res.status(500).json({ error: error.message, files: [] });
    }
  });

  // TypeScript AST Symbol & Relevance Context Ranker
  app.all('/api/tools/ast-context', async (req, res) => {
    try {
      const src = req.method === 'POST' ? req.body || {} : req.query || {};
      const query = String(src.query || '');
      const targetDir = String(src.targetDir || src.dir || '.');
      const topK = Number(src.topK || 10);
      res.json(await rankAstContext(query, targetDir, topK));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Visual Screenshot + Vision UI QA Loop
  app.post('/api/tools/visual-qa', async (req, res) => {
    try {
      const { targetUrl, sessionId, viewport } = req.body || {};
      const storedKeys = await loadSecrets().catch(() => []);
      const geminiApiKey =
        storedKeys.find((k) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey ||
        process.env.GEMINI_API_KEY;
      res.json(await runVisualQaReview({ targetUrl, sessionId, viewport, geminiApiKey }));
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Persistent Remote DB Storage Status & Manual Sync (PostgreSQL / Turso / Supabase)
  app.get('/api/persistence/status', async (_req, res) => {
    try {
      res.json(await getPersistenceStatus());
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/persistence/sync', async (_req, res) => {
    try {
      const keys = await loadSecrets();
      const syncRes = await saveSecretsToPersistence(keys);
      const status = await getPersistenceStatus();
      res.json({ success: true, ...syncRes, status });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Git Status
  app.post('/api/tools/git-status', async (_req, res) => {
    try {
      const { stdout: branch } = await execPromise('git branch --show-current || echo "main"', { cwd: process.cwd() });
      const { stdout: status } = await execPromise('git status -s || echo ""', { cwd: process.cwd() });
      res.json({ branch: branch.trim(), status: status.trim() || 'Working directory clean.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Git Commit
  app.post('/api/tools/git-commit', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Commit message is required' });
      await execPromise('git add .', { cwd: process.cwd() });
      const { stdout } = await execPromise(`git commit -m "${message.replace(/"/g, '\\"')}" || echo "Nothing to commit"`, { cwd: process.cwd() });
      res.json({ success: true, stdout: stdout.trim() });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Git Diff
  app.post('/api/tools/git-diff', async (_req, res) => {
    try {
      const { stdout } = await execPromise('git diff || echo ""', { cwd: process.cwd() });
      res.json({ diff: stdout.trim() || 'No uncommitted changes detected.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send HTTP Request
  app.post('/api/tools/send-http-request', async (req, res) => {
    try {
      const { url, method = 'GET', headers = {}, body } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const response = await fetch(url, {
        method,
        headers,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
      });
      const contentType = response.headers.get('content-type') || '';
      const responseData = contentType.includes('application/json') ? await response.json() : await response.text();
      res.json({ status: response.status, statusText: response.statusText, data: responseData });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Test API Endpoint
  app.post('/api/tools/test-api-endpoint', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'url is required' });
      const start = Date.now();
      const response = await fetch(url);
      const latency = Date.now() - start;
      res.json({ status: response.status, latencyMs: latency, reachable: response.ok });
    } catch (error: any) {
      res.status(500).json({ error: error.message, reachable: false });
    }
  });

  // Set Environment Variable
  app.post('/api/tools/set-env-variable', async (req, res) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ error: 'key is required' });
      const envPath = path.resolve(process.cwd(), '.env');
      let envContent = '';
      try {
        envContent = await fs.readFile(envPath, 'utf-8');
      } catch {
        envContent = '';
      }
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}\n`;
      }
      await fs.writeFile(envPath, envContent.trim() + '\n', 'utf-8');
      process.env[key] = String(value ?? '');
      res.json({ success: true, message: `Set environment variable ${key}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Scan Security Vulnerabilities
  app.post('/api/tools/scan-vulnerabilities', async (_req, res) => {
    try {
      const { stdout, stderr } = await execPromise('npm audit --audit-level=moderate || true', { cwd: process.cwd() });
      res.json({ report: stdout || stderr || 'No vulnerabilities found.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Detect Hardcoded Secrets
  app.post('/api/tools/detect-secrets', async (_req, res) => {
    try {
      const secretPatterns = [
        /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/gi
      ];
      const getFilesRecursively = async (dir: string): Promise<string[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') return [];
          return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
        }));
        return files.flat();
      };
      const files = await getFilesRecursively(path.resolve(process.cwd(), 'src'));
      const detected: Array<{ file: string; line: number; preview: string }> = [];
      for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          for (const pattern of secretPatterns) {
            if (pattern.test(line) && !line.includes('process.env')) {
              detected.push({
                file: path.relative(process.cwd(), file),
                line: index + 1,
                preview: line.trim().slice(0, 80)
              });
            }
          }
        });
      }
      res.json({ safe: detected.length === 0, detectedCount: detected.length, detected });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Send Webhook Notification
  app.post('/api/tools/send-webhook', async (req, res) => {
    try {
      const { webhookUrl, message, payload = {} } = req.body;
      if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl is required' });
      const body = { content: message, text: message, ...payload };
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      res.json({ success: response.ok, status: response.status });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Execute Database / SQL Query (real persistent SQLite via node:sqlite)
  app.post('/api/tools/execute-sql-query', async (req, res) => {
    try {
      const { query } = req.body || {};
      if (!query) return res.status(400).json({ error: 'SQL query is required' });
      const result = await executeServerTool('cloudsql_execute_sql', { sql_statement: query });
      if (result?.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // List Files
  app.get('/api/files/list', async (_req, res) => {
    try {
      const getFiles = async (dir: string): Promise<any[]> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const files = await Promise.all(entries.map(async (entry) => {
          const resPath = path.resolve(dir, entry.name);
          const relativePath = path.relative(process.cwd(), resPath);
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') return null;
          if (entry.isDirectory()) {
            return { name: entry.name, path: relativePath, type: 'directory', children: await getFiles(resPath) };
          } else {
            return { name: entry.name, path: relativePath, type: 'file' };
          }
        }));
        return files.filter(f => f !== null);
      };
      const fileTree = await getFiles(process.cwd());
      res.json(fileTree);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Coding Mode Skills & Tools Registry (including Function Calling schemas)
  app.get('/api/skills', (_req, res) => {
    res.json({
      skills: CODING_SKILLS_REGISTRY,
      tools: serverTools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters || null,
      })),
    });
  });

  app.get('/api/skills/:name', (req, res) => {
    const skill = getSkillByName(req.params.name);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json(skill);
  });

  // Code Execution Sandbox endpoint
  app.post('/api/tools/sandbox', async (req, res) => {
    try {
      const { language = 'javascript', code = '', timeoutMs = 10000 } = req.body || {};
      if (!code.trim()) return res.status(400).json({ error: 'code is required' });
      const result = await runCodeInSandbox(language, code, timeoutMs);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Debugging & Error Analysis endpoint
  app.post('/api/tools/debug-analyze', async (req, res) => {
    try {
      const { errorMessage, errorLog, targetFile, filePath } = req.body || {};
      const result = await runDebugErrorAnalysis(errorMessage || errorLog, targetFile || filePath);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- UltraWorkers & Claw Code Harness API Routes ---

  // Claw Doctor: Health check for environment, runtimes, port, memory, API keys
  app.all('/api/tools/claw-doctor', async (req, res) => {
    try {
      const { runNetworkCheck = false } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = await runClawDoctor(Boolean(runNetworkCheck));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw Status: Harness runtime state & metrics
  app.all('/api/tools/claw-status', async (_req, res) => {
    try {
      const result = await getClawStatus();
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw ACP: Agent Client Protocol capabilities & handshake
  app.all('/api/tools/claw-acp', (req, res) => {
    try {
      const { action = 'status' } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = getClawAcpInfo(action);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Claw Prompt: Direct task execution harness
  app.post('/api/tools/claw-prompt', async (req, res) => {
    try {
      const { prompt = '', role = 'developer', dryRun = false } = req.body || {};
      if (!prompt.trim()) return res.status(400).json({ error: 'prompt is required' });
      const result = await runClawPrompt(prompt, role, Boolean(dryRun));
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // OmO (oh-my-openagent): Multi-Agent Coordination (Architect -> Executor -> Reviewer)
  app.post('/api/tools/omo-coordinate', async (req, res) => {
    try {
      const { task = '', context, subAgents } = req.body || {};
      if (!task.trim()) return res.status(400).json({ error: 'task is required' });
      const result = await runOmoCoordinate(task, context, subAgents);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // OmX (oh-my-codex): Structured Execution Protocol
  app.post('/api/tools/omx-protocol', async (req, res) => {
    try {
      const { goal = '', targetStack } = req.body || {};
      if (!goal.trim()) return res.status(400).json({ error: 'goal is required' });
      const result = await runOmxProtocol(goal, targetStack);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ClawHip: Event & Notification Router
  app.all('/api/tools/clawhip', (req, res) => {
    try {
      const { action = 'list', eventType, message, metadata } = (req.method === 'POST' ? req.body : req.query) || {};
      const result = routeClawHipEvent(action, eventType, message, metadata);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Gajae-Code / LazyCodex: Autonomous Task Runner with compiler verification
  app.post('/api/tools/lazycodex', async (req, res) => {
    try {
      const { task = '', targetFiles = [], maxIterations = 3 } = req.body || {};
      if (!task.trim()) return res.status(400).json({ error: 'task is required' });
      const result = await runLazyCodex(task, targetFiles, maxIterations);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Manage background tasks
  app.post('/api/tools/manage-task', (req, res) => {
    const { action = 'list', taskId, input } = req.body || {};
    res.json(manageBackgroundTask(action, taskId, input));
  });

  // Dual verification: compile + lint
  app.post('/api/tools/verify-build', async (_req, res) => {
    try {
      const { stdout: lintOut } = await execPromise('npx tsc --noEmit', { cwd: process.cwd() });
      const { stdout: buildOut } = await execPromise('npm run build', { cwd: process.cwd() });
      res.json({ success: true, lintOutput: lintOut.trim() || 'No TypeScript errors', buildOutput: buildOut.trim() });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        output: error.stdout || error.stderr || '',
      });
    }
  });

  // Vite Middleware (initialized in parallel so port 3000 binds immediately without AI Studio cold-start timeouts)
  if (process.env.NODE_ENV !== 'production') {
    // Prevent stale PWA Service Workers from returning text/html or trapping AI Studio preview reloads in dev mode
    app.get('/sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.send(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) => c.navigate(c.url)))
  );
});`);
    });

    const enableHmr = process.env.ENABLE_HMR === 'true' && process.env.DISABLE_HMR !== 'true';
    const vitePromise = createViteServer({
      server: {
        middlewareMode: true,
        hmr: enableHmr ? { server: httpServer } : false,
        ws: enableHmr ? { server: httpServer } : false,
        forwardConsole: false,
        watch: enableHmr ? {} : null,
      },
      appType: 'spa',
    });

    vitePromise
      .then(async (vite) => {
        await vite.warmupRequest('/src/main.tsx').catch(() => {});
      })
      .catch((err) => {
        console.error('[Server] Vite dev server initialization error:', err);
      });

    if (!enableHmr) {
      app.get('/@vite/client', async (req, res, next) => {
        try {
          const vite = await vitePromise;
          const transformed = await vite.transformRequest('/@vite/client');
          if (!transformed?.code) return next();
          const safeCode = transformed.code
            .replace(/\bws\.send\(/g, 'ws?.send(')
            .replace(/await wsTransport\.connect\(handlers\);/g, 'return;');
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          return res.send(safeCode);
        } catch {
          return next();
        }
      });
    }

    app.use(async (req, res, next) => {
      try {
        const vite = await vitePromise;
        return vite.middlewares(req, res, next);
      } catch (err) {
        return next(err);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
