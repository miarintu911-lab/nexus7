import React, { useState, useEffect, useRef } from 'react';
import { 
  Sparkles, 
  Plus, 
  ArrowLeft, 
  MoreHorizontal, 
  Mic, 
  PlusCircle, 
  ChevronDown, 
  ChevronRight, 
  Square, 
  ArrowUp, 
  CheckCircle2, 
  Flag, 
  Copy, 
  Check, 
  RotateCcw, 
  Download, 
  ExternalLink, 
  RefreshCw, 
  Monitor, 
  Smartphone, 
  FileCode, 
  FolderArchive,
  Menu,
  Zap,
  Key,
  ShoppingBag,
  BarChart3,
  Gamepad2,
  CheckSquare,
  Briefcase,
  ScrollText,
  SlidersHorizontal,
  Bug,
  Bot,
  Eye,
  AlertTriangle,
  X,
  ImagePlus,
  History,
  Undo2,
  ShieldCheck,
  Loader2,
  Crosshair,
  Rocket,
  Flame,
  FileText
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'motion/react';
import { ActionHistoryAccordion } from './ActionHistoryAccordion';
import { AgentStatusStrip } from './AgentStatusStrip';
import { PWAInstallButton } from './PWAInstallButton';
import { ActionStep } from '../types/secrets';
import { getLocalKeys } from '../lib/secretsManager';

interface GoogleAIStudioCoderViewProps {
  messages: any[];
  input: string;
  setInput: (val: string) => void;
  isLoading: boolean;
  actionLog: string | null;
  activityLogs: string[];
  actionSteps?: ActionStep[];
  modifiedFiles: string[];
  currentSessionId: string | null;
  currentSessionTitle: string;
  currentSessionHtml: string | null;
  previewUrl: string;
  previewDevice: 'desktop' | 'mobile';
  setPreviewDevice: (d: 'desktop' | 'mobile') => void;
  previewKey: number;
  setPreviewKey: React.Dispatch<React.SetStateAction<number>>;
  error: string | null;
  cooldown: number;
  handleSend: (
    text?: string | { text: string; attachedImage?: { dataUrl: string; mimeType: string; name: string } | null } | React.MouseEvent
  ) => void;
  handleNewChat: () => void;
  handleDownloadHtml: () => void;
  handleCopyCode: (customText?: string) => void;
  copiedCode: boolean;
  onOpenDrawer: () => void;
  onOpenSettings: () => void;
  onOpenTools: () => void;
  onOpenSecrets?: () => void;
  onOpenLogs?: () => void;
  onOpenGitHubDeploy?: () => void;
  onOpenFirebase?: () => void;
  activeKeysCount?: number;
  currentActiveKeyInfo?: any;
  activeMode: string;
  setActiveMode: (mode: any) => void;
  selectedModel?: string;
  setSelectedModel?: (model: string) => void;
  developerPersona?: string;
  setDeveloperPersona?: (persona: string) => void;
  customSystemInstruction?: string;
  setCustomSystemInstruction?: (instruction: string) => void;
  outputFormat?: 'auto' | 'markdown' | 'json';
  setOutputFormat?: (format: 'auto' | 'markdown' | 'json') => void;
  multiAgent?: boolean;
  setMultiAgent?: (enabled: boolean) => void;
  onAnalyzeError?: (errText: string) => void;
  attachedImage?: { dataUrl: string; mimeType: string; name: string } | null;
  setAttachedImage?: (img: { dataUrl: string; mimeType: string; name: string } | null) => void;
  previewReadySignal?: number;
  executionDuration?: number;
  lastRunDuration?: number;
  onCancel?: () => void;
}

const STARTER_PROMPTS = [
  {
    icon: Smartphone,
    title: "PWA টাস্ক ও নোটস অ্যাপ",
    badge: "PWA Offline",
    color: "from-indigo-500/20 to-purple-500/20 border-indigo-500/30 text-indigo-300",
    prompt: "একটি পূর্ণাঙ্গ প্রগ্রেসিভ ওয়েব অ্যাপ (PWA) টাস্ক ও নোটস ম্যানেজার বানাও যাতে অফলাইন ক্যাশ, ইনস্টল বাটন (beforeinstallprompt), ফিল্টারিং ও লোকালস্টোরেজ পারসিসটেন্স থাকে।"
  },
  {
    icon: ShoppingBag,
    title: "ই-কমার্স শপিং স্টোর",
    badge: "E-Commerce",
    color: "from-emerald-500/20 to-teal-500/20 border-emerald-500/30 text-emerald-300",
    prompt: "একটি আধুনিক গ্যাজেট ও ফ্যাশন ই-কমার্স স্টোর ওয়েবসাইট তৈরি করো যাতে প্রোডাক্ট ফিল্টারিং, ইন্টারেক্টিভ কার্ট ড্রয়ার, কোড ভ্যালিডেশন ও চেকআউট মডাল থাকে।"
  },
  {
    icon: BarChart3,
    title: "SaaS এনালিটিক্স ড্যাশবোর্ড",
    badge: "Dashboard",
    color: "from-blue-500/20 to-cyan-500/20 border-blue-500/30 text-blue-300",
    prompt: "একটি প্রফেশনাল SaaS বিজনেস অ্যানালিটিক্স ড্যাশবোর্ড তৈরি করো যাতে ইন্টারঅ্যাক্টিভ চার্ট, মেট্রিক কেপিআই কার্ড, ডেটা টেবিল ও ডার্ক থিম থাকে।"
  },
  {
    icon: Gamepad2,
    title: "2D ক্যানভাস স্নেক গেম PWA",
    badge: "Game PWA",
    color: "from-amber-500/20 to-orange-500/20 border-amber-500/30 text-amber-300",
    prompt: "একটি রেট্রো স্নেক / আর্কেড গেম PWA তৈরি করো যাতে স্কোরবোর্ড, হাই-স্কোর লোকালস্টোরেজে সেভ, সাউন্ড ইফেক্ট এবং মোবাইল টাচ কন্ট্রোল থাকে।"
  },
  {
    icon: Briefcase,
    title: "ক্রিয়েটিভ পোর্টফোলিও",
    badge: "Portfolio",
    color: "from-fuchsia-500/20 to-pink-500/20 border-fuchsia-500/30 text-fuchsia-300",
    prompt: "একটি আকর্ষণীয় গ্লাসফর্মিজম ডার্ক পোর্টফোলিও ওয়েবসাইট তৈরি করো যাতে প্রোজেক্ট ফিল্টারিং, স্কিল বার, টেস্টিমোনিয়াল ও রিয়েল-টাইম কন্টাক্ট ফর্ম থাকে।"
  },
  {
    icon: CheckSquare,
    title: "ড্র্যাগ & ড্রপ কানবান বোর্ড",
    badge: "Productivity",
    color: "from-rose-500/20 to-red-500/20 border-rose-500/30 text-rose-300",
    prompt: "একটি ইন্টারঅ্যাক্টিভ ড্র্যাগ-অ্যান্ড-ড্রপ কানবান প্রজেক্ট ম্যানেজমেন্ট ওয়েব অ্যাপ বানাও (To Do, In Progress, Done) যাতে লোকালস্টোরেজে টাস্ক সেভ থাকে।"
  }
];

export const GoogleAIStudioCoderView: React.FC<GoogleAIStudioCoderViewProps> = ({
  messages,
  input,
  setInput,
  isLoading,
  actionLog,
  activityLogs,
  actionSteps = [],
  modifiedFiles,
  currentSessionId,
  currentSessionTitle,
  currentSessionHtml,
  previewUrl,
  previewDevice,
  setPreviewDevice,
  previewKey,
  setPreviewKey,
  error,
  cooldown,
  handleSend,
  handleNewChat,
  handleDownloadHtml,
  handleCopyCode,
  copiedCode,
  onOpenDrawer,
  onOpenSettings,
  onOpenTools,
  onOpenSecrets,
  onOpenLogs,
  onOpenGitHubDeploy,
  onOpenFirebase,
  activeKeysCount = 0,
  currentActiveKeyInfo,
  activeMode,
  setActiveMode,
  selectedModel,
  setSelectedModel,
  developerPersona = '',
  setDeveloperPersona,
  customSystemInstruction = '',
  setCustomSystemInstruction,
  outputFormat = 'auto',
  setOutputFormat,
  multiAgent = true,
  setMultiAgent,
  onAnalyzeError,
  attachedImage = null,
  setAttachedImage,
  previewReadySignal = 0,
  executionDuration = 0,
  lastRunDuration = 0,
  onCancel,
}) => {
  const [activeCoderTab, setActiveCoderTab] = useState<'chat' | 'preview' | 'artifacts'>('chat');
  const [isWorkingExpanded, setIsWorkingExpanded] = useState(false);
  const [selectedModelLabel, setSelectedModelLabel] = useState<string>('Default');
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showPersonaPopover, setShowPersonaPopover] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string>('projects/index.html');
  const [artifactContent, setArtifactContent] = useState<string | null>(null);
  const [checkpointToast, setCheckpointToast] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Array<{ message: string; source?: string; line?: number; col?: number }>>([]);
  const [checkpoints, setCheckpoints] = useState<Array<{ id: string; label: string; createdAt: number; fileCount: number }>>([]);
  const [showCheckpointsPopover, setShowCheckpointsPopover] = useState(false);
  const [isCreatingCheckpoint, setIsCreatingCheckpoint] = useState(false);
  const [isRollingBackId, setIsRollingBackId] = useState<string | null>(null);
  const [isVerifyingPreview, setIsVerifyingPreview] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; engine?: string; summary?: string; runtimeErrors?: string[]; renderedTextLength?: number; interactiveElements?: number } | null>(null);
  const [isPickerMode, setIsPickerMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<{ selector: string; tagName: string; textPreview: string; htmlSnippet: string } | null>(null);
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  const [autoHealRuntime, setAutoHealRuntime] = useState<boolean>(true);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const previewIframeRef = useRef<HTMLIFrameElement>(null);
  const lastPreviewSignalRef = useRef<number>(previewReadySignal);
  const autoHealedPreviewKeyRef = useRef<number>(-1);

  const safeSessionSlug = currentSessionId
    ? currentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    : '';
  const sessionScopedFiles = React.useMemo(() => {
    if (!safeSessionSlug) return [];
    const wsPrefix = `workspaces/${safeSessionSlug}/`;
    const projPrefix = `projects/${safeSessionSlug}/`;
    return modifiedFiles.filter((fp) => fp.startsWith(wsPrefix) || fp.startsWith(projPrefix));
  }, [modifiedFiles, safeSessionSlug]);
  const isWorkspaceUrl = Boolean(previewUrl && /(?:^|\/)w\/[^/]+/.test(previewUrl));
  const shouldUseSrcDoc = Boolean(currentSessionHtml && !isWorkspaceUrl);
  const hasSessionZipAvailable = Boolean(
    isWorkspaceUrl ||
    sessionScopedFiles.length > 0 ||
    (safeSessionSlug && previewUrl && previewUrl.includes(safeSessionSlug))
  );
  const safeSrcDocHtml = React.useMemo(() => {
    if (!currentSessionHtml) return '';
    if (/<base\s/i.test(currentSessionHtml)) return currentSessionHtml;
    if (/<head[^>]*>/i.test(currentSessionHtml)) {
      return currentSessionHtml.replace(/<head([^>]*)>/i, '<head$1><base href="/">');
    }
    return `<base href="/">${currentSessionHtml}`;
  }, [currentSessionHtml]);

  useEffect(() => {
    setPreviewErrors([]);
    setIsPickerMode(false);
    setVerifyResult(null);
  }, [previewKey, currentSessionId]);

  useEffect(() => {
    if (!isLoading && previewReadySignal > lastPreviewSignalRef.current) {
      lastPreviewSignalRef.current = previewReadySignal;
      setActiveCoderTab('preview');
      setPreviewKey((k) => k + 1);
    }
  }, [previewReadySignal, isLoading, setPreviewKey]);

  useEffect(() => {
    if (activeCoderTab !== 'preview') {
      setIsIframeLoading(false);
      return;
    }
    setIsIframeLoading(true);
    const fallbackTimer = setTimeout(() => setIsIframeLoading(false), 4500);
    return () => clearTimeout(fallbackTimer);
  }, [activeCoderTab, previewKey, previewUrl, shouldUseSrcDoc]);

  const toggleElementPicker = (next?: boolean) => {
    const enabled = typeof next === 'boolean' ? next : !isPickerMode;
    setIsPickerMode(enabled);
    try {
      previewIframeRef.current?.contentWindow?.postMessage({ type: 'nexus-toggle-picker', enabled }, '*');
    } catch {}
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'nexus-preview-error' && event.data?.payload?.message) {
        setPreviewErrors((prev) => {
          const msg = String(event.data.payload.message);
          if (prev.some((e) => e.message === msg)) return prev;
          return [...prev.slice(-4), event.data.payload];
        });
      } else if (event.data?.type === 'nexus-element-selected' && event.data?.payload?.selector) {
        setSelectedElement(event.data.payload);
        setIsPickerMode(false);
        setActiveCoderTab('chat');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (isLoading || !autoHealRuntime || previewErrors.length === 0) return;
    if (autoHealedPreviewKeyRef.current === previewKey) return;

    const timer = setTimeout(() => {
      autoHealedPreviewKeyRef.current = previewKey;
      const errSummary = previewErrors
        .map((e) => `${e.message}${e.line ? ` (line ${e.line}:${e.col || 0})` : ''}`)
        .join('\n');
      handleSend(
        `[AUTO-HEAL RUNTIME ERROR]: Live Preview-তে নিচের Runtime/Console Error ধরা পড়েছে। অনুগ্রহ করে সংশ্লিষ্ট ফাইলটি inspect (view_file) করে surgical fix (replace_file_content) দাও এবং verify_live_preview দিয়ে যাচাই করো:\n\n\`\`\`\n${errSummary}\n\`\`\``
      );
    }, 350);

    return () => clearTimeout(timer);
  }, [previewErrors, isLoading, autoHealRuntime, previewKey, handleSend]);

  const effectiveModel = selectedModel ?? selectedModelLabel;
  const handleSelectModel = (modelId: string) => {
    setSelectedModelLabel(modelId);
    setSelectedModel?.(modelId);
    setShowModelDropdown(false);
  };
  const baseModelOptions = [
    { id: 'Default', label: 'Default (Key Model)', desc: 'Uses each API key’s chosen model' },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', desc: 'Free tier · ultra-fast & light' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', desc: 'Fast coding & UI builds' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', desc: 'Free tier · 1,500 RPD quota' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', desc: 'Complex multi-file architecture' },
    { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen', desc: 'Flagship deep reasoning' },
    { id: 'deepseek-chat', label: 'DeepSeek Chat (V3 · DeepSeek API)', desc: 'DeepSeek API · fast coding & tool calling' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1 · DeepSeek API)', desc: 'DeepSeek API · deep reasoning' },
    { id: 'deepseek-ai/DeepSeek-V4-Flash:cheapest', label: 'DeepSeek V4 Flash (:cheapest · HF)', desc: 'HF Router lowest-cost · $0.18/1M' },
    { id: 'Qwen/Qwen3-32B:cheapest', label: 'Qwen 3 32B (:cheapest · HF)', desc: 'HF Router coding · $0.28/1M' },
    { id: 'Qwen/Qwen3.5-9B:cheapest', label: 'Qwen 3.5 9B (:cheapest · HF)', desc: 'HF Router light · $0.15/1M' },
    { id: 'meta-llama/Llama-3.1-8B-Instruct:cheapest', label: 'Llama 3.1 8B (:cheapest · HF)', desc: 'HF Router cheapest · $0.05/1M' },
    { id: 'deepseek/deepseek-r1:free', label: 'DeepSeek R1 (:free · OpenRouter)', desc: 'OpenRouter free reasoning' },
    { id: 'deepseek/deepseek-chat-v3-0324:free', label: 'DeepSeek V3 (:free · OpenRouter)', desc: 'OpenRouter free coding' },
  ];
  const MODEL_OPTIONS = (() => {
    const seen = new Set(baseModelOptions.map((m) => m.id));
    const extras: typeof baseModelOptions = [];
    try {
      for (const k of getLocalKeys()) {
        if (!k.isActive || !k.model || seen.has(k.model)) continue;
        seen.add(k.model);
        extras.push({
          id: k.model,
          label: k.model.split('/').pop() || k.model,
          desc: `Configured on ${k.provider.toUpperCase()} (${k.name})`,
        });
      }
    } catch {}
    return [...baseModelOptions, ...extras];
  })();
  const PERSONA_OPTIONS = [
    { id: '', label: 'Default Senior Engineer' },
    { id: 'Senior React & TypeScript Specialist', label: 'React & TypeScript' },
    { id: 'Node.js & Express API Architect', label: 'Node.js & Express' },
    { id: 'Python & Automation Engineer', label: 'Python & Automation' },
    { id: 'Debugging & QA Specialist', label: 'Debugging & Error Analysis' },
  ];
  const hasActiveSystemConfig = Boolean(developerPersona || customSystemInstruction.trim() || outputFormat !== 'auto');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionScopedFiles.length > 0) {
      if (!sessionScopedFiles.includes(selectedArtifact)) {
        const preferred =
          sessionScopedFiles.find((f) => f.endsWith('/src/App.tsx')) ||
          sessionScopedFiles.find((f) => f.endsWith('/index.html')) ||
          sessionScopedFiles[0];
        setSelectedArtifact(preferred);
        return;
      }
    } else if (safeSessionSlug && shouldUseSrcDoc) {
      const sessionHtmlPath = `projects/${safeSessionSlug}/index.html`;
      if (selectedArtifact !== sessionHtmlPath) {
        setSelectedArtifact(sessionHtmlPath);
        return;
      }
    }

    if (activeCoderTab !== 'artifacts') return;

    if (selectedArtifact.startsWith('projects/') && selectedArtifact.endsWith('index.html') && shouldUseSrcDoc) {
      setArtifactContent(currentSessionHtml);
      return;
    }
    if (safeSessionSlug && sessionScopedFiles.length === 0 && !shouldUseSrcDoc) {
      setArtifactContent(`// ${currentSessionTitle || 'New Chat'}\n// এই চ্যাটে এখনো কোনো ওয়েবসাইট ফাইল তৈরি হয়নি।`);
      return;
    }

    setArtifactContent('Loading file...');
    fetch('/api/tools/file-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: selectedArtifact }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.content !== undefined) setArtifactContent(data.content);
        else setArtifactContent(`// ${selectedArtifact}\n// ${data.error || 'File ready in workspace'}`);
      })
      .catch(() => setArtifactContent(`// Failed to read ${selectedArtifact}`));
  }, [activeCoderTab, selectedArtifact, currentSessionHtml, shouldUseSrcDoc, sessionScopedFiles, safeSessionSlug, currentSessionTitle]);

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s}s`;
  };

  const handleVoiceInput = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("ভয়েস টাইপিংয়ের জন্য Chrome বা поддержиকারী ব্রাউজার ব্যবহার করুন।");
      return;
    }
    try {
      const recognition = new SpeechRecognition();
      recognition.lang = 'bn-BD';
      recognition.interimResults = false;
      setIsListening(true);
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setInput(input ? `${input} ${transcript}` : transcript);
        setIsListening(false);
      };
      recognition.onerror = () => setIsListening(false);
      recognition.onend = () => setIsListening(false);
      recognition.start();
    } catch {
      setIsListening(false);
    }
  };

  const fetchCheckpoints = async () => {
    try {
      const res = await fetch('/api/git/checkpoints');
      const data = await res.json();
      if (res.ok && Array.isArray(data.checkpoints)) {
        setCheckpoints(data.checkpoints);
      }
    } catch {}
  };

  useEffect(() => {
    fetchCheckpoints();
  }, []);

  const handleCheckpoint = async (customLabel?: string) => {
    if (isCreatingCheckpoint) return;
    setIsCreatingCheckpoint(true);
    try {
      const label = customLabel || `Checkpoint (${new Date().toLocaleTimeString()})`;
      const res = await fetch('/api/git/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      if (res.ok && data.checkpoint) {
        setCheckpointToast(`✓ Snapshot saved (${data.checkpoint.fileCount} files)`);
        fetchCheckpoints();
      } else {
        setCheckpointToast('✓ Checkpoint noted');
      }
    } catch {
      setCheckpointToast('✓ Checkpoint saved locally');
    } finally {
      setIsCreatingCheckpoint(false);
      setTimeout(() => setCheckpointToast(null), 3000);
    }
  };

  const handleRollback = async (checkpointId: string) => {
    if (isRollingBackId) return;
    setIsRollingBackId(checkpointId);
    try {
      const res = await fetch('/api/git/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpointId }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setCheckpointToast(`↺ Rolled back (${data.restoredCount} files restored)`);
        setPreviewKey((k) => k + 1);
        setShowCheckpointsPopover(false);
      } else {
        setCheckpointToast(`⚠ Rollback failed: ${data.error || 'Unknown error'}`);
      }
    } catch (err: any) {
      setCheckpointToast(`⚠ Rollback error: ${err.message}`);
    } finally {
      setIsRollingBackId(null);
      setTimeout(() => setCheckpointToast(null), 3500);
    }
  };

  const handleImageFileSelect = (file?: File | null) => {
    if (!file || !setAttachedImage) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    const isImg = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name || '');
    if ((!isPdf && !isImg) || file.size > 15 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAttachedImage({
          dataUrl: reader.result,
          mimeType: isPdf ? 'application/pdf' : (file.type || 'image/png'),
          name: file.name || (isPdf ? 'document.pdf' : 'screenshot.png'),
        });
      }
    };
    reader.readAsDataURL(file);
  };

  const handleVerifyPreviewDom = async () => {
    if (isVerifyingPreview) return;
    setIsVerifyingPreview(true);
    setVerifyResult(null);
    try {
      let target = currentSessionId
        ? `/projects/${currentSessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
        : '/projects/index.html';
      if (previewUrl) {
        try {
          target = new URL(previewUrl, window.location.origin).pathname;
        } catch {
          target = previewUrl;
        }
      }
      const res = await fetch('/api/tools/verify-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: target, sessionId: currentSessionId }),
      });
      const data = await res.json();
      const rtErrors: string[] = [
        ...(Array.isArray(data.syntaxErrors) ? data.syntaxErrors.map((e: any) => typeof e === 'string' ? e : `Script #${e.scriptIndex}: ${e.error}`) : []),
        ...(Array.isArray(data.runtimeErrors) ? data.runtimeErrors.map((e: any) => typeof e === 'string' ? e : `${e.source || 'runtime'}: ${e.message}`) : []),
        ...(Array.isArray(data.interactionAudit?.clickErrors) ? data.interactionAudit.clickErrors.map((e: string) => `Click probe: ${e}`) : []),
        ...(Array.isArray(data.brokenAssets) ? data.brokenAssets.map((a: any) => `Asset ${a.url} (${a.status})`) : []),
        ...(Array.isArray(data.consoleErrors) ? data.consoleErrors : []),
      ];
      const textLen = data.domMetrics?.renderedTextLength ?? 0;
      const controls = data.domMetrics?.interactiveElements ?? 0;
      const probed = data.interactionAudit?.probedButtons ?? 0;
      const imgs = data.domMetrics?.imagesCount ?? 0;
      setVerifyResult({
        ok: Boolean(data.ok),
        engine: data.engine || 'jsdom',
        renderedTextLength: textLen,
        interactiveElements: controls,
        runtimeErrors: rtErrors,
        summary: data.ok
          ? `Verified via ${data.engine || 'jsdom'}: ${textLen} chars, ${controls} controls (${probed} clicked OK), ${imgs} imgs`
          : `Detected ${rtErrors.length} issue(s)${data.domMetrics?.emptyRootDetected ? ' (empty #root)' : ''}${data.hasClosedHtml === false ? ' (truncated HTML)' : ''} via ${data.engine || 'jsdom'}`,
      });
    } catch (err: any) {
      setVerifyResult({
        ok: false,
        runtimeErrors: [err.message || 'Verification failed'],
        summary: err.message || 'Verification failed',
      });
    } finally {
      setIsVerifyingPreview(false);
    }
  };

  const handleDownloadZip = () => {
    if (currentSessionId) {
      const params = new URLSearchParams({
        sessionId: currentSessionId,
        title: currentSessionTitle || 'website',
      });
      window.location.href = `/api/project/download?${params.toString()}`;
      return;
    }
    window.location.href = '/api/project/download';
  };

  useEffect(() => {
    if (activeCoderTab === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, activeCoderTab, isLoading]);

  // Render message text cleanly: strip internal tool_calls JSON, collapse full code dumps into preview badge, and parse Markdown + fenced code properly
  const renderMessageContent = (text: string) => {
    if (!text) return null;

    let displayText = text;
    let strippedCodeDump = false;

    // 1. Defensively strip any residual raw tool_calls JSON or <tool_call> blocks
    displayText = displayText
      .replace(/<(?:tool_call|function_call)>[\s\S]*?<\/(?:tool_call|function_call)>/gi, '')
      .replace(/`{0,3}(?:json)?\s*\{\s*"tool_calls"[\s\S]*?(?:`{2,3}|$)/gi, '')
      .replace(/\{\s*"tool_calls"\s*:\s*\[[\s\S]*?(?:\}\s*\]\s*\}|$)/gi, '')
      .replace(/(?:^|\n)\s*`{1,3}\s*(?=\n|$)/g, '\n');

    // 2. Collapse accidental full HTML or large file dumps into the workspace preview card
    const fullHtmlFence = /```(?:html|htm)\s*[\s\S]{300,}?```/gi;
    if (fullHtmlFence.test(displayText)) {
      strippedCodeDump = true;
      displayText = displayText.replace(fullHtmlFence, '').trim();
    }

    const rawDocHtml = /<!DOCTYPE\s+html[\s\S]{300,}?<\/html>/gi;
    if (rawDocHtml.test(displayText)) {
      strippedCodeDump = true;
      displayText = displayText.replace(rawDocHtml, '').trim();
    }

    displayText = displayText.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (full, _lang, codeBody) => {
      const lineCount = codeBody.split('\n').length;
      if (lineCount > 28 || codeBody.length > 900) {
        strippedCodeDump = true;
        return '';
      }
      return full;
    }).trim();

    const renderInlineTokens = (line: string, keyPrefix: string) => {
      const tokens = line.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
      return tokens.map((token, idx) => {
        if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
          return (
            <code
              key={`${keyPrefix}-c-${idx}`}
              className="inline-block px-1.5 py-0.5 mx-0.5 rounded bg-[#28292c] text-emerald-300 font-mono text-xs border border-slate-700/60 shadow-sm"
            >
              {token.slice(1, -1)}
            </code>
          );
        }
        if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
          return (
            <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold text-white">
              {token.slice(2, -2)}
            </strong>
          );
        }
        return <React.Fragment key={`${keyPrefix}-t-${idx}`}>{token}</React.Fragment>;
      });
    };

    const renderTextSegment = (segment: string, segIdx: number) => {
      const lines = segment.split('\n');
      return (
        <div key={`seg-${segIdx}`} className="space-y-1.5">
          {lines.map((line, lIdx) => {
            const trimmed = line.trim();
            if (!trimmed) {
              return <div key={`sp-${segIdx}-${lIdx}`} className="h-1" />;
            }
            const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
            if (headingMatch) {
              const level = headingMatch[1].length;
              return (
                <div
                  key={`hd-${segIdx}-${lIdx}`}
                  className={cn(
                    "font-semibold text-white pt-1",
                    level === 1 ? "text-base" : level === 2 ? "text-[15px]" : "text-sm text-sky-200"
                  )}
                >
                  {renderInlineTokens(headingMatch[2], `h-${segIdx}-${lIdx}`)}
                </div>
              );
            }
            const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
            if (bulletMatch) {
              return (
                <div key={`bl-${segIdx}-${lIdx}`} className="flex items-start gap-2 pl-1">
                  <span className="text-sky-400 mt-1.5 w-1.5 h-1.5 rounded-full bg-sky-400 flex-shrink-0" />
                  <div className="flex-1">{renderInlineTokens(bulletMatch[1], `b-${segIdx}-${lIdx}`)}</div>
                </div>
              );
            }
            return (
              <p key={`p-${segIdx}-${lIdx}`} className="leading-relaxed">
                {renderInlineTokens(line, `p-${segIdx}-${lIdx}`)}
              </p>
            );
          })}
        </div>
      );
    };

    // Split cleanly by triple-backtick code fences BEFORE any inline backtick parsing
    const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
    const blocks: Array<{ type: 'text' | 'code'; lang?: string; content: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(displayText)) !== null) {
      if (match.index > lastIndex) {
        blocks.push({ type: 'text', content: displayText.slice(lastIndex, match.index) });
      }
      blocks.push({ type: 'code', lang: match[1] || 'text', content: match[2].trimEnd() });
      lastIndex = fenceRegex.lastIndex;
    }
    if (lastIndex < displayText.length) {
      blocks.push({ type: 'text', content: displayText.slice(lastIndex) });
    }

    return (
      <div className="space-y-2.5 text-sm leading-relaxed text-slate-100">
        {blocks.map((block, idx) =>
          block.type === 'code' ? (
            <div key={`code-${idx}`} className="rounded-xl bg-[#18191e] border border-slate-700/70 overflow-hidden my-2">
              <div className="px-3 py-1.5 bg-[#202229] border-b border-slate-700/60 text-[11px] font-mono text-slate-400 uppercase tracking-wider">
                {block.lang || 'code'}
              </div>
              <pre className="p-3 overflow-x-auto text-xs font-mono text-emerald-300 leading-relaxed">
                <code>{block.content}</code>
              </pre>
            </div>
          ) : (
            renderTextSegment(block.content, idx)
          )
        )}
        {strippedCodeDump && (
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-xs text-emerald-200">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              <span>অ্যাপ/ওয়েবসাইটের কোড সরাসরি ওয়ার্কস্পেস ফাইলে সেভ করা হয়েছে এবং Live Preview প্রস্তুত।</span>
            </div>
            <button
              onClick={() => {
                setActiveCoderTab('preview');
                setPreviewKey(k => k + 1);
              }}
              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold flex items-center gap-1 flex-shrink-0 cursor-pointer"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>Preview</span>
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full w-full min-h-0 bg-[#131314] text-slate-100 font-sans overflow-hidden select-none">
      {/* Toast Notification */}
      <AnimatePresence>
        {checkpointToast && (
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 bg-[#1c1d22] border border-emerald-500/40 text-emerald-300 px-4 py-2 rounded-full text-xs font-semibold shadow-2xl z-50 flex items-center gap-2"
          >
            <Check className="w-4 h-4 text-emerald-400" />
            <span>{checkpointToast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Header matching Google AI Studio screenshot */}
      <header className="h-14 border-b border-slate-800/80 flex items-center justify-between px-2.5 sm:px-4 bg-[#131314] sticky top-0 z-30 flex-shrink-0 gap-1.5 sm:gap-2">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          <button
            onClick={onOpenDrawer}
            className="p-1.5 -ml-1 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer flex-shrink-0"
            title="Menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Sparkles className="w-4 h-4 text-sky-400 fill-sky-400 flex-shrink-0" />
            <span className="font-semibold text-slate-100 text-sm tracking-tight whitespace-nowrap">Nexus AI</span>
          </div>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {/* Mobile & Desktop PWA Install App Button */}
          <PWAInstallButton />

          {/* Key Pool Status Badge */}
          {onOpenSecrets && (
            <button
              onClick={onOpenSecrets}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-[#282a30] text-slate-200 border border-slate-700/60 transition-colors cursor-pointer"
              title="Manage API Keys & Secrets"
            >
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">
                {activeKeysCount > 0 
                  ? `${activeKeysCount}টি সচল কী` 
                  : 'কী যোগ করুন'}
              </span>
              {activeKeysCount > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              )}
            </button>
          )}

          {/* Firebase Autonomous Engine Button */}
          {onOpenFirebase && (
            <button
              onClick={onOpenFirebase}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-amber-950/40 text-amber-300 border border-amber-500/30 transition-colors cursor-pointer"
              title="Firebase Auto-Config & Firestore Rules"
            >
              <Flame className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden lg:inline">Firebase</span>
            </button>
          )}

          {/* Diagnostics / Logs Button */}
          {onOpenLogs && (
            <button
              onClick={onOpenLogs}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-rose-950/40 text-rose-300 border border-rose-500/30 transition-colors cursor-pointer"
              title="সিস্টেম সমস্যা ও এরর লগ"
            >
              <ScrollText className="w-3.5 h-3.5 text-rose-400" />
              <span className="hidden md:inline">লগ</span>
            </button>
          )}

          {/* Checkpoints & 1-Click Rollback */}
          <div className="relative">
            <button
              onClick={() => {
                const next = !showCheckpointsPopover;
                setShowCheckpointsPopover(next);
                if (next) fetchCheckpoints();
              }}
              className="flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full text-[11px] font-medium bg-[#1e2024] hover:bg-[#282a30] text-slate-200 border border-slate-700/60 transition-colors cursor-pointer"
              title="Snapshots & 1-Click Rollback"
            >
              <History className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden md:inline">Checkpoints</span>
              {checkpoints.length > 0 && (
                <span className="text-[10px] px-1 rounded bg-slate-800 text-slate-300 font-mono">{checkpoints.length}</span>
              )}
            </button>

            {showCheckpointsPopover && (
              <div className="absolute right-0 top-full mt-2 w-80 bg-[#1a1c21] border border-slate-700 rounded-2xl p-3 shadow-2xl z-50 space-y-2.5">
                <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <History className="w-3.5 h-3.5 text-emerald-400" />
                    Workspace Checkpoints
                  </span>
                  <button
                    onClick={() => handleCheckpoint('Manual Snapshot')}
                    disabled={isCreatingCheckpoint}
                    className="px-2 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold cursor-pointer"
                  >
                    {isCreatingCheckpoint ? 'Saving...' : '+ Save Now'}
                  </button>
                </div>

                {checkpoints.length === 0 ? (
                  <p className="text-[11px] text-slate-400 py-3 text-center">
                    এখনো কোনো স্ন্যাপশট সেভ করা হয়নি।
                  </p>
                ) : (
                  <div className="max-h-60 overflow-y-auto space-y-1.5">
                    {checkpoints.map((cp) => (
                      <div
                        key={cp.id}
                        className="p-2 rounded-xl bg-[#121317] border border-slate-800 flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[11px] font-semibold text-slate-200 truncate">{cp.label}</div>
                          <div className="text-[10px] text-slate-500 font-mono">
                            {new Date(cp.createdAt).toLocaleTimeString()} · {cp.fileCount} files
                          </div>
                        </div>
                        <button
                          onClick={() => handleRollback(cp.id)}
                          disabled={isRollingBackId === cp.id}
                          className="px-2 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1 flex-shrink-0 cursor-pointer"
                          title="1-Click Rollback"
                        >
                          <Undo2 className="w-3 h-3" />
                          <span>{isRollingBackId === cp.id ? '...' : 'Rollback'}</span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Mode Badge */}
          <button
            onClick={() => setActiveMode(activeMode === 'coding' ? 'general' : 'coding')}
            className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 rounded-full text-[11px] font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/20 transition-colors cursor-pointer"
            title="Switch Mode"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="hidden sm:inline">Nexus Coder</span>
            <span className="sm:hidden">Coder</span>
          </button>

          {/* Plus (New Chat) Button matching screenshot top right */}
          <button
            onClick={handleNewChat}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800/80 rounded-lg transition-colors cursor-pointer"
            title="New Chat (+)"
          >
            <Plus className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Body Area (Chat / Preview / Artifacts) */}
      <main className="flex-1 min-h-0 overflow-hidden flex flex-col relative">
        {/* --- TAB 1: CHAT VIEW --- */}
        {activeCoderTab === 'chat' && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {/* Conversation Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-5 space-y-6 scrollbar-thin scrollbar-thumb-slate-800">
              {/* Empty State / Starter Templates */}
              {messages.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center max-w-2xl mx-auto py-6 text-center">
                  <div className="w-14 h-14 bg-gradient-to-tr from-sky-500/20 to-indigo-500/20 border border-sky-500/30 rounded-2xl flex items-center justify-center mb-4 text-sky-400 shadow-xl">
                    <Sparkles className="w-7 h-7" />
                  </div>
                  <h2 className="text-xl sm:text-2xl font-bold mb-2 text-white">
                    Google AI Studio Coder Engine
                  </h2>
                  <p className="text-slate-400 text-xs sm:text-sm mb-6 max-w-md leading-relaxed">
                    সব কাজ হবে সরাসরি এই সিস্টেমে। যেকোনো PWA, ই-কমার্স, ড্যাশবোর্ড বা গেম তৈরি করতে নিচের প্রম্পট সিলেক্ট করুন অথবা নিচে লিখুন।
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full text-left">
                    {STARTER_PROMPTS.map((item, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(item.prompt)}
                        className="p-3.5 rounded-2xl bg-[#1e2024]/70 hover:bg-[#25272c] border border-slate-800 hover:border-slate-700 transition-all flex items-start gap-3 text-left group"
                      >
                        <div className={cn("w-8 h-8 rounded-xl flex items-center justify-center bg-gradient-to-br border flex-shrink-0 mt-0.5", item.color)}>
                          <item.icon className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className="text-xs font-bold text-slate-200 group-hover:text-sky-300 transition-colors truncate">
                              {item.title}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-slate-400 font-mono">
                              {item.badge}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                            {item.prompt}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Message List */}
              {messages.map((m, i) => {
                const isUser = m.role === 'user';
                const isLatestStreamingModel = isLoading && i === messages.length - 1 && !isUser;
                const msgSteps: ActionStep[] = isLatestStreamingModel
                  ? actionSteps
                  : (Array.isArray(m.actionSteps) ? m.actionSteps : []);
                const msgFiles: string[] = isLatestStreamingModel
                  ? modifiedFiles
                  : (Array.isArray(m.modifiedFiles) ? m.modifiedFiles : []);
                const hasHtmlUpdate = msgFiles.some((f) =>
                  f.endsWith('.html') || f.startsWith('workspaces/') || f.includes('/w/')
                );

                return (
                  <div key={i} className="max-w-2xl mx-auto w-full space-y-2">
                    {!isUser ? (
                      /* Model Message matching Google AI Studio screenshot */
                      <div className="space-y-2">
                        {(isLatestStreamingModel || msgSteps.length > 0 || msgFiles.length > 0) && (
                          <ActionHistoryAccordion
                            steps={msgSteps}
                            modifiedFiles={msgFiles}
                            isLoading={isLatestStreamingModel}
                            modelName={m.keyInfo?.model || (currentActiveKeyInfo?.model || (effectiveModel === 'Default' ? 'Gemini 3.8 Flash' : effectiveModel))}
                            durationText={
                              isLatestStreamingModel
                                ? formatDuration(executionDuration)
                                : m.wasCancelled
                                  ? `Stopped${m.runDuration ? ` (${formatDuration(m.runDuration)})` : ''}`
                                  : m.runDuration
                                    ? formatDuration(m.runDuration)
                                    : lastRunDuration > 0 && i === messages.length - 1
                                      ? formatDuration(lastRunDuration)
                                      : 'Done'
                            }
                            defaultExpanded={isLatestStreamingModel}
                            multiAgent={multiAgent}
                          />
                        )}

                        {/* Model response body */}
                        <div className="text-slate-100 text-sm leading-relaxed pt-1 select-text">
                          {renderMessageContent(m.parts[0]?.text || '')}
                        </div>

                        {/* Quick Live Preview jump pill when HTML files were modified */}
                        {hasHtmlUpdate && !isLatestStreamingModel && (
                          <div className="pt-1">
                            <button
                              onClick={() => {
                                setActiveCoderTab('preview');
                                setPreviewKey(k => k + 1);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 text-xs font-semibold transition-colors cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Live Preview-এ দেখুন</span>
                            </button>
                          </div>
                        )}

                        {/* Action buttons matching screenshot: ⚑ Checkpoint | Copy | Redo */}
                        <div className="pt-2 flex items-center justify-between text-xs text-slate-400 border-t border-slate-800/40">
                          <button
                            onClick={() => handleCheckpoint(`Chat Step ${i + 1}`)}
                            className="inline-flex items-center gap-1.5 hover:text-white transition-colors cursor-pointer"
                            title="Save Checkpoint"
                          >
                            <Flag className="w-3.5 h-3.5 text-slate-400" />
                            <span>Checkpoint</span>
                          </button>

                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(m.parts[0]?.text || '');
                                setCheckpointToast("✓ Copied to clipboard");
                                setTimeout(() => setCheckpointToast(null), 2000);
                              }}
                              className="p-1 hover:text-white transition-colors cursor-pointer"
                              title="Copy"
                            >
                              <Copy className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => {
                                let retryText = '';
                                let retryImage: { dataUrl: string; mimeType: string; name: string } | null = null;
                                for (let j = i - 1; j >= 0; j--) {
                                  if (messages[j]?.role === 'user') {
                                    retryText = messages[j]?.parts?.[0]?.text || '';
                                    if (messages[j]?.imageDataUrl) {
                                      retryImage = {
                                        dataUrl: messages[j].imageDataUrl,
                                        mimeType: messages[j].parts?.[1]?.inlineData?.mimeType || 'image/png',
                                        name: messages[j].imageName || 'screenshot.png',
                                      };
                                    }
                                    break;
                                  }
                                }
                                if (retryText || retryImage) {
                                  handleSend({ text: retryText, attachedImage: retryImage });
                                }
                              }}
                              className="p-1 hover:text-white transition-colors cursor-pointer"
                              title="Redo / Retry prompt"
                            >
                              <RotateCcw className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* User Message card matching screenshot: dark rounded box */
                      <div className="flex justify-end">
                        <div className="bg-[#242529] border border-slate-800/80 rounded-2xl p-4 text-slate-100 text-sm max-w-xl leading-relaxed shadow-md space-y-2 select-text">
                          {m.imageDataUrl && (
                            m.imageDataUrl.startsWith('data:application/pdf') ||
                            m.parts?.[1]?.inlineData?.mimeType === 'application/pdf' ||
                            /\.pdf$/i.test(m.imageName || '') ? (
                              <div className="inline-flex items-center gap-2.5 px-3 py-2 rounded-xl bg-[#18191d] border border-rose-500/30">
                                <div className="w-8 h-8 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
                                  <FileText className="w-4 h-4 text-rose-400" />
                                </div>
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-slate-200 truncate max-w-[200px]">{m.imageName || 'Document.pdf'}</div>
                                  <div className="text-[10px] text-rose-300 font-bold uppercase tracking-wider">PDF Document</div>
                                </div>
                              </div>
                            ) : (
                              <img
                                src={m.imageDataUrl}
                                alt={m.imageName || 'Attached screenshot'}
                                className="max-h-48 rounded-xl border border-slate-700/70 object-contain"
                              />
                            )
                          )}
                          <div>{m.parts[0]?.text}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Real-time Execution Card before first text chunk arrives */}
              {isLoading && messages[messages.length - 1]?.role !== 'model' && (
                <div className="max-w-2xl mx-auto w-full space-y-3 pt-2">
                  <ActionHistoryAccordion
                    steps={actionSteps}
                    modifiedFiles={modifiedFiles}
                    isLoading={true}
                    modelName={currentActiveKeyInfo?.model || (effectiveModel === 'Default' ? 'Gemini 3.8 Flash' : effectiveModel)}
                    durationText={formatDuration(executionDuration)}
                    defaultExpanded={true}
                    multiAgent={multiAgent}
                  />
                </div>
              )}

              {/* Error box */}
              {error && (
                <div className="max-w-2xl mx-auto w-full p-3.5 bg-rose-500/10 border border-rose-500/25 rounded-2xl text-rose-300 text-xs flex flex-wrap items-center justify-between gap-2.5 shadow-lg">
                  <div className="flex-1 whitespace-pre-wrap leading-relaxed">{error}</div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {onAnalyzeError && (
                      <button
                        onClick={() => onAnalyzeError(error)}
                        className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 rounded-xl font-bold text-[11px] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                      >
                        <Bug className="w-3.5 h-3.5 text-amber-400" />
                        <span>Debug & Fix</span>
                      </button>
                    )}
                    {onOpenLogs && (
                      <button
                        onClick={onOpenLogs}
                        className="px-3 py-1.5 bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/30 rounded-xl font-bold text-[11px] flex items-center gap-1.5 transition-all cursor-pointer shadow-sm"
                      >
                        <ScrollText className="w-3.5 h-3.5 text-rose-400" />
                        <span>লগ দেখুন</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Input Card Container matching screenshot */}
            <div className="px-4 py-3 bg-[#131314] flex-shrink-0 space-y-2">
              {multiAgent && (
                <div className="max-w-2xl mx-auto">
                  <AgentStatusStrip
                    steps={actionSteps}
                    isLoading={isLoading}
                    actionLog={actionLog}
                    activeModel={currentActiveKeyInfo?.model || (effectiveModel === 'Default' ? 'Gemini 3.8 Flash' : effectiveModel)}
                    variant="bar"
                  />
                </div>
              )}
              <div className="max-w-2xl mx-auto bg-[#1e2024] border border-slate-700/60 rounded-3xl p-3 shadow-2xl flex flex-col gap-2">
                {attachedImage && (
                  <div className="flex items-center gap-2 px-1.5 pt-1">
                    <div className="relative inline-flex items-center gap-2 bg-[#131314] border border-slate-700 rounded-xl p-1.5 pr-7">
                      {attachedImage.mimeType === 'application/pdf' || attachedImage.dataUrl.startsWith('data:application/pdf') ? (
                        <div className="w-10 h-10 rounded-lg bg-rose-500/15 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
                          <FileText className="w-5 h-5 text-rose-400" />
                        </div>
                      ) : (
                        <img
                          src={attachedImage.dataUrl}
                          alt={attachedImage.name}
                          className="w-10 h-10 rounded-lg object-cover border border-slate-800"
                        />
                      )}
                      <div className="text-[11px] text-slate-300 max-w-[160px] truncate">{attachedImage.name}</div>
                      <button
                        type="button"
                        onClick={() => setAttachedImage?.(null)}
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-slate-800 hover:bg-rose-500/30 text-slate-400 hover:text-white cursor-pointer"
                        title="ফাইল সরান"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                )}

                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*,application/pdf,.pdf"
                  className="hidden"
                  onChange={(e) => {
                    handleImageFileSelect(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />

                {selectedElement && (
                  <div className="mb-2 flex items-center justify-between gap-2 px-3 py-1.5 rounded-xl bg-indigo-500/15 border border-indigo-500/35 text-xs text-indigo-200">
                    <div className="flex items-center gap-2 min-w-0">
                      <Crosshair className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                      <span className="font-mono text-[11px] font-semibold text-indigo-300 truncate">
                        {selectedElement.selector}
                      </span>
                      {selectedElement.textPreview && (
                        <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                          "{selectedElement.textPreview}"
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedElement(null)}
                      className="p-0.5 rounded-full text-slate-400 hover:text-white cursor-pointer"
                      title="Clear selected element"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPaste={(e) => {
                    const items = Array.from(e.clipboardData?.items || []);
                    const imgItem = items.find((it) => it.type.startsWith('image/'));
                    if (imgItem) {
                      const file = imgItem.getAsFile();
                      if (file) {
                        e.preventDefault();
                        handleImageFileSelect(file);
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (selectedElement && input.trim()) {
                        const targetNote = `[FOCUS MODE TARGET ELEMENT]\nCSS Selector: ${selectedElement.selector}\nSnippet: ${selectedElement.htmlSnippet}\nApply surgical focus_mode edit only to this element: ${input.trim()}`;
                        setSelectedElement(null);
                        setInput('');
                        handleSend(targetNote);
                      } else if (input.trim() || attachedImage) {
                        handleSend();
                      }
                    }
                  }}
                  placeholder={selectedElement ? `Describe change for ${selectedElement.selector}...` : "Make changes, paste a UI screenshot, or ask for anything"}
                  rows={2}
                  className="w-full bg-transparent resize-none focus:outline-none text-slate-100 placeholder:text-slate-500 text-sm px-1.5 py-1"
                />

                <div className="flex items-center justify-between pt-1">
                  {/* Left: ⊕ PlusCircle + Image Upload + System Instructions & Persona button */}
                  <div className="flex items-center gap-1.5 relative">
                    <button 
                      onClick={onOpenTools}
                      className="p-1.5 text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition-colors cursor-pointer"
                      title="Coding Tools, Sandbox & Skills"
                    >
                      <PlusCircle className="w-5 h-5" />
                    </button>

                    {setAttachedImage && (
                      <button
                        type="button"
                        onClick={() => imageInputRef.current?.click()}
                        className={cn(
                          "p-1.5 rounded-full transition-colors cursor-pointer",
                          attachedImage
                            ? "bg-sky-500/20 text-sky-300"
                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                        )}
                        title="ছবি বা PDF আপলোড করুন (Image / PDF Input)"
                      >
                        <ImagePlus className="w-4 h-4" />
                      </button>
                    )}

                    <div className="relative">
                      <button
                        onClick={() => {
                          setShowPersonaPopover(!showPersonaPopover);
                          setShowModelDropdown(false);
                        }}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                          hasActiveSystemConfig
                            ? "bg-indigo-500/20 border-indigo-500/40 text-indigo-300"
                            : "bg-[#27282d] hover:bg-[#2f3137] border-slate-700/80 text-slate-300"
                        )}
                        title="System Instructions, Developer Persona & Output Format"
                      >
                        <SlidersHorizontal className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">
                          {developerPersona ? developerPersona.split(' ')[0] : 'Persona'}
                          {outputFormat !== 'auto' ? ` · ${outputFormat.toUpperCase()}` : ''}
                        </span>
                      </button>

                      {showPersonaPopover && (
                        <div className="absolute bottom-full mb-2 left-0 bg-[#1c1d22] border border-slate-700 rounded-2xl p-3.5 shadow-2xl z-50 w-80 space-y-3">
                          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                            <span className="text-xs font-bold text-white">System Instructions & Format</span>
                            <button
                              onClick={() => setShowPersonaPopover(false)}
                              className="text-[11px] text-slate-400 hover:text-white cursor-pointer"
                            >
                              Done
                            </button>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Developer Persona</label>
                            <select
                              value={developerPersona}
                              onChange={(e) => setDeveloperPersona?.(e.target.value)}
                              className="w-full bg-[#131314] border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            >
                              {PERSONA_OPTIONS.map((p) => (
                                <option key={p.id || 'default'} value={p.id}>{p.label}</option>
                              ))}
                            </select>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Structured Code Output</label>
                            <div className="grid grid-cols-3 gap-1.5">
                              {(['auto', 'markdown', 'json'] as const).map((fmt) => (
                                <button
                                  key={fmt}
                                  type="button"
                                  onClick={() => setOutputFormat?.(fmt)}
                                  className={cn(
                                    "py-1.5 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer uppercase",
                                    outputFormat === fmt
                                      ? "bg-indigo-600/25 border-indigo-500 text-indigo-300"
                                      : "bg-[#131314] border-slate-800 text-slate-400 hover:text-slate-200"
                                  )}
                                >
                                  {fmt}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-[11px] text-slate-400 font-medium block">Custom System Instruction</label>
                            <textarea
                              rows={3}
                              value={customSystemInstruction}
                              onChange={(e) => setCustomSystemInstruction?.(e.target.value)}
                              placeholder="e.g. Always use strict TypeScript, React functional hooks, and Tailwind v4..."
                              className="w-full bg-[#131314] border border-slate-700 rounded-xl px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 resize-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {setMultiAgent && (
                      <button
                        type="button"
                        onClick={() => setMultiAgent(!multiAgent)}
                        className={cn(
                          "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors cursor-pointer",
                          multiAgent
                            ? "bg-violet-500/20 border-violet-500/40 text-violet-300"
                            : "bg-[#27282d] hover:bg-[#2f3137] border-slate-700/80 text-slate-400"
                        )}
                        title="Multi-Agent Orchestration (Architect → Executor → Reviewer)"
                      >
                        <Bot className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Multi-Agent</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Center: Multi-Model Selector dropdown */}
                    <div className="relative">
                      <button
                        onClick={() => {
                          setShowModelDropdown(!showModelDropdown);
                          setShowPersonaPopover(false);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#27282d] hover:bg-[#2f3137] text-slate-200 text-xs font-medium border border-slate-700/80 transition-colors cursor-pointer"
                      >
                        <span>{MODEL_OPTIONS.find(m => m.id === effectiveModel)?.label || effectiveModel}</span>
                        <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                      </button>

                      {showModelDropdown && (
                        <div className="absolute bottom-full mb-2 right-0 bg-[#1c1d22] border border-slate-700 rounded-xl p-1.5 shadow-2xl z-50 min-w-[270px] max-h-72 overflow-y-auto">
                          {MODEL_OPTIONS.map((m) => (
                            <button
                              key={m.id}
                              onClick={() => handleSelectModel(m.id)}
                              className="w-full text-left px-3 py-2 rounded-lg text-xs hover:bg-slate-800 text-slate-200 flex items-center justify-between gap-2 cursor-pointer"
                            >
                              <div className="min-w-0">
                                <div className="font-medium text-white truncate">{m.label}</div>
                                <div className="text-[10px] text-slate-400 truncate">{m.desc}</div>
                              </div>
                              {effectiveModel === m.id && <Check className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Mic speech recognition button */}
                    <button
                      onClick={handleVoiceInput}
                      className={cn(
                        "p-2 rounded-full transition-colors",
                        isListening ? "bg-red-500/20 text-red-400 animate-pulse" : "text-slate-400 hover:text-white hover:bg-slate-800"
                      )}
                      title="Voice Input (ভয়েস টাইপিং)"
                    >
                      <Mic className="w-4 h-4" />
                    </button>

                    {/* Stop + Circular Send buttons (Send cancels previous request if already running) */}
                    {isLoading && (
                      <button
                        type="button"
                        onClick={() => onCancel?.()}
                        className="w-8 h-8 rounded-full flex items-center justify-center transition-all bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/35 cursor-pointer"
                        title="চলমান রিকোয়েস্ট বাতিল করুন (Stop)"
                      >
                        <Square className="w-3.5 h-3.5 fill-current" />
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        if (selectedElement && input.trim()) {
                          const targetNote = `[FOCUS MODE TARGET ELEMENT]\nCSS Selector: ${selectedElement.selector}\nSnippet: ${selectedElement.htmlSnippet}\nApply surgical focus_mode edit only to this element: ${input.trim()}`;
                          setSelectedElement(null);
                          setInput('');
                          handleSend(targetNote);
                        } else {
                          handleSend();
                        }
                      }}
                      disabled={(!input.trim() && !attachedImage) || cooldown > 0}
                      className={cn(
                        "w-8 h-8 rounded-full flex items-center justify-center transition-all",
                        (input.trim() || attachedImage) && cooldown === 0
                          ? "bg-white text-slate-900 hover:bg-slate-200 shadow-md cursor-pointer"
                          : "bg-slate-800 text-slate-500 cursor-not-allowed"
                      )}
                      title={isLoading ? "আগের রিকোয়েস্ট বাতিল করে নতুন মেসেজ পাঠান" : "Send"}
                    >
                      <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 2: LIVE PREVIEW VIEW --- */}
        {activeCoderTab === 'preview' && (
          <div className="flex-1 min-h-0 flex flex-col bg-slate-950 overflow-hidden">
            {/* Preview Toolbar */}
            <div className="h-12 border-b border-slate-800 px-2.5 sm:px-4 bg-[#18191d] flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 truncate">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex-shrink-0">
                  Preview
                </span>
                <span className="text-slate-600 font-mono text-xs flex-shrink-0">•</span>
                <span className="text-xs font-medium text-slate-400 truncate max-w-[110px] sm:max-w-[160px]">
                  {currentSessionTitle}
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {isWorkspaceUrl ? 'Workspace Live' : 'PWA Ready'}
                </span>
              </div>

              <div className="flex items-center gap-1 sm:gap-1.5 flex-shrink-0">
                {/* Desktop / Mobile Switch */}
                <button
                  onClick={() => setPreviewDevice('desktop')}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-colors",
                    previewDevice === 'desktop' ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  )}
                  title="Desktop View"
                >
                  <Monitor className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setPreviewDevice('mobile')}
                  className={cn(
                    "p-1.5 rounded-lg text-xs transition-colors",
                    previewDevice === 'mobile' ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white"
                  )}
                  title="Mobile View"
                >
                  <Smartphone className="w-4 h-4" />
                </button>

                <div className="w-px h-4 bg-slate-800 mx-1" />

                {/* Visual Element Picker (Focus Mode) */}
                <button
                  type="button"
                  onClick={() => toggleElementPicker()}
                  className={cn(
                    "px-2.5 py-1 rounded-lg border text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer",
                    isPickerMode
                      ? "bg-indigo-600 text-white border-indigo-400 animate-pulse"
                      : "bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border-indigo-500/30"
                  )}
                  title="প্রিভিউ থেকে যেকোনো এলিমেন্ট ক্লিক করে Focus Mode-এ এডিট করুন"
                >
                  <Crosshair className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{isPickerMode ? 'Picking...' : 'Select'}</span>
                </button>

                {/* Headless DOM & JS Verify Button */}
                <button
                  type="button"
                  onClick={handleVerifyPreviewDom}
                  disabled={isVerifyingPreview}
                  className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                  title="Run Headless DOM & JS Runtime Verification"
                >
                  {isVerifyingPreview ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  <span className="hidden sm:inline">Verify DOM</span>
                </button>

                {/* Auto-Heal Runtime Errors Toggle */}
                <button
                  type="button"
                  onClick={() => setAutoHealRuntime((v) => !v)}
                  className={cn(
                    "px-2.5 py-1 rounded-lg border text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer",
                    autoHealRuntime
                      ? "bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border-amber-500/30"
                      : "bg-slate-800/70 hover:bg-slate-800 text-slate-400 border-slate-700"
                  )}
                  title="প্রিভিউতে Runtime/Console Error ধরা পড়লে স্বয়ংক্রিয়ভাবে ১ বার Auto-Fix ট্রিগার করবে"
                >
                  <Bug className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Auto-Heal: {autoHealRuntime ? 'ON' : 'OFF'}</span>
                </button>

                {/* Reload */}
                <button
                  onClick={() => setPreviewKey(k => k + 1)}
                  className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors"
                  title="Reload"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>

                {/* Copy Code */}
                {shouldUseSrcDoc && (
                  <button
                    onClick={() => handleCopyCode()}
                    className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg transition-colors"
                    title="Copy HTML"
                  >
                    {copiedCode ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                )}

                {/* Download */}
                {shouldUseSrcDoc ? (
                  <button
                    onClick={handleDownloadHtml}
                    className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg transition-colors cursor-pointer"
                    title="Download HTML & PWA"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                ) : null}
                {hasSessionZipAvailable ? (
                  <button
                    onClick={handleDownloadZip}
                    className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg transition-colors cursor-pointer"
                    title="এই চ্যাটের ওয়েবসাইট ডাউনলোড করুন (ZIP)"
                  >
                    <FolderArchive className="w-4 h-4" />
                  </button>
                ) : null}

                {/* Deploy to GitHub Pages */}
                {onOpenGitHubDeploy && (
                  <button
                    type="button"
                    onClick={onOpenGitHubDeploy}
                    className="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-sm"
                    title="Build & Deploy current session project to a new GitHub Pages repository"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Deploy Pages</span>
                  </button>
                )}

                {/* Open in New Tab */}
                {shouldUseSrcDoc ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (!currentSessionHtml) return;
                      const blob = new Blob([currentSessionHtml], { type: 'text/html' });
                      const blobUrl = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = blobUrl;
                      a.target = '_blank';
                      a.rel = 'noopener noreferrer';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
                    }}
                    className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
                    title="Open in New Tab"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                ) : (
                  <a
                    href={previewUrl || '/projects/index.html'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors inline-flex items-center"
                    title="Open in New Tab"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </a>
                )}
              </div>
            </div>

            {/* Headless DOM Verification Result Banner */}
            {verifyResult && (
              <div
                className={cn(
                  "border-b px-4 py-2 flex items-center justify-between gap-3 flex-shrink-0 text-xs",
                  verifyResult.ok
                    ? "bg-emerald-950/70 border-emerald-500/30 text-emerald-200"
                    : "bg-amber-950/70 border-amber-500/30 text-amber-200"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldCheck className={cn("w-4 h-4 flex-shrink-0", verifyResult.ok ? "text-emerald-400" : "text-amber-400")} />
                  <span className="truncate">{verifyResult.summary}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {!verifyResult.ok && verifyResult.runtimeErrors && verifyResult.runtimeErrors.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setActiveCoderTab('chat');
                        handleSend(`Headless DOM ভেরিফিকেশনে নিচের runtime/syntax সমস্যাগুলো ধরা পড়েছে। অনুগ্রহ করে ঠিক করে দাও:\n\n\`\`\`\n${verifyResult.runtimeErrors!.join('\n')}\n\`\`\``);
                      }}
                      className="px-2.5 py-1 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-[11px] font-bold cursor-pointer"
                    >
                      Fix with Nexus
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setVerifyResult(null)}
                    className="p-1 opacity-70 hover:opacity-100 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Live Preview Runtime Error Banner */}
            {previewErrors.length > 0 && (
              <div className="bg-rose-950/90 border-b border-rose-500/40 px-4 py-2.5 flex items-center justify-between gap-3 flex-shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                  <div className="text-xs text-rose-200 truncate">
                    <span className="font-bold text-rose-300">Preview Runtime Error: </span>
                    <span className="font-mono">{previewErrors[previewErrors.length - 1].message}</span>
                    {previewErrors[previewErrors.length - 1].line ? (
                      <span className="text-rose-400/80 ml-1.5 font-mono">
                        (line {previewErrors[previewErrors.length - 1].line})
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      const errSummary = previewErrors
                        .map((e) => `${e.message}${e.line ? ` (line ${e.line}:${e.col || 0})` : ''}`)
                        .join('\n');
                      setActiveCoderTab('chat');
                      handleSend(`Live Preview-তে নিচের Runtime JavaScript Error ধরা পড়েছে। অনুগ্রহ করে HTML/JS ফাইলটি inspect ও fix করে verify_live_preview দিয়ে যাচাই করো:\n\n\`\`\`\n${errSummary}\n\`\`\``);
                    }}
                    className="px-2.5 py-1 rounded-lg bg-rose-500 hover:bg-rose-400 text-white text-[11px] font-bold flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <Bug className="w-3 h-3" />
                    <span>Fix with Nexus</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPreviewErrors([])}
                    className="p-1 text-rose-300 hover:text-white rounded-md cursor-pointer"
                    title="Dismiss error"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}

            {/* Frame Body */}
            <div className={cn(
              "relative flex-1 min-h-0",
              previewDevice === 'mobile'
                ? "overflow-auto flex items-center justify-center bg-slate-900/60 p-2 sm:p-4"
                : "overflow-hidden bg-white"
            )}>
              {isIframeLoading && (
                <div className="absolute top-3 right-3 z-40 px-2.5 py-1 rounded-full bg-slate-900/85 text-slate-200 border border-slate-700/70 text-[11px] font-medium flex items-center gap-1.5 shadow-md pointer-events-none">
                  <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                  <span>Loading preview...</span>
                </div>
              )}
              {previewDevice === 'mobile' ? (
                <div className="w-full max-w-[375px] h-full max-h-[700px] min-h-0 rounded-[28px] sm:rounded-[36px] border-[6px] sm:border-[8px] border-slate-700 bg-white shadow-2xl flex flex-col overflow-hidden relative">
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-4 bg-slate-700 rounded-b-xl z-30 flex items-center justify-center">
                    <div className="w-10 h-1 bg-slate-600 rounded-full" />
                  </div>
                  {shouldUseSrcDoc ? (
                    <iframe
                      ref={previewIframeRef}
                      key={`mob-${previewKey}`}
                      srcDoc={safeSrcDocHtml}
                      onLoad={() => setIsIframeLoading(false)}
                      onError={() => setIsIframeLoading(false)}
                      className="flex-1 min-h-0 w-full h-full border-none bg-white pt-4 block"
                      title="Mobile Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  ) : (
                    <iframe
                      ref={previewIframeRef}
                      key={`mob-url-${previewKey}-${previewUrl}`}
                      src={previewUrl || '/projects/index.html'}
                      onLoad={() => setIsIframeLoading(false)}
                      onError={() => setIsIframeLoading(false)}
                      className="flex-1 min-h-0 w-full h-full border-none bg-white pt-4 block"
                      title="Mobile Preview"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                    />
                  )}
                </div>
              ) : (
                shouldUseSrcDoc ? (
                  <iframe
                    ref={previewIframeRef}
                    key={`desk-${previewKey}`}
                    srcDoc={safeSrcDocHtml}
                    onLoad={() => setIsIframeLoading(false)}
                    onError={() => setIsIframeLoading(false)}
                    className="absolute inset-0 w-full h-full border-none bg-white block"
                    title="Live Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                ) : (
                  <iframe
                    ref={previewIframeRef}
                    key={`desk-url-${previewKey}-${previewUrl}`}
                    src={previewUrl || '/projects/index.html'}
                    onLoad={() => setIsIframeLoading(false)}
                    onError={() => setIsIframeLoading(false)}
                    className="absolute inset-0 w-full h-full border-none bg-white block"
                    title="Live Preview"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
                  />
                )
              )}
            </div>
          </div>
        )}

        {/* --- TAB 3: ARTIFACTS VIEW --- */}
        {activeCoderTab === 'artifacts' && (
          <div className="flex-1 min-h-0 flex flex-col bg-[#131314] overflow-hidden">
            {/* Artifacts Header */}
            <div className="h-12 border-b border-slate-800 px-4 bg-[#18191d] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <FileCode className="w-4 h-4 text-sky-400 flex-shrink-0" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200 truncate">
                  {sessionScopedFiles.length > 0
                    ? `${currentSessionTitle} • Website Files (${sessionScopedFiles.length})`
                    : 'Chat Website Artifacts'}
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {onOpenGitHubDeploy && (
                  <button
                    type="button"
                    onClick={onOpenGitHubDeploy}
                    className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition-all shadow-sm cursor-pointer flex-shrink-0"
                    title="Build & Deploy this session project to a new GitHub Pages repository"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    <span>Deploy to GitHub Pages</span>
                  </button>
                )}
                {hasSessionZipAvailable ? (
                  <button
                    onClick={handleDownloadZip}
                    className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-all shadow-sm cursor-pointer flex-shrink-0"
                    title="এই চ্যাটের তৈরি ওয়েবসাইটটি ZIP হিসেবে ডাউনলোড করুন"
                  >
                    <FolderArchive className="w-3.5 h-3.5" />
                    <span>Download Website (ZIP)</span>
                  </button>
                ) : shouldUseSrcDoc ? (
                  <button
                    onClick={handleDownloadHtml}
                    className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition-all shadow-sm cursor-pointer flex-shrink-0"
                    title="Download this Website HTML"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download HTML</span>
                  </button>
                ) : null}
              </div>
            </div>

            <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
              {/* File Tree Column */}
              <div className="w-full md:w-64 border-b md:border-b-0 md:border-r border-slate-800 bg-[#17181c] p-3 overflow-y-auto space-y-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 block mb-2">
                  {sessionScopedFiles.length > 0
                    ? `Session Files (${sessionScopedFiles.length})`
                    : 'Generated Files'}
                </span>
                {(() => {
                  const stripPrefix = (fp: string) =>
                    safeSessionSlug
                      ? fp
                          .replace(`workspaces/${safeSessionSlug}/`, '')
                          .replace(`projects/${safeSessionSlug}/`, '')
                      : fp;

                  const fileItems =
                    sessionScopedFiles.length > 0
                      ? sessionScopedFiles.map((fp) => {
                          const rel = stripPrefix(fp);
                          const ext = rel.split('.').pop()?.toUpperCase() || 'FILE';
                          return {
                            path: fp,
                            label: rel.split('/').pop() || rel,
                            badge: ext,
                            desc: rel,
                          };
                        })
                      : safeSessionSlug && shouldUseSrcDoc
                      ? [
                          {
                            path: `projects/${safeSessionSlug}/index.html`,
                            label: 'index.html',
                            badge: 'HTML / PWA',
                            desc: currentSessionTitle || 'Generated Website',
                          },
                        ]
                      : !safeSessionSlug
                      ? [
                          { path: 'projects/index.html', label: 'index.html', badge: 'HTML / PWA', desc: 'Starter Web App' },
                        ]
                      : [];

                  if (fileItems.length === 0) {
                    return (
                      <div className="px-2 py-4 text-[11px] text-slate-500 leading-relaxed">
                        এই চ্যাটের জন্য এখনো কোনো ওয়েবসাইট ফাইল তৈরি হয়নি। চ্যাটে ওয়েবসাইট বানাতে বলুন।
                      </div>
                    );
                  }

                  return fileItems.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => setSelectedArtifact(file.path)}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between transition-all cursor-pointer",
                        selectedArtifact === file.path 
                          ? "bg-indigo-600/20 text-indigo-300 border border-indigo-500/30" 
                          : "text-slate-300 hover:bg-slate-800/60"
                      )}
                    >
                      <div className="truncate mr-2">
                        <div className="font-mono font-medium truncate">{file.label}</div>
                        <div className="text-[10px] text-slate-500 truncate">{file.desc}</div>
                      </div>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-mono flex-shrink-0">
                        {file.badge}
                      </span>
                    </button>
                  ));
                })()}
              </div>

              {/* Code Inspection Column */}
              <div className="flex-1 bg-[#0d1117] p-4 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between pb-3 mb-2 border-b border-slate-800 flex-shrink-0">
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
                    <FileCode className="w-4 h-4 text-sky-400" />
                    <span className="font-semibold">{selectedArtifact}</span>
                  </div>
                  <button
                    onClick={() => {
                      const contentToCopy = artifactContent || currentSessionHtml || '';
                      if (contentToCopy) handleCopyCode(contentToCopy);
                    }}
                    className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
                <pre className="flex-1 whitespace-pre-wrap break-all text-slate-300 font-mono text-xs leading-relaxed overflow-auto p-2 bg-[#090d16] rounded-xl border border-slate-800">
                  {artifactContent !== null
                    ? artifactContent
                    : (selectedArtifact.startsWith('projects/') && selectedArtifact.endsWith('index.html') && shouldUseSrcDoc
                        ? (currentSessionHtml || "<!-- Open preview to see generated HTML -->")
                        : `// ${selectedArtifact}\n// Active in workspace`)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Sticky Bottom Navigation Bar matching Google AI Studio screenshot */}
      <footer className="h-14 border-t border-slate-800/80 bg-[#131314] px-4 flex items-center justify-between flex-shrink-0 z-40">
        {/* Back arrow */}
        <button
          onClick={() => {
            if (activeCoderTab !== 'chat') setActiveCoderTab('chat');
            else onOpenDrawer();
          }}
          className="p-2 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          title="Back"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* Center Pill Segmented Switcher matching screenshot: [ Chat | Preview | Artifacts ] */}
        <div className="flex items-center bg-[#1e2024] p-1 rounded-full border border-slate-800">
          <button
            onClick={() => setActiveCoderTab('chat')}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
              activeCoderTab === 'chat' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            Chat
          </button>
          <button
            onClick={() => {
              setActiveCoderTab('preview');
              setPreviewKey(k => k + 1);
            }}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer",
              activeCoderTab === 'preview' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            <span>Preview</span>
            {previewErrors.length > 0 ? (
              <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" title="Runtime error detected" />
            ) : (shouldUseSrcDoc || isWorkspaceUrl) ? (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            ) : null}
          </button>
          <button
            onClick={() => setActiveCoderTab('artifacts')}
            className={cn(
              "px-4 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer",
              activeCoderTab === 'artifacts' 
                ? "bg-[#2b2d33] text-white shadow-sm" 
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            Artifacts
          </button>
        </div>

        {/* More options button (...) matching screenshot */}
        <button
          onClick={onOpenDrawer}
          className="p-2 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
          title="More Options"
        >
          <MoreHorizontal className="w-5 h-5" />
        </button>
      </footer>
    </div>
  );
};
