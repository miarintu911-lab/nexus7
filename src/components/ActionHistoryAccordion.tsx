import React, { useEffect, useState } from 'react';
import { 
  ChevronDown, 
  ChevronRight, 
  Terminal, 
  Sparkles, 
  CheckCircle2, 
  FileCode, 
  Loader2, 
  Wrench,
  Bot,
  AlertCircle,
  Check
} from 'lucide-react';
import { ActionStep } from '../types/secrets';
import { cn } from '../lib/utils';
import { AgentStatusStrip } from './AgentStatusStrip';
import { inferStepAgentRole } from '../lib/agentStatus';

export const DEFAULT_STUDIO_STEPS: ActionStep[] = [];

export interface ActionHistoryAccordionProps {
  steps: ActionStep[];
  modifiedFiles: string[];
  isLoading: boolean;
  modelName: string;
  durationText: string;
  defaultExpanded?: boolean;
  multiAgent?: boolean;
}

export const ActionHistoryAccordion: React.FC<ActionHistoryAccordionProps> = ({
  steps,
  modifiedFiles,
  isLoading,
  modelName,
  durationText,
  defaultExpanded,
  multiAgent = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultExpanded !== undefined ? defaultExpanded : isLoading);

  useEffect(() => {
    if (isLoading) {
      setIsOpen(true);
    }
  }, [isLoading]);

  const activeRunningStep = steps.find(s => s.status === 'running');

  const getStepIcon = (step: ActionStep) => {
    if (step.status === 'running') {
      return <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />;
    }
    if (step.status === 'error' || step.isError) {
      return <AlertCircle className="w-3.5 h-3.5 text-rose-400" />;
    }
    switch (step.kind) {
      case 'command':
        return <Terminal className="w-3.5 h-3.5 text-indigo-400" />;
      case 'agent':
        return <Bot className="w-3.5 h-3.5 text-violet-400" />;
      case 'thought':
        return <Sparkles className="w-3.5 h-3.5 text-amber-400" />;
      case 'file':
      case 'read':
      case 'edit':
        return <FileCode className="w-3.5 h-3.5 text-emerald-400" />;
      case 'build':
      case 'qc':
        return <CheckCircle2 className="w-3.5 h-3.5 text-sky-400" />;
      default:
        return <Wrench className="w-3.5 h-3.5 text-slate-400" />;
    }
  };

  return (
    <div className="w-full rounded-2xl bg-slate-900/90 border border-slate-800 shadow-xl overflow-hidden text-xs transition-all">
      {/* Header bar */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800/60 transition-colors cursor-pointer text-left gap-2"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="text-slate-200 font-semibold flex items-center gap-2 text-xs flex-shrink-0">
            {isLoading ? (
              <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin" />
            ) : (
              <span className="text-slate-400">📋</span>
            )}
            <span>{isLoading ? (activeRunningStep?.label || 'Working...') : 'Action history'}</span>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-slate-800 text-[10px] text-slate-400 font-mono border border-slate-700/60 flex-shrink-0">
            {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          </span>
          <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-500/10 text-[10px] text-indigo-300 font-mono border border-indigo-500/20 truncate max-w-[180px]">
            ⚡ {modelName}
          </span>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
            <span>{isLoading ? `Running ${durationText}` : durationText}</span>
          </div>
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          )}
        </div>
      </button>

      {/* Expanded Accordion Body */}
      {isOpen && (
        <div className="px-4 py-3.5 border-t border-slate-800/80 space-y-3.5 bg-[#0b101d]">
          {multiAgent && (
            <AgentStatusStrip steps={steps} isLoading={isLoading} variant="compact" />
          )}

          <div className="text-[11px] text-slate-300 font-medium flex items-center justify-between">
            <span>Here are key actions taken for the app:</span>
            {isLoading && (
              <span className="text-[10px] text-sky-400 font-mono animate-pulse">LIVE STREAM</span>
            )}
          </div>

          {/* Real Modified Files Section with green checkmarks matching screenshot */}
          {modifiedFiles && modifiedFiles.length > 0 && (
            <div className="space-y-2 py-1">
              <div className="text-xs font-semibold text-slate-200 flex items-center gap-2">
                <span className="text-emerald-400">✎</span> Edited {modifiedFiles.length} {modifiedFiles.length === 1 ? 'file' : 'files'}
              </div>
              <div className="pl-4 space-y-1.5 font-mono text-[11px]">
                {modifiedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1 px-2.5 rounded-lg bg-slate-950/70 border border-slate-800/80">
                    <span className="text-slate-300 truncate">{file}</span>
                    <span className="w-4 h-4 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center flex-shrink-0">
                      <Check className="w-2.5 h-2.5" />
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Real-time Steps List */}
          {steps.length > 0 ? (
            <div className="space-y-1.5 font-mono text-[11px] pt-1 border-t border-slate-800/60">
              {steps.map((step, idx) => (
                <div 
                  key={step.id || idx}
                  className={cn(
                    "flex items-start gap-2.5 py-1.5 px-2 rounded-lg transition-colors",
                    step.status === 'running'
                      ? "bg-sky-500/10 border border-sky-500/20"
                      : step.status === 'error' || step.isError
                        ? "bg-rose-500/10 border border-rose-500/20"
                        : "hover:bg-slate-800/40"
                  )}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    {getStepIcon(step)}
                  </div>
                  <div className="flex-1 overflow-hidden">
                    <div className="flex items-center gap-2">
                      {multiAgent && step.kind !== 'respond' && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 flex-shrink-0">
                          {inferStepAgentRole(step)}
                          <span aria-hidden="true" className="ml-1 text-slate-600">·</span>
                        </span>
                      )}
                      <span className={cn(
                        "font-medium truncate",
                        step.status === 'running' ? "text-sky-200" : step.isError ? "text-rose-200" : "text-slate-200"
                      )}>
                        {step.label}
                      </span>
                      {step.toolName && (
                        <span className="px-1.5 py-0.2 rounded bg-slate-800/90 text-[9px] text-slate-400 border border-slate-700/60 flex-shrink-0">
                          {step.toolName}
                        </span>
                      )}
                    </div>
                    {step.details && (
                      <div className="text-[10px] text-slate-400 mt-0.5 whitespace-pre-wrap break-all font-sans">
                        {step.details}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {step.durationSec !== undefined && (
                      <span className="text-[10px] text-slate-500">
                        {step.durationSec}s
                      </span>
                    )}
                    {step.status === 'done' && !step.isError && (
                      <span className="w-3.5 h-3.5 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                        <Check className="w-2.5 h-2.5" />
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-slate-500 font-mono py-2">
              Waiting for tool execution...
            </div>
          )}
        </div>
      )}
    </div>
  );
};
