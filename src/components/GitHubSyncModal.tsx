import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Github,
  CheckCircle,
  AlertCircle,
  Loader2,
  GitCommit,
  ExternalLink,
  Rocket,
  Globe,
  Copy,
  Check,
  FolderGit2,
  Lock,
  Unlock,
  FileCode2,
  RefreshCw,
  LogOut,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
} from 'lucide-react';

interface GitHubUser {
  login: string;
  name: string;
  avatar_url?: string;
}

interface SessionProjectInfo {
  exists: boolean;
  safeSessionId: string;
  source: 'workspace' | 'projects' | 'fallback' | 'none';
  kind: 'react-vite' | 'fullstack-vite' | 'static-workspace' | 'static-pwa' | 'html-fallback' | 'none';
  fileCount: number;
  files: string[];
  hasViteConfig: boolean;
  hasBackendServer: boolean;
  suggestedRepoName: string;
}

interface DeployStepState {
  id: 'resolve' | 'build' | 'repo' | 'push' | 'pages';
  label: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  detail?: string;
}

interface DeployResultState {
  success: boolean;
  repoUrl?: string;
  pagesUrl?: string;
  owner?: string;
  repoName?: string;
  branch?: string;
  pagesStatus?: string;
  projectKind?: string;
  filesPublishedCount?: number;
  buildLogs?: string;
  warnings?: string[];
  error?: string;
}

interface GitHubSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId?: string | null;
  sessionTitle?: string;
  currentSessionHtml?: string | null;
  initialTab?: 'pages' | 'sync';
}

const LOCAL_PAT_KEY = 'nexus_github_pat';

const INITIAL_STEPS: DeployStepState[] = [
  { id: 'resolve', label: 'Resolve Current Session Project', status: 'pending' },
  { id: 'build', label: 'Build Production Bundle (Vite / Static Assets)', status: 'pending' },
  { id: 'repo', label: 'Create New GitHub Repository', status: 'pending' },
  { id: 'push', label: 'Push Source (main) & Build (gh-pages)', status: 'pending' },
  { id: 'pages', label: 'Enable & Configure GitHub Pages', status: 'pending' },
];

export const GitHubSyncModal: React.FC<GitHubSyncModalProps> = ({
  isOpen,
  onClose,
  sessionId,
  sessionTitle,
  currentSessionHtml,
  initialTab = 'pages',
}) => {
  const [activeTab, setActiveTab] = useState<'pages' | 'sync'>(initialTab);
  const [token, setToken] = useState('');
  const [rememberToken, setRememberToken] = useState(true);
  const [serverConfigured, setServerConfigured] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // GitHub Pages workflow states
  const [sessionInfo, setSessionInfo] = useState<SessionProjectInfo | null>(null);
  const [isInspectingSession, setIsInspectingSession] = useState(false);
  const [pagesRepoName, setPagesRepoName] = useState('');
  const [pagesDescription, setPagesDescription] = useState('');
  const [isPrivateRepo, setIsPrivateRepo] = useState(false);
  const [updateIfExists, setUpdateIfExists] = useState(false);
  const [isDeployingPages, setIsDeployingPages] = useState(false);
  const [deploySteps, setDeploySteps] = useState<DeployStepState[]>(INITIAL_STEPS);
  const [deployResult, setDeployResult] = useState<DeployResultState | null>(null);
  const [livePagesStatus, setLivePagesStatus] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [showBuildLogs, setShowBuildLogs] = useState(false);
  const [showFilesList, setShowFilesList] = useState(false);

  // Full Workspace Sync states
  const [syncRepo, setSyncRepo] = useState('');
  const [commitMessage, setCommitMessage] = useState('feat: update project via Nexus AI');
  const [isSyncing, setIsSyncing] = useState(false);

  // Shared alert message
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPagesPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => stopPagesPolling();
  }, []);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setStatusMessage(null);
      setIsError(false);
    } else {
      stopPagesPolling();
    }
  }, [isOpen, initialTab]);

  const normalizeUserFromResponse = (data: any): GitHubUser | null => {
    if (!data) return null;
    if (typeof data.user === 'string' && data.user) {
      return {
        login: data.user,
        name: data.name || data.user,
        avatar_url: data.avatar || data.avatar_url,
      };
    }
    if (data.user && typeof data.user === 'object' && data.user.login) {
      return {
        login: data.user.login,
        name: data.user.name || data.user.login,
        avatar_url: data.user.avatar_url || data.avatar,
      };
    }
    return null;
  };

  const verifyPatToken = async (rawToken: string, silent = false) => {
    const clean = rawToken.trim();
    if (!clean) return;
    setIsVerifying(true);
    if (!silent) {
      setStatusMessage(null);
      setIsError(false);
    }
    try {
      const res = await fetch('/api/github/verify-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: clean }),
      });
      const data = await res.json();
      const parsedUser = normalizeUserFromResponse(data);
      if (res.ok && parsedUser) {
        setUser(parsedUser);
        if (rememberToken) {
          try {
            localStorage.setItem(LOCAL_PAT_KEY, clean);
          } catch {}
        }
        if (!silent) {
          setStatusMessage(`Connected as @${parsedUser.login}`);
          setIsError(false);
        }
      } else if (!silent) {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to verify GitHub token');
      }
    } catch (err: any) {
      if (!silent) {
        setIsError(true);
        setStatusMessage(err.message || 'Verification failed');
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const inspectCurrentSession = async () => {
    setIsInspectingSession(true);
    try {
      const res = await fetch('/api/github/session-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId || undefined,
          sessionTitle: sessionTitle || undefined,
          hasHtmlFallback: Boolean(currentSessionHtml && currentSessionHtml.trim().length > 20),
        }),
      });
      const info: SessionProjectInfo = await res.json();
      setSessionInfo(info);
      if (info.suggestedRepoName) {
        const cleanSlug = info.suggestedRepoName.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        setPagesRepoName(cleanSlug || 'nexus-web-app');
      }
      if (sessionTitle && sessionTitle !== 'Live Canvas' && sessionTitle !== 'New Canvas') {
        setPagesDescription(`${sessionTitle} — Built & deployed with Nexus AI`);
      } else {
        setPagesDescription('Web application built and deployed with Nexus AI');
      }
    } catch {
      setSessionInfo(null);
    } finally {
      setIsInspectingSession(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    // Reset per-open transient deployment result only if switching sessions
    void inspectCurrentSession();

    // Check server-configured token or saved browser PAT
    fetch('/api/github/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.configured) {
          setServerConfigured(true);
          const parsed = normalizeUserFromResponse(data);
          if (parsed) setUser(parsed);
          if (data.repo) setSyncRepo(data.repo);
        } else {
          setServerConfigured(false);
          try {
            const savedPat = localStorage.getItem(LOCAL_PAT_KEY);
            if (savedPat) {
              setToken(savedPat);
              void verifyPatToken(savedPat, true);
            }
          } catch {}
        }
      })
      .catch(() => {});
  }, [isOpen, sessionId, sessionTitle]);

  if (!isOpen) return null;

  const handleDisconnectPat = () => {
    setUser(null);
    setToken('');
    try {
      localStorage.removeItem(LOCAL_PAT_KEY);
    } catch {}
    setStatusMessage(null);
    setIsError(false);
  };

  const sanitizedPreviewRepo = (pagesRepoName || sessionInfo?.suggestedRepoName || 'nexus-web-app')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'nexus-web-app';

  const previewOwner = user?.login || '<username>';
  const previewPagesUrl =
    sanitizedPreviewRepo === `${previewOwner.toLowerCase()}.github.io`
      ? `https://${previewOwner}.github.io/`
      : `https://${previewOwner}.github.io/${sanitizedPreviewRepo}/`;

  const startPagesStatusPolling = (owner: string, repo: string, activeToken?: string) => {
    stopPagesPolling();
    let attempts = 0;
    const poll = async () => {
      attempts++;
      if (attempts > 20) {
        stopPagesPolling();
        return;
      }
      try {
        const res = await fetch('/api/github/pages-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: activeToken || undefined,
            owner,
            repo,
          }),
        });
        const data = await res.json();
        const st = data.buildStatus || data.status;
        if (st) {
          setLivePagesStatus(st);
          if (st === 'built' || st === 'errored') {
            stopPagesPolling();
          }
        }
      } catch {}
    };
    pollTimerRef.current = setInterval(poll, 4000);
  };

  const handleDeployToPages = async () => {
    if (isDeployingPages) return;
    if (!user && !token.trim() && !serverConfigured) {
      setIsError(true);
      setStatusMessage('Please connect your GitHub Personal Access Token first.');
      return;
    }
    if (!sanitizedPreviewRepo) {
      setIsError(true);
      setStatusMessage('Please enter a valid repository name.');
      return;
    }

    setIsDeployingPages(true);
    setDeployResult(null);
    setLivePagesStatus(null);
    setStatusMessage(null);
    setIsError(false);
    setShowBuildLogs(false);
    setDeploySteps(INITIAL_STEPS.map((s) => ({ ...s, status: 'pending', detail: undefined })));
    stopPagesPolling();

    try {
      const effectiveToken = token.trim() || undefined;
      const res = await fetch('/api/github/deploy-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: effectiveToken,
          sessionId: sessionId || undefined,
          sessionTitle: sessionTitle || undefined,
          repoName: sanitizedPreviewRepo,
          description: pagesDescription.trim() || undefined,
          isPrivate: isPrivateRepo,
          ifExists: updateIfExists ? 'update' : 'error',
          htmlFallback: currentSessionHtml || undefined,
          stream: true,
        }),
      });

      if (!res.body) {
        const data = await res.json();
        setDeployResult(data);
        if (!data.success) {
          setIsError(true);
          setStatusMessage(data.error || 'Deployment failed');
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finalPayload: DeployResultState | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const ev = JSON.parse(trimmed);
            if (ev.type === 'progress') {
              const stepId = ev.step as DeployStepState['id'];
              if (['resolve', 'build', 'repo', 'push', 'pages'].includes(stepId)) {
                setDeploySteps((prev) =>
                  prev.map((s) =>
                    s.id === stepId
                      ? {
                          ...s,
                          status: ev.status,
                          detail: ev.detail || ev.message,
                        }
                      : s
                  )
                );
              }
            } else if (ev.type === 'result') {
              finalPayload = ev;
              setDeployResult(ev);
              if (ev.success) {
                setLivePagesStatus(ev.pagesStatus || 'building');
                if (ev.owner && ev.repoName) {
                  startPagesStatusPolling(ev.owner, ev.repoName, effectiveToken);
                }
              } else {
                setIsError(true);
                setStatusMessage(ev.error || 'GitHub Pages deployment failed');
              }
            }
          } catch {}
        }
      }

      if (!finalPayload) {
        setIsError(true);
        setStatusMessage('Deployment stream ended unexpectedly.');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err?.message || 'Failed to deploy to GitHub Pages');
    } finally {
      setIsDeployingPages(false);
    }
  };

  const handleSync = async () => {
    if (!syncRepo.trim()) {
      setIsError(true);
      setStatusMessage('Please specify a repository name');
      return;
    }
    setIsSyncing(true);
    setStatusMessage(null);
    setIsError(false);
    try {
      const cleanName = syncRepo.trim().includes('/') ? syncRepo.trim().split('/').pop()! : syncRepo.trim();
      const res = await fetch('/api/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.trim() || undefined,
          repoName: cleanName,
          commitMessage: commitMessage.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStatusMessage(data.message || `Successfully synced with ${cleanName}!`);
        setIsError(false);
      } else {
        setIsError(true);
        setStatusMessage(data.error || 'Failed to sync with GitHub');
      }
    } catch (err: any) {
      setIsError(true);
      setStatusMessage(err.message);
    } finally {
      setIsSyncing(false);
    }
  };

  const copyPagesUrl = () => {
    if (!deployResult?.pagesUrl) return;
    navigator.clipboard.writeText(deployResult.pagesUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const kindLabelMap: Record<string, string> = {
    'react-vite': 'React + Vite Modular App',
    'fullstack-vite': 'Fullstack Vite Frontend',
    'static-workspace': 'Static HTML Workspace',
    'static-pwa': 'Static PWA Website',
    'html-fallback': 'Session HTML Project',
    none: 'No Project Detected',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-xl bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600/30 to-slate-800 text-white flex items-center justify-center border border-indigo-500/30">
              <Github className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">GitHub Pages & Repository Sync</h3>
              <p className="text-[11px] text-slate-400">
                Build the current session&apos;s project and publish live to GitHub Pages
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Switcher Tabs */}
        <div className="px-5 pt-3 pb-2 border-b border-slate-800/70 bg-slate-900/40 flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => {
              setActiveTab('pages');
              setStatusMessage(null);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'pages'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <Rocket className="w-3.5 h-3.5" />
            <span>Deploy to GitHub Pages</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('sync');
              setStatusMessage(null);
            }}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'sync'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                : 'text-slate-400 hover:text-white hover:bg-slate-800/70'
            }`}
          >
            <GitCommit className="w-3.5 h-3.5" />
            <span>Workspace Sync</span>
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs flex-1">
          {/* GitHub Auth Box */}
          {user ? (
            <div className="p-3 bg-slate-900/90 border border-slate-800 rounded-xl flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {user.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.login}
                    className="w-9 h-9 rounded-full border border-slate-700 flex-shrink-0"
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700">
                    <Github className="w-4 h-4 text-slate-300" />
                  </div>
                )}
                <div className="min-w-0">
                  <div className="font-bold text-white flex items-center gap-1.5 truncate">
                    <span className="truncate">{user.name || user.login}</span>
                    <span className="text-slate-400 font-normal">(@{user.login})</span>
                  </div>
                  <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" />
                    <span>{serverConfigured ? 'Authenticated via Server Token' : 'Authenticated with PAT'}</span>
                  </div>
                </div>
              </div>
              {!serverConfigured && (
                <button
                  type="button"
                  onClick={handleDisconnectPat}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-medium flex items-center gap-1 cursor-pointer flex-shrink-0"
                  title="Disconnect GitHub Token"
                >
                  <LogOut className="w-3 h-3" />
                  <span>Switch</span>
                </button>
              )}
            </div>
          ) : (
            <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-slate-200 font-semibold block">
                  GitHub Personal Access Token (PAT)
                </label>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=Nexus+AI+GitHub+Pages+Deploy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                >
                  <span>Create Token</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                  className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => verifyPatToken(token, false)}
                  disabled={isVerifying || !token.trim()}
                  className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isVerifying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Connect</span>}
                </button>
              </div>
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>Required scopes: <code className="text-sky-300 font-mono">repo</code> (and <code className="text-sky-300 font-mono">workflow</code> for Actions)</span>
                <label className="flex items-center gap-1.5 cursor-pointer text-slate-300">
                  <input
                    type="checkbox"
                    checked={rememberToken}
                    onChange={(e) => setRememberToken(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-800 accent-indigo-500"
                  />
                  <span>Remember</span>
                </label>
              </div>
            </div>
          )}

          {/* TAB 1: DEPLOY TO GITHUB PAGES */}
          {activeTab === 'pages' && (
            <div className="space-y-4">
              {/* Current Session Project Summary Card */}
              <div className="p-3.5 bg-slate-900/70 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileCode2 className="w-4 h-4 text-sky-400 flex-shrink-0" />
                    <span className="font-semibold text-white truncate">
                      {sessionTitle || 'Current Session Project'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {isInspectingSession ? (
                      <span className="text-[10px] text-slate-400 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> Scanning...
                      </span>
                    ) : sessionInfo?.exists ? (
                      <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold">
                        {kindLabelMap[sessionInfo.kind] || sessionInfo.kind} · {sessionInfo.fileCount} files
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-md bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-semibold">
                        No Project Built Yet
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={inspectCurrentSession}
                      className="p-1 text-slate-400 hover:text-white rounded cursor-pointer"
                      title="Refresh session files"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isInspectingSession ? 'animate-spin' : ''}`} />
                    </button>
                  </div>
                </div>

                {sessionInfo?.exists ? (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowFilesList(!showFilesList)}
                      className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
                    >
                      {showFilesList ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      <span>
                        {sessionInfo.hasViteConfig
                          ? 'Will run Vite production build with repo base path & push dist/ to gh-pages'
                          : 'Will bundle HTML/PWA & local assets and publish to gh-pages'}
                      </span>
                    </button>
                    {showFilesList && (
                      <div className="mt-2 max-h-28 overflow-y-auto bg-slate-950 border border-slate-800 rounded-lg p-2 font-mono text-[10px] text-slate-300 space-y-0.5">
                        {sessionInfo.files.map((f) => (
                          <div key={f} className="truncate">{f}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-amber-300/90">
                    এই সেশনে এখনো কোনো ওয়েবসাইট বা অ্যাপ তৈরি হয়নি। আগে চ্যাটে কোনো ওয়েবসাইট জেনারেট করুন।
                  </p>
                )}
              </div>

              {/* Repository Settings */}
              <div className="space-y-3">
                <div>
                  <label className="text-slate-300 font-medium block mb-1.5">
                    New Repository Name
                  </label>
                  <div className="flex items-center bg-slate-900 border border-slate-700 rounded-xl overflow-hidden focus-within:border-indigo-500">
                    <span className="px-3 py-2 bg-slate-800/80 text-slate-400 font-mono text-[11px] border-r border-slate-700">
                      {previewOwner}/
                    </span>
                    <input
                      type="text"
                      value={pagesRepoName}
                      onChange={(e) => setPagesRepoName(e.target.value)}
                      placeholder="my-nexus-website"
                      disabled={isDeployingPages}
                      className="flex-1 bg-transparent px-3 py-2 text-white font-mono text-xs focus:outline-none"
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <Globe className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                    <span className="truncate">
                      Live URL: <span className="text-indigo-300 font-mono">{previewPagesUrl}</span>
                    </span>
                  </div>
                </div>

                <div>
                  <label className="text-slate-300 font-medium block mb-1">
                    Repository Description (Optional)
                  </label>
                  <input
                    type="text"
                    value={pagesDescription}
                    onChange={(e) => setPagesDescription(e.target.value)}
                    disabled={isDeployingPages}
                    placeholder="Built & deployed with Nexus AI"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                  <div className="flex items-center gap-1.5 bg-slate-900 p-1 rounded-xl border border-slate-800">
                    <button
                      type="button"
                      onClick={() => setIsPrivateRepo(false)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors ${
                        !isPrivateRepo ? 'bg-emerald-600/25 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Unlock className="w-3 h-3" />
                      <span>Public (Free Pages)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsPrivateRepo(true)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors ${
                        isPrivateRepo ? 'bg-amber-600/25 text-amber-300 border border-amber-500/30' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      <Lock className="w-3 h-3" />
                      <span>Private (Pro)</span>
                    </button>
                  </div>

                  <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={updateIfExists}
                      onChange={(e) => setUpdateIfExists(e.target.checked)}
                      className="rounded border-slate-600 bg-slate-800 accent-indigo-500"
                    />
                    <span>Update if repo exists</span>
                  </label>
                </div>
              </div>

              {/* Live 5-Step Deployment Pipeline */}
              {(isDeployingPages || deploySteps.some((s) => s.status !== 'pending')) && (
                <div className="p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                    Deployment Pipeline
                  </div>
                  {deploySteps.map((step) => (
                    <div key={step.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 flex-shrink-0">
                        {step.status === 'running' ? (
                          <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                        ) : step.status === 'completed' ? (
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                        ) : step.status === 'error' ? (
                          <AlertCircle className="w-3.5 h-3.5 text-rose-400" />
                        ) : (
                          <div className="w-3.5 h-3.5 rounded-full border border-slate-700" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div
                          className={`text-xs font-medium ${
                            step.status === 'completed'
                              ? 'text-emerald-300'
                              : step.status === 'running'
                              ? 'text-white'
                              : step.status === 'error'
                              ? 'text-rose-300'
                              : 'text-slate-500'
                          }`}
                        >
                          {step.label}
                        </div>
                        {step.detail && (
                          <div className="text-[10px] text-slate-400 font-mono truncate">
                            {step.detail}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Successful Deployment Result Card */}
              {deployResult?.success && (
                <div className="p-4 bg-emerald-950/35 border border-emerald-500/35 rounded-xl space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-emerald-300 font-bold text-xs">
                      <CheckCircle className="w-4 h-4 text-emerald-400" />
                      <span>Deployed to GitHub Pages!</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                        livePagesStatus === 'built'
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                          : 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                      }`}
                    >
                      {livePagesStatus === 'built'
                        ? 'Live & Built'
                        : livePagesStatus === 'building'
                        ? 'GitHub Building (~30s)...'
                        : livePagesStatus || 'Published'}
                    </span>
                  </div>

                  {deployResult.pagesUrl && (
                    <div className="flex items-center gap-2 bg-slate-950/90 border border-slate-800 rounded-xl p-2.5">
                      <Globe className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                      <a
                        href={deployResult.pagesUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-indigo-300 hover:text-indigo-200 font-mono text-[11px] truncate underline"
                      >
                        {deployResult.pagesUrl}
                      </a>
                      <button
                        type="button"
                        onClick={copyPagesUrl}
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 cursor-pointer"
                        title="Copy Live URL"
                      >
                        {copiedUrl ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                      <a
                        href={deployResult.pagesUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold flex items-center gap-1"
                      >
                        <span>Visit</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    {deployResult.repoUrl && (
                      <a
                        href={deployResult.repoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-300 hover:text-white flex items-center gap-1.5"
                      >
                        <FolderGit2 className="w-3.5 h-3.5 text-slate-400" />
                        <span>Repository: {deployResult.owner}/{deployResult.repoName}</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {deployResult.buildLogs && (
                      <button
                        type="button"
                        onClick={() => setShowBuildLogs(!showBuildLogs)}
                        className="text-slate-400 hover:text-slate-200 underline cursor-pointer"
                      >
                        {showBuildLogs ? 'Hide build log' : 'View build log'}
                      </button>
                    )}
                  </div>

                  {deployResult.warnings && deployResult.warnings.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[11px] flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        {deployResult.warnings.map((w, idx) => (
                          <div key={idx}>{w}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {showBuildLogs && deployResult.buildLogs && (
                    <pre className="p-2.5 bg-slate-950 border border-slate-800 rounded-lg text-[10px] font-mono text-slate-300 overflow-x-auto max-h-36">
                      {deployResult.buildLogs}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FULL WORKSPACE SYNC */}
          {activeTab === 'sync' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-slate-300 font-medium block">Repository Name:</label>
                <input
                  type="text"
                  value={syncRepo}
                  onChange={(e) => setSyncRepo(e.target.value)}
                  placeholder="my-nexus-app"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-medium block">Commit Message:</label>
                <input
                  type="text"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          )}

          {/* Shared Status / Error Banner */}
          {statusMessage && (
            <div
              className={`p-3 rounded-xl border flex items-center gap-2 text-[11px] ${
                isError
                  ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              }`}
            >
              {isError ? (
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
              ) : (
                <CheckCircle className="w-4 h-4 flex-shrink-0" />
              )}
              <span className="break-words">{statusMessage}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 flex items-center justify-end gap-2 bg-slate-900/40 flex-shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium text-xs cursor-pointer"
          >
            Close
          </button>

          {activeTab === 'pages' ? (
            <button
              type="button"
              onClick={handleDeployToPages}
              disabled={isDeployingPages || !sessionInfo?.exists || (!user && !token.trim() && !serverConfigured)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-lg shadow-indigo-600/20"
            >
              {isDeployingPages ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Building & Deploying...</span>
                </>
              ) : (
                <>
                  <Rocket className="w-3.5 h-3.5" />
                  <span>Build & Deploy to GitHub Pages</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSync}
              disabled={isSyncing || !syncRepo.trim()}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
            >
              {isSyncing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <GitCommit className="w-3.5 h-3.5" />
              )}
              <span>Commit & Push</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
