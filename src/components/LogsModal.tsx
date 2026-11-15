import React, { useState, useEffect } from 'react';
import { 
  X, 
  ScrollText, 
  RefreshCw, 
  Trash2, 
  Key, 
  AlertTriangle, 
  CheckCircle, 
  Info, 
  AlertCircle 
} from 'lucide-react';

interface LogsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenSecrets?: () => void;
}

export const LogsModal: React.FC<LogsModalProps> = ({ isOpen, onClose, onOpenSecrets }) => {
  const [logs, setLogs] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');

  const fetchLogs = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/system-logs');
      const data = await res.json();
      setLogs(Array.isArray(data) ? data : (data.logs || []));
    } catch (err) {
      console.warn("Failed to fetch logs:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const clearLogs = async () => {
    try {
      await fetch('/api/system-logs', { method: 'DELETE' });
      setLogs([]);
    } catch (err) {
      console.warn("Failed to clear logs:", err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredLogs = logs.filter(log => {
    if (filter === 'all') return true;
    return log.level === filter;
  });

  const getLevelBadge = (level: string) => {
    switch (level) {
      case 'error':
        return <span className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-400 font-bold text-[9px]">ERR</span>;
      case 'warn':
        return <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold text-[9px]">WARN</span>;
      case 'success':
        return <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-bold text-[9px]">OK</span>;
      default:
        return <span className="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-400 font-bold text-[9px]">INFO</span>;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-2xl bg-[#0b1329] border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center">
              <ScrollText className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">System Diagnostics & Logs</h3>
              <p className="text-[11px] text-slate-400">View real-time API rate limits, tool executions, and server logs</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              disabled={isLoading}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
              title="Refresh logs"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={clearLogs}
              className="p-1.5 text-slate-400 hover:text-rose-400 rounded-lg hover:bg-slate-800 transition-colors"
              title="Clear all logs"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button 
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-5 py-2.5 border-b border-slate-800/80 flex items-center justify-between gap-2 text-xs bg-slate-900/50">
          <div className="flex gap-1.5">
            {(['all', 'error', 'warn', 'info'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 rounded-lg capitalize font-medium text-[11px] transition-colors ${
                  filter === f ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:bg-slate-800'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {onOpenSecrets && (
            <button
              onClick={() => { onClose(); onOpenSecrets(); }}
              className="flex items-center gap-1.5 text-sky-400 hover:text-sky-300 font-semibold text-[11px]"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Manage API Keys</span>
            </button>
          )}
        </div>

        {/* Log Entries */}
        <div className="p-4 overflow-y-auto space-y-2 flex-1 font-mono text-[11px]">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-slate-500 font-sans text-xs">
              No logs recorded for this filter.
            </div>
          ) : (
            filteredLogs.map((log, idx) => (
              <div 
                key={log.id || idx}
                className="p-2.5 rounded-xl bg-slate-900/80 border border-slate-800 flex items-start gap-2.5 hover:border-slate-700 transition-colors"
              >
                <div className="mt-0.5">{getLevelBadge(log.level)}</div>
                <div className="flex-1 overflow-hidden">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="font-bold text-slate-300 truncate">
                      {log.message || log.text}
                    </span>
                    <span className="text-[10px] text-slate-500 flex-shrink-0">
                      {log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : ''}
                    </span>
                  </div>
                  {log.details && (
                    <div className="text-[10px] text-slate-400 whitespace-pre-wrap bg-black/40 p-2 rounded-lg mt-1 border border-slate-800/80 font-mono">
                      {log.details}
                    </div>
                  )}
                  {log.keyName && (
                    <div className="text-[9px] text-slate-500 mt-1">
                      Key: <span className="text-slate-400">{log.keyName}</span> | Model: <span className="text-slate-400">{log.model}</span>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
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
