import React from 'react';
import { 
  X, 
  Settings, 
  Key, 
  Github, 
  Flame, 
  ChevronRight,
  Cpu,
  Bot
} from 'lucide-react';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSecrets: () => void;
  onOpenGitHub: () => void;
  onOpenFirebase: () => void;
  multiAgent?: boolean;
  onToggleMultiAgent?: (enabled: boolean) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onOpenSecrets,
  onOpenGitHub,
  onOpenFirebase,
  multiAgent = true,
  onToggleMultiAgent,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center">
              <Settings className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Project Settings</h3>
              <p className="text-[11px] text-slate-400">Configure integrations, AI models, and deployment</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Settings Links */}
        <div className="p-5 space-y-2.5 text-xs">
          {onToggleMultiAgent && (
            <div className="w-full p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-violet-500/20 text-violet-400 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-white flex items-center gap-2">
                    <span>Multi-Agent Orchestration</span>
                    <span className="text-[10px] font-medium text-slate-400">
                      {multiAgent ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    Live status for Architect · Coder · Debugger
                  </div>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={multiAgent}
                aria-label="Toggle Multi-Agent Orchestration"
                onClick={() => onToggleMultiAgent(!multiAgent)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                  multiAgent ? 'bg-violet-600' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                    multiAgent ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          )}

          <button
            onClick={() => { onClose(); onOpenSecrets(); }}
            className="w-full p-3.5 rounded-xl bg-slate-900 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 flex items-center justify-between transition-all group text-left cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <div className="font-bold text-white group-hover:text-indigo-300 transition-colors">
                  API Keys & Rotation Pool
                </div>
                <div className="text-[11px] text-slate-400">
                  Manage Gemini, OpenRouter, Hugging Face, DeepSeek &amp; Groq keys
                </div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-slate-300 transition-transform group-hover:translate-x-0.5" />
          </button>

          <button
            onClick={() => { onClose(); onOpenGitHub(); }}
            className="w-full p-3.5 rounded-xl bg-slate-900 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 flex items-center justify-between transition-all group text-left cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-slate-800 text-slate-200 flex items-center justify-center">
                <Github className="w-4 h-4" />
              </div>
              <div>
                <div className="font-bold text-white group-hover:text-indigo-300 transition-colors">
                  GitHub Pages &amp; Repo Sync
                </div>
                <div className="text-[11px] text-slate-400">
                  Build &amp; deploy session projects to GitHub Pages or sync repos
                </div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-slate-300 transition-transform group-hover:translate-x-0.5" />
          </button>

          <button
            onClick={() => { onClose(); onOpenFirebase(); }}
            className="w-full p-3.5 rounded-xl bg-slate-900 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 flex items-center justify-between transition-all group text-left cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center">
                <Flame className="w-4 h-4" />
              </div>
              <div>
                <div className="font-bold text-white group-hover:text-amber-300 transition-colors">
                  Firebase & Firestore
                </div>
                <div className="text-[11px] text-slate-400">
                  Configure Firestore database and security rules
                </div>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-slate-300 transition-transform group-hover:translate-x-0.5" />
          </button>

          {/* Model info banner */}
          <div className="p-3 bg-indigo-950/30 border border-indigo-500/20 rounded-xl flex items-center gap-2.5 text-indigo-300 text-[11px]">
            <Cpu className="w-4 h-4 text-indigo-400 flex-shrink-0" />
            <span>Nexus AI runs on Google Gemini 3.8 Flash with multi-turn tool calling.</span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-medium text-xs cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
