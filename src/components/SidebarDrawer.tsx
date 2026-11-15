import React, { useState, useEffect } from 'react';
import { 
  X, 
  Plus, 
  MessageSquare, 
  Trash2, 
  Settings, 
  Key, 
  Github, 
  Flame, 
  Wrench, 
  ScrollText, 
  Zap, 
  Layout, 
  ChevronRight,
  Database
} from 'lucide-react';
import { getAllSessions, deleteSession, ChatSession } from '../lib/db';

interface SidebarDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  onOpenSecrets: () => void;
  onOpenGitHub: () => void;
  onOpenFirebase: () => void;
  onOpenTools: () => void;
  onOpenLogs: () => void;
  onTogglePreview: () => void;
  activeKeysCount: number;
}

export const SidebarDrawer: React.FC<SidebarDrawerProps> = ({
  isOpen,
  onClose,
  currentSessionId,
  onSelectSession,
  onNewChat,
  onOpenSettings,
  onOpenSecrets,
  onOpenGitHub,
  onOpenFirebase,
  onOpenTools,
  onOpenLogs,
  onTogglePreview,
  activeKeysCount,
}) => {
  const [sessions, setSessions] = useState<ChatSession[]>([]);

  const loadSessions = () => {
    getAllSessions()
      .then(res => setSessions(res))
      .catch(() => {});
  };

  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen, currentSessionId]);

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
    loadSessions();
    if (currentSessionId === id) {
      onNewChat();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative w-80 max-w-[85vw] bg-[#0b1329] border-r border-slate-800 flex flex-col h-full shadow-2xl z-10 animate-slide-right">
        {/* Top Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-white text-sm leading-tight">Nexus AI</h2>
              <span className="text-[10px] text-slate-400 font-mono">Build Orchestrator</span>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* New Chat Button */}
        <div className="p-3">
          <button
            onClick={() => {
              onNewChat();
              onClose();
            }}
            className="w-full py-2.5 px-3.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-600/20 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>New Chat Canvas</span>
          </button>
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 text-xs">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider px-2 py-1 flex items-center gap-1.5">
            <Database className="w-3 h-3" />
            <span>Recent Projects & Chats</span>
          </div>

          {sessions.length === 0 ? (
            <div className="p-4 text-center text-slate-500 text-[11px]">
              No past sessions saved. Start building!
            </div>
          ) : (
            sessions.map((sess) => {
              const isSelected = sess.id === currentSessionId;
              return (
                <div
                  key={sess.id}
                  onClick={() => {
                    onSelectSession(sess.id);
                    onClose();
                  }}
                  className={`group flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                      : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5 overflow-hidden">
                    <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 group-hover:text-indigo-400" />
                    <span className="truncate text-xs font-medium">
                      {sess.title || 'Untitled Project'}
                    </span>
                  </div>

                  <button
                    onClick={(e) => handleDeleteSession(e, sess.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-rose-400 rounded transition-opacity"
                    title="Delete session"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Bottom Menu Items */}
        <div className="p-3 border-t border-slate-800 space-y-1 text-xs">
          <button
            onClick={() => { onClose(); onOpenSecrets(); }}
            className="w-full flex items-center justify-between p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <Key className="w-4 h-4 text-sky-400" />
              <span>API Secrets & Keys</span>
            </div>
            {activeKeysCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-emerald-500/20 text-emerald-300 font-mono border border-emerald-500/30">
                {activeKeysCount}
              </span>
            )}
          </button>

          <button
            onClick={() => { onClose(); onOpenGitHub(); }}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <Github className="w-4 h-4 text-slate-400" />
            <span>GitHub Pages &amp; Sync</span>
          </button>

          <button
            onClick={() => { onClose(); onOpenFirebase(); }}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <Flame className="w-4 h-4 text-amber-400" />
            <span>Firebase & Rules</span>
          </button>

          <button
            onClick={() => { onClose(); onOpenTools(); }}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <Wrench className="w-4 h-4 text-indigo-400" />
            <span>System Tools</span>
          </button>

          <button
            onClick={() => { onClose(); onOpenLogs(); }}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <ScrollText className="w-4 h-4 text-rose-400" />
            <span>System Logs</span>
          </button>

          <button
            onClick={() => { onClose(); onOpenSettings(); }}
            className="w-full flex items-center gap-2.5 p-2 rounded-xl text-slate-300 hover:bg-slate-800/80 hover:text-white transition-colors"
          >
            <Settings className="w-4 h-4 text-slate-400" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
};
