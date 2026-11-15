import React, { useState, useEffect } from 'react';
import { 
  X, 
  Terminal, 
  Search, 
  Database, 
  ShieldAlert, 
  GitBranch, 
  Play, 
  Loader2, 
  Copy,
  Check,
  Sparkles,
  FileSearch,
  Hammer,
  Code2,
  Braces,
  Bug,
  Cpu,
  Activity,
  Layers,
  Network,
  Bot
} from 'lucide-react';

interface ToolsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SANDBOX_STARTERS: Record<'python' | 'javascript' | 'typescript' | 'bash', string> = {
  python: 'import sys, math\nprint("Python:", sys.version.split()[0])\nprint("Primes up to 20:", [n for n in range(2, 21) if all(n % d != 0 for d in range(2, int(math.sqrt(n)) + 1))])',
  javascript: 'const nums = [1, 2, 3, 4, 5];\nconsole.log("Node:", process.version);\nconsole.log("Squares:", nums.map(n => n * n));',
  typescript: 'interface Task { id: number; title: string; done: boolean }\nconst tasks: Task[] = [{ id: 1, title: "Sandbox Check", done: true }];\nconsole.log("TS Output:", JSON.stringify(tasks));',
  bash: 'echo "Workspace files:" && ls -la | head -n 10',
};

export const ToolsModal: React.FC<ToolsModalProps> = ({ isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState<'pipeline' | 'skills' | 'claw' | 'sandbox' | 'functions' | 'debug' | 'code' | 'build' | 'terminal' | 'git' | 'security' | 'search' | 'sql'>('pipeline');
  const [command, setCommand] = useState('git status');
  const [clawTaskInput, setClawTaskInput] = useState('Build a real-time collaborative workspace with persistent local database');
  const [sandboxLang, setSandboxLang] = useState<'python' | 'javascript' | 'typescript' | 'bash'>('python');
  const [sandboxCode, setSandboxCode] = useState(SANDBOX_STARTERS.python);
  const [debugErrorLog, setDebugErrorLog] = useState('');
  const [debugFilePath, setDebugFilePath] = useState('');
  const [grepPattern, setGrepPattern] = useState('handleSend|chatWithAI');
  const [globPattern, setGlobPattern] = useState('*.tsx');
  const [astQuery, setAstQuery] = useState('chat loop persistence sandbox');
  const [qaTargetUrl, setQaTargetUrl] = useState('/projects/index.html');
  const [searchQuery, setSearchQuery] = useState('React 19 motion');
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM users LIMIT 10;');
  const [output, setOutput] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [skills, setSkills] = useState<any[]>([]);
  const [registeredTools, setRegisteredTools] = useState<any[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<any>(null);
  const [selectedTool, setSelectedTool] = useState<any>(null);

  useEffect(() => {
    if (isOpen) {
      fetch('/api/skills')
        .then(res => res.json())
        .then(data => {
          setSkills(data.skills || []);
          setRegisteredTools(data.tools || []);
          if (data.skills?.length > 0 && !selectedSkill) {
            setSelectedSkill(data.skills[0]);
          }
          if (data.tools?.length > 0 && !selectedTool) {
            setSelectedTool(data.tools[0]);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const runBash = async () => {
    if (!command.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/bash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      setOutput(data.stdout || data.stderr || data.error || data.output || 'Command finished with no output.');
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runGrep = async () => {
    if (!grepPattern.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/grep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: grepPattern }),
      });
      const data = await res.json();
      setOutput((data.matches && data.matches.length > 0) ? data.matches.join('\n') : 'No matches found.');
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runGlob = async () => {
    if (!globPattern.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/glob', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern: globPattern }),
      });
      const data = await res.json();
      setOutput((data.files && data.files.length > 0) ? data.files.join('\n') : 'No matching files found.');
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runVerifyBuild = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/verify-build', { method: 'POST' });
      const data = await res.json();
      setOutput(data.success ? `✓ TypeScript & Vite Build Passed!\n\n${data.buildOutput}` : `✗ Verification Failed:\n${data.error}\n${data.output}`);
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runGitStatus = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/git-status', { method: 'POST' });
      const data = await res.json();
      setOutput(`Branch: ${data.branch}\nStatus:\n${data.status}`);
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runGitDiff = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/git-diff', { method: 'POST' });
      const data = await res.json();
      setOutput(data.diff || 'No uncommitted changes detected.');
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runSecurityScan = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/detect-secrets', { method: 'POST' });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runWebSearch = async () => {
    if (!searchQuery.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runSql = async () => {
    if (!sqlQuery.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/execute-sql-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sqlQuery }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runSandbox = async () => {
    if (!sandboxCode.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/sandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: sandboxLang, code: sandboxCode }),
      });
      const data = await res.json();
      const summary = [
        `[${data.language?.toUpperCase() || sandboxLang.toUpperCase()} Sandbox] exitCode=${data.exitCode ?? (data.success ? 0 : 1)} (${data.durationMs ?? 0}ms)`,
        data.stdout ? `\n--- STDOUT ---\n${data.stdout}` : '',
        data.stderr ? `\n--- STDERR ---\n${data.stderr}` : '',
        data.error ? `\n--- ERROR ---\n${data.error}` : '',
      ].filter(Boolean).join('\n');
      setOutput(summary || 'Execution completed with empty output.');
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runDebugAnalyze = async () => {
    if (!debugErrorLog.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/debug-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          errorLog: debugErrorLog,
          filePath: debugFilePath.trim() || undefined,
          runTypeCheck: true,
        }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runAstRanker = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/ast-context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: astQuery, targetDir: '.', topK: 8 }),
      });
      const data = await res.json();
      setOutput(
        `Scanned: ${data.totalFilesScanned} files | Token Savings: ${data.tokenSavingsPercent}% (${data.compactChars}/${data.rawChars} chars)\n\n${data.formattedContext || JSON.stringify(data, null, 2)}`
      );
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runVisualQa = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/visual-qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: qaTargetUrl }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runWorkspacesStatus = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/workspaces');
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runPersistenceCheck = async (sync: boolean = false) => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch(sync ? '/api/persistence/sync' : '/api/persistence/status', {
        method: sync ? 'POST' : 'GET',
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runClawDoctor = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/claw-doctor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runNetworkCheck: true }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runClawStatus = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/claw-status');
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runClawAcp = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/claw-acp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'capabilities' }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runOmo = async () => {
    if (!clawTaskInput.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/omo-coordinate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: clawTaskInput }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runOmx = async () => {
    if (!clawTaskInput.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/omx-protocol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: clawTaskInput }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runClawhip = async () => {
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/clawhip?action=list');
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runLazyCodex = async () => {
    if (!clawTaskInput.trim() || isRunning) return;
    setIsRunning(true);
    setOutput(null);
    try {
      const res = await fetch('/api/tools/lazycodex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: clawTaskInput }),
      });
      const data = await res.json();
      setOutput(JSON.stringify(data, null, 2));
    } catch (err: any) {
      setOutput(`Error: ${err.message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const copyOutput = () => {
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-4xl bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Nexus Coding Mode — Skills & Tools</h3>
              <p className="text-[11px] text-slate-400">
                {skills.length} Coding Skills & {registeredTools.length} Engineering Tools active in Nexus AI
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="px-5 pt-3 border-b border-slate-800 flex gap-2 overflow-x-auto text-xs">
          {[
            { id: 'pipeline', label: 'ওয়ার্কফ্লো পাইপলাইন (Pipeline)', icon: Network },
            { id: 'skills', label: `Skills (${skills.length})`, icon: Sparkles },
            { id: 'claw', label: 'Claw & OmO', icon: Cpu },
            { id: 'sandbox', label: 'Code Sandbox', icon: Code2 },
            { id: 'functions', label: `Functions (${registeredTools.length})`, icon: Braces },
            { id: 'debug', label: 'Debug & Diff', icon: Bug },
            { id: 'code', label: 'Grep & Find', icon: FileSearch },
            { id: 'build', label: 'Build & Lint', icon: Hammer },
            { id: 'terminal', label: 'Bash Shell', icon: Terminal },
            { id: 'git', label: 'Git Ops', icon: GitBranch },
            { id: 'security', label: 'Security', icon: ShieldAlert },
            { id: 'search', label: 'Web Search', icon: Search },
            { id: 'sql', label: 'SQL', icon: Database },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id as any); setOutput(null); }}
                className={`pb-2.5 px-3 font-semibold border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  activeTab === tab.id ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="p-5 flex-1 overflow-y-auto space-y-4 text-xs">
          {activeTab === 'pipeline' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-gradient-to-r from-indigo-950/60 via-slate-900 to-purple-950/40 border border-indigo-500/30">
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="w-6 h-6 rounded-lg bg-indigo-600/30 text-indigo-400 flex items-center justify-center font-bold text-xs">
                    6
                  </div>
                  <h4 className="text-sm font-bold text-white">Google AI Studio Build আর্কিটেকচার ও ৬-ধাপের এক্সিকিউশন পাইপলাইন</h4>
                </div>
                <p className="text-slate-300 text-xs leading-relaxed">
                  ইউজারের যেকোনো প্রম্পট পাওয়ার সাথে সাথে Nexus AI নিচের ৬টি ধাপে স্বয়ংক্রিয়ভাবে রিকোয়ারমেন্ট বিশ্লেষণ, কোডবেস পরীক্ষা, নিখুঁত কোড জেনারেশন, টাইপচেকিং এবং লাইভ প্রিভিউ নিশ্চিত করে:
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                {/* Phase 1 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-indigo-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-300">ধাপ ১</span>
                    <Sparkles className="w-4 h-4 text-indigo-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">ইনটেন্ট ট্রায়াজ ও স্কিল নির্বাচন (Triage & Skill Check)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    প্রম্পটের বিষয়বস্তু শনাক্ত করে {skills.length || 29}টি ডোমেন স্কিলের মধ্য থেকে প্রযোজ্য স্কিলগুলো (যেমন: frontend-design, pwa, firebase, cloudsql, claw, omo) সক্রিয় করে কাজের নিয়ম লোড করা।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">read_skill</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">ask_question</span>
                  </div>
                </div>

                {/* Phase 2 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-sky-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/20 text-sky-300">ধাপ ২</span>
                    <FileSearch className="w-4 h-4 text-sky-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">কনটেক্সট সংগ্রহ ও কোডবেস ইনসপেকশন (Inspection)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    কোড লেখার পূর্বে পুরো ডিরেক্টরি কাঠামো, প্যাকেজ ও বিদ্যমান ফাইলগুলো পড়া। সিম্বল ও টেক্সট খোঁজার জন্য গ্রিপ (grep) ও গ্লোব (glob) সার্চ ব্যবহার।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">view_file</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">grep_search</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">list_dir</span>
                  </div>
                </div>

                {/* Phase 3 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-emerald-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">ধাপ ৩</span>
                    <Code2 className="w-4 h-4 text-emerald-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">সার্জিক্যাল কোড এক্সিকিউশন (Surgical Execution)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    কোনো ফাঁকা বা প্লেসহোল্ডার কোড ছাড়া সম্পূর্ণ প্রিমিয়াম কোড লেখা। নতুন লাইব্রেরি ব্যবহারের পূর্বে প্যাকেজ ইনস্টল করা এবং সুনির্দিষ্ট লাইনে এডিট করা।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">write_to_file</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">replace_file_content</span>
                  </div>
                </div>

                {/* Phase 4 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-amber-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300">ধাপ ৪</span>
                    <Hammer className="w-4 h-4 text-amber-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">ডুয়াল ভেরিফিকেশন লুপ (Dual Verification)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    কোড তৈরির পর সাথে সাথে TypeScript চেকার (tsc --noEmit) এবং প্রোডাকশন বিল্ড চালিয়ে যাচাই করা। কোনো এরর থাকলে সাথে সাথে সেলফ-হিলিং করা।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">compile_applet</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">lint_applet</span>
                  </div>
                </div>

                {/* Phase 5 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-purple-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300">ধাপ ৫</span>
                    <Activity className="w-4 h-4 text-purple-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">লাইভ রানটাইম ও ডেভ সার্ভার (Runtime Validation)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    পোর্ট ৩০০০-এ এক্সপ্রেস ও ভাইট সার্ভার লাইভ রাখা। Service Worker ও Manifest ইনজেকশন নিশ্চিত করে লাইভ প্রিভিউ আইফ্রেমে রেন্ডার করা।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">restart_dev_server</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">0.0.0.0:3000</span>
                  </div>
                </div>

                {/* Phase 6 */}
                <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2 hover:border-rose-500/40 transition-colors">
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300">ধাপ ৬</span>
                    <Terminal className="w-4 h-4 text-rose-400" />
                  </div>
                  <h5 className="font-bold text-white text-xs">অ্যাকশন হিস্ট্রি ও সামারি রিপোর্ট (Structured Summary)</h5>
                  <p className="text-slate-400 text-[11px] leading-relaxed">
                    কোন কোন ফাইল তৈরি বা এডিট হয়েছে এবং কী কী কমান্ড চলেছে তার ধাপে ধাপে অ্যাকর্ডিয়ন ও সংক্ষিপ্ত, তথ্যবহুল সারাংশ ব্যবহারকারীর সামনে উপস্থাপন।
                  </p>
                  <div className="pt-1.5 border-t border-slate-800/80 flex flex-wrap gap-1 text-[10px] text-slate-500 font-mono">
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">ActionSteps</span>
                    <span className="bg-slate-950 px-1.5 py-0.5 rounded">ModifiedFiles</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-5 space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {skills.map((skill) => (
                  <button
                    key={skill.name}
                    onClick={() => setSelectedSkill(skill)}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                      selectedSkill?.name === skill.name
                        ? 'bg-indigo-600/20 border-indigo-500/40 text-white'
                        : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-xs text-indigo-300">{skill.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 uppercase">{skill.category}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{skill.description}</p>
                  </button>
                ))}
              </div>
              <div className="md:col-span-7 bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col justify-between max-h-[420px] overflow-y-auto">
                {selectedSkill ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <h4 className="font-mono font-bold text-sm text-white">{selectedSkill.name}</h4>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">Active in Nexus AI</span>
                    </div>
                    <p className="text-slate-300 leading-relaxed">{selectedSkill.description}</p>
                    <pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-300 bg-slate-900/90 p-3 rounded-xl border border-slate-800 leading-relaxed">
                      {selectedSkill.instructions}
                    </pre>
                    <div className="pt-2 border-t border-slate-800/80">
                      <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">Registered Server Tools ({registeredTools.length}):</div>
                      <div className="flex flex-wrap gap-1.5">
                        {registeredTools.map((t: any) => (
                          <span key={t.name} className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[10px] font-mono text-sky-300">
                            {t.name}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-slate-500 text-center py-8">Select a skill to inspect its playbook.</div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'claw' && (
            <div className="space-y-4">
              <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4 text-sky-400" />
                    <span className="font-bold text-white text-xs">UltraWorkers / Claw Code Harness & Multi-Agent Layer</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/25">
                    Harness Active
                  </span>
                </div>
                <p className="text-slate-400 text-[11px] leading-relaxed">
                  The Claw CLI engine harness directly manages file operations, search/grep, shell execution, health checks (claw doctor), agent client protocol (claw acp), OmO multi-agent coordination (Architect/Executor/Reviewer), OmX execution protocols, and ClawHip event routing.
                </p>
              </div>

              {/* Quick Diagnostic & Status Buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <button
                  onClick={runClawDoctor}
                  disabled={isRunning}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-xs mb-1">
                    <Activity className="w-3.5 h-3.5" />
                    <span>Claw Doctor</span>
                  </div>
                  <p className="text-[10px] text-slate-400">Environment, port, memory & API health check</p>
                </button>

                <button
                  onClick={runClawStatus}
                  disabled={isRunning}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-1.5 text-indigo-400 font-bold text-xs mb-1">
                    <Cpu className="w-3.5 h-3.5" />
                    <span>Claw Status</span>
                  </div>
                  <p className="text-[10px] text-slate-400">Inspect harness runtime, uptime & tasks</p>
                </button>

                <button
                  onClick={runClawAcp}
                  disabled={isRunning}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-1.5 text-amber-400 font-bold text-xs mb-1">
                    <Network className="w-3.5 h-3.5" />
                    <span>Claw ACP</span>
                  </div>
                  <p className="text-[10px] text-slate-400">Agent Client Protocol capabilities & handshake</p>
                </button>

                <button
                  onClick={runClawhip}
                  disabled={isRunning}
                  className="p-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left transition-all cursor-pointer group"
                >
                  <div className="flex items-center gap-1.5 text-purple-400 font-bold text-xs mb-1">
                    <Layers className="w-3.5 h-3.5" />
                    <span>ClawHip Events</span>
                  </div>
                  <p className="text-[10px] text-slate-400">Out-of-band commits, PRs & milestones</p>
                </button>
              </div>

              {/* Multi-Agent & Protocol Dispatch Box */}
              <div className="space-y-2.5 p-3.5 bg-slate-950/80 border border-slate-800 rounded-xl">
                <label className="text-[11px] font-bold text-slate-300 block">
                  Task / Directive for Multi-Agent & Workflow Engines:
                </label>
                <textarea
                  rows={2}
                  value={clawTaskInput}
                  onChange={(e) => setClawTaskInput(e.target.value)}
                  placeholder="Describe project feature or goal to coordinate across agents..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-white text-xs focus:outline-none focus:border-indigo-500 resize-none"
                />

                <div className="flex flex-wrap gap-2 justify-end">
                  <button
                    onClick={runOmo}
                    disabled={isRunning || !clawTaskInput.trim()}
                    className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 text-xs cursor-pointer"
                    title="Orchestrate Architect -> Executor -> Reviewer"
                  >
                    {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bot className="w-3.5 h-3.5" />}
                    <span>OmO (Multi-Agent)</span>
                  </button>

                  <button
                    onClick={runOmx}
                    disabled={isRunning || !clawTaskInput.trim()}
                    className="px-3.5 py-2 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 text-xs cursor-pointer"
                    title="Generate 3-phase structured execution protocol"
                  >
                    {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
                    <span>OmX (Execution Protocol)</span>
                  </button>

                  <button
                    onClick={runLazyCodex}
                    disabled={isRunning || !clawTaskInput.trim()}
                    className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 text-xs cursor-pointer"
                    title="Run Gajae-Code / LazyCodex self-healing engine"
                  >
                    {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    <span>LazyCodex Runner</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'sandbox' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-slate-400">Execute isolated Python, JavaScript, TypeScript, or Bash snippets inside the Nexus Code Execution Sandbox.</p>
                <div className="flex items-center gap-1.5">
                  {(['python', 'javascript', 'typescript', 'bash'] as const).map((lang) => (
                    <button
                      key={lang}
                      onClick={() => {
                        setSandboxLang(lang);
                        setSandboxCode(SANDBOX_STARTERS[lang]);
                      }}
                      className={`px-2.5 py-1 rounded-lg font-mono text-[11px] uppercase border cursor-pointer transition-colors ${
                        sandboxLang === lang
                          ? 'bg-indigo-600/25 border-indigo-500 text-indigo-300 font-bold'
                          : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                rows={8}
                value={sandboxCode}
                onChange={(e) => setSandboxCode(e.target.value)}
                spellCheck={false}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 font-mono text-xs focus:outline-none focus:border-indigo-500 resize-y leading-relaxed"
              />
              <div className="flex justify-end">
                <button
                  onClick={runSandbox}
                  disabled={isRunning}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  <span>Run in Sandbox</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'functions' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-5 space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
                {registeredTools.map((tool: any) => (
                  <button
                    key={tool.name}
                    onClick={() => setSelectedTool(tool)}
                    className={`w-full text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                      selectedTool?.name === tool.name
                        ? 'bg-indigo-600/20 border-indigo-500/40 text-white'
                        : 'bg-slate-900/60 border-slate-800 text-slate-300 hover:bg-slate-900'
                    }`}
                  >
                    <div className="font-mono font-bold text-xs text-sky-300">{tool.name}</div>
                    <p className="text-[11px] text-slate-400 mt-1 line-clamp-2">{tool.description}</p>
                  </button>
                ))}
              </div>
              <div className="md:col-span-7 bg-slate-950/80 border border-slate-800 rounded-xl p-4 max-h-[420px] overflow-y-auto">
                {selectedTool ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <h4 className="font-mono font-bold text-sm text-white">{selectedTool.name}</h4>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/25">Function Calling Schema</span>
                    </div>
                    <p className="text-slate-300 leading-relaxed">{selectedTool.description}</p>
                    <div>
                      <div className="text-[10px] font-bold text-slate-400 uppercase mb-1.5">JSON Parameters Schema:</div>
                      <pre className="whitespace-pre-wrap font-mono text-[11px] text-emerald-300 bg-slate-900/90 p-3 rounded-xl border border-slate-800 leading-relaxed">
                        {JSON.stringify(selectedTool.parameters || {}, null, 2)}
                      </pre>
                    </div>
                  </div>
                ) : (
                  <div className="text-slate-500 text-center py-8">Select a registered function to inspect its Gemini Function Calling schema.</div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'debug' && (
            <div className="space-y-3">
              <p className="text-slate-400">Paste stack traces, TypeScript diagnostics, or runtime logs to inspect referenced source lines, run type checks, or view uncommitted diffs.</p>
              <textarea
                rows={4}
                value={debugErrorLog}
                onChange={(e) => setDebugErrorLog(e.target.value)}
                placeholder="Paste error log or stack trace (e.g. TypeError at src/App.tsx:120:5)..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 font-mono text-xs focus:outline-none focus:border-indigo-500 resize-y"
              />
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  type="text"
                  value={debugFilePath}
                  onChange={(e) => setDebugFilePath(e.target.value)}
                  placeholder="Optional target file path (e.g. src/App.tsx)"
                  className="flex-1 min-w-[200px] bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={runDebugAnalyze}
                  disabled={isRunning || !debugErrorLog.trim()}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bug className="w-3.5 h-3.5" />}
                  <span>Analyze Error & Diagnostics</span>
                </button>
                <button
                  onClick={runGitDiff}
                  disabled={isRunning}
                  className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl font-medium flex items-center gap-1.5 cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Inspect Git Diff</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'code' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-slate-300 font-medium block">Grep Search (Regex / Text across workspace):</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={grepPattern}
                    onChange={(e) => setGrepPattern(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runGrep()}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={runGrep}
                    disabled={isRunning}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                    <span>Grep</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-slate-300 font-medium block">Find Files by Name / Glob:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={globPattern}
                    onChange={(e) => setGlobPattern(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runGlob()}
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={runGlob}
                    disabled={isRunning}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <FileSearch className="w-3.5 h-3.5" />
                    <span>Find Files</span>
                  </button>
                </div>
              </div>
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <label className="text-slate-300 font-medium block">TypeScript AST Context Ranker (60–70% Token Saver):</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={astQuery}
                    onChange={(e) => setAstQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && runAstRanker()}
                    placeholder="Symbol, route, or feature keywords..."
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={runAstRanker}
                    disabled={isRunning}
                    className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Braces className="w-3.5 h-3.5" />
                    <span>Rank AST Context</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'build' && (
            <div className="space-y-4">
              <p className="text-slate-400">Run dual verification: TypeScript type check (<code className="text-indigo-300">tsc --noEmit</code>) + production Vite build (<code className="text-indigo-300">npm run build</code>), inspect isolated sandboxes, or run Visual QA.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={runVerifyBuild}
                  disabled={isRunning}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-2 cursor-pointer"
                >
                  {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hammer className="w-3.5 h-3.5" />}
                  <span>Run Compile & Lint Verification</span>
                </button>
                <button
                  onClick={runWorkspacesStatus}
                  disabled={isRunning}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl font-semibold flex items-center gap-2 cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5 text-sky-400" />
                  <span>List Isolated Sandboxes</span>
                </button>
              </div>
              <div className="pt-2 border-t border-slate-800/80 space-y-2">
                <label className="text-slate-300 font-medium block">Visual QA Screenshot & Layout Audit:</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={qaTargetUrl}
                    onChange={(e) => setQaTargetUrl(e.target.value)}
                    placeholder="/projects/index.html or /w/default/"
                    className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    onClick={runVisualQa}
                    disabled={isRunning}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>Run Visual QA</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="space-y-3">
              <label className="text-slate-300 font-medium block">Command to execute:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runBash()}
                  placeholder="e.g. ls -la, git status, npm run build"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={runBash}
                  disabled={isRunning}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  {isRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  <span>Run</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="flex gap-2.5 flex-wrap">
              <button
                onClick={runGitStatus}
                disabled={isRunning}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <GitBranch className="w-3.5 h-3.5 text-indigo-400" />
                <span>Git Status</span>
              </button>
              <button
                onClick={runGitDiff}
                disabled={isRunning}
                className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-xl font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <GitBranch className="w-3.5 h-3.5 text-amber-400" />
                <span>Git Diff</span>
              </button>
            </div>
          )}

          {activeTab === 'security' && (
            <div className="space-y-2">
              <p className="text-slate-400">Scan project source tree for exposed secrets, API keys, or hardcoded credentials.</p>
              <button
                onClick={runSecurityScan}
                disabled={isRunning}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-semibold flex items-center gap-2 cursor-pointer"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Scan for Hardcoded Secrets</span>
              </button>
            </div>
          )}

          {activeTab === 'search' && (
            <div className="space-y-3">
              <label className="text-slate-300 font-medium block">Search Query:</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && runWebSearch()}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  onClick={runWebSearch}
                  disabled={isRunning}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold flex items-center gap-1.5 cursor-pointer"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Search</span>
                </button>
              </div>
            </div>
          )}

          {activeTab === 'sql' && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-800/80">
                <span className="text-slate-400 text-xs">Remote Persistence (PostgreSQL / Turso / Supabase / Local SQLite):</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => runPersistenceCheck(false)}
                    disabled={isRunning}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <Database className="w-3.5 h-3.5 text-emerald-400" />
                    <span>DB Status</span>
                  </button>
                  <button
                    onClick={() => runPersistenceCheck(true)}
                    disabled={isRunning}
                    className="px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 rounded-lg text-xs font-medium cursor-pointer"
                  >
                    <span>Sync Secrets Now</span>
                  </button>
                </div>
              </div>
              <label className="text-slate-300 font-medium block">SQL Query:</label>
              <div className="flex gap-2">
                <textarea
                  rows={2}
                  value={sqlQuery}
                  onChange={(e) => setSqlQuery(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2 text-white font-mono text-xs focus:outline-none focus:border-indigo-500 resize-none"
                />
                <button
                  onClick={runSql}
                  disabled={isRunning}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold flex items-center gap-1.5 self-end cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Execute</span>
                </button>
              </div>
            </div>
          )}

          {/* Terminal / Output Display */}
          {output !== null && (
            <div className="mt-4 rounded-xl bg-black/60 border border-slate-800 p-3 font-mono text-[11px] relative">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800/80 mb-2 text-slate-500">
                <span>Output Console</span>
                <button
                  onClick={copyOutput}
                  className="flex items-center gap-1 hover:text-slate-200 transition-colors cursor-pointer"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="whitespace-pre-wrap max-h-60 overflow-y-auto text-slate-300 leading-relaxed">
                {output}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
