import React from 'react';
import { Compass, Code2, Bug, Loader2, Check, AlertCircle, Circle } from 'lucide-react';
import { ActionStep, AgentRole } from '../types/secrets';
import { deriveIndividualAgentStatuses, IndividualAgentStatus } from '../lib/agentStatus';
import { cn } from '../lib/utils';

interface AgentStatusStripProps {
  steps: ActionStep[];
  isLoading: boolean;
  actionLog?: string | null;
  activeModel?: string | null;
  variant?: 'bar' | 'compact';
  className?: string;
}

const ROLE_ICON: Record<AgentRole, React.ComponentType<{ className?: string }>> = {
  architect: Compass,
  coder: Code2,
  debugger: Bug,
};

const STATE_LABEL: Record<IndividualAgentStatus['state'], string> = {
  idle: 'Standby',
  running: 'Working',
  done: 'Done',
  error: 'Issue',
};

export const AgentStatusStrip: React.FC<AgentStatusStripProps> = ({
  steps,
  isLoading,
  actionLog,
  activeModel,
  variant = 'bar',
  className,
}) => {
  const agents = deriveIndividualAgentStatuses(steps, isLoading, actionLog);
  const runningCount = agents.filter((a) => a.state === 'running').length;

  return (
    <div
      className={cn(
        'w-full rounded-xl border border-slate-800/90 bg-[#14161b]/95 text-xs',
        variant === 'bar' ? 'px-3 py-2' : 'px-2.5 py-2 bg-slate-950/60',
        className
      )}
    >
      {variant === 'bar' && (
        <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-slate-800/70">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-semibold text-slate-200 tracking-tight">
              Multi-Agent Pipeline
            </span>
            <span className="text-[11px] text-slate-500">·</span>
            <span className="text-[11px] text-slate-400 truncate">
              {runningCount > 0
                ? `${runningCount} active`
                : steps.length > 0
                  ? 'Cycle complete'
                  : 'Ready'}
            </span>
          </div>
          {activeModel && (
            <span className="text-[10px] font-mono text-slate-400 truncate max-w-[180px]">
              {activeModel}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        {agents.map((agent) => {
          const Icon = ROLE_ICON[agent.role];
          const isRunning = agent.state === 'running';
          const isDone = agent.state === 'done';
          const isError = agent.state === 'error';

          return (
            <div
              key={agent.role}
              className={cn(
                'flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border transition-colors min-w-0',
                isRunning
                  ? 'bg-sky-500/10 border-sky-500/35 text-sky-100'
                  : isError
                    ? 'bg-rose-500/10 border-rose-500/35 text-rose-100'
                    : isDone
                      ? 'bg-emerald-500/5 border-emerald-500/25 text-slate-200'
                      : 'bg-slate-900/60 border-slate-800/80 text-slate-400'
              )}
              title={agent.activeTask || `${agent.name}: ${agent.focus}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Icon
                  className={cn(
                    'w-3.5 h-3.5 flex-shrink-0',
                    isRunning
                      ? 'text-sky-400'
                      : isError
                        ? 'text-rose-400'
                        : isDone
                          ? 'text-emerald-400'
                          : 'text-slate-500'
                  )}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold leading-tight">
                    <span className="truncate">{agent.name}</span>
                    {agent.stepsCount > 0 && (
                      <span className="text-[10px] font-mono text-slate-500 font-normal">
                        ({agent.stepsCount})
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate leading-tight mt-0.5">
                    {agent.activeTask || agent.focus}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 flex-shrink-0 text-[10px] font-medium">
                {isRunning ? (
                  <Loader2 className="w-3 h-3 text-sky-400 animate-spin" />
                ) : isError ? (
                  <AlertCircle className="w-3 h-3 text-rose-400" />
                ) : isDone ? (
                  <Check className="w-3 h-3 text-emerald-400" />
                ) : (
                  <Circle className="w-2 h-2 text-slate-600 fill-slate-600" />
                )}
                <span
                  className={cn(
                    isRunning
                      ? 'text-sky-300'
                      : isError
                        ? 'text-rose-300'
                        : isDone
                          ? 'text-emerald-300'
                          : 'text-slate-500'
                  )}
                >
                  {STATE_LABEL[agent.state]}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
