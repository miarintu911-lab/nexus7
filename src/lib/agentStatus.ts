import { ActionStep, AgentRole } from '../types/secrets';

export type AgentExecutionState = 'idle' | 'running' | 'done' | 'error';

export interface IndividualAgentStatus {
  role: AgentRole;
  name: string;
  focus: string;
  state: AgentExecutionState;
  activeTask: string | null;
  stepsCount: number;
  lastDurationSec?: number;
}

const ARCHITECT_TOOLS = new Set([
  'plan',
  'read_skill',
  'workspace_init',
  'ast_context_ranker',
  'codebase_graph',
  'analyze_project',
  'list_dir',
  'find_by_name',
  'grep_search',
  'read_multiple_files',
  'view_file',
  'fileRead',
  'listDir',
  'omo_coordinate',
  'omx_protocol',
  'ask_question',
  'search_web',
  'webSearch',
  'webFetch',
]);

const DEBUGGER_TOOLS = new Set([
  'compile_applet',
  'compileProject',
  'lint_applet',
  'lintProject',
  'debug_error_analysis',
  'targeted_error_context',
  'api_contract_checker',
  'verify_live_preview',
  'visual_qa_review',
  'code_execution_sandbox',
  'run_tests',
  'detect_secrets',
  'claw_doctor',
]);

const CODER_TOOLS = new Set([
  'write_to_file',
  'fileWrite',
  'replace_file_content',
  'fileEdit',
  'multi_replace_file_content',
  'delete_file',
  'fileDelete',
  'delete_dir',
  'move',
  'moveFile',
  'install_applet_package',
  'installPackage',
  'install_applet_dependencies',
  'generate_image',
  'generateImage',
  'fetch_stock_images',
  'set_up_firebase',
  'deploy_firebase',
  'github_clone',
  'workspace_run',
  'restart_dev_server',
  'restartServer',
  'focus_mode',
  'figma_import',
  'cloudsql_update_schema',
]);

export function inferStepAgentRole(step: ActionStep): AgentRole {
  if (step.agentRole) return step.agentRole;

  const labelLower = (step.label || '').toLowerCase();
  if (/reviewer|critic|self-healing|debug|error|visual qa|tsc|lint|verified live|built project/i.test(labelLower)) {
    return 'debugger';
  }
  if (/executor|wrote file|edited file|installed|cloned|generated image|fetched.*stock|firebase/i.test(labelLower)) {
    return 'coder';
  }
  if (/architect|plan|skill|initialized sandbox|ast|omo/i.test(labelLower)) {
    return 'architect';
  }

  const tool = step.toolName || '';
  if (DEBUGGER_TOOLS.has(tool)) return 'debugger';
  if (CODER_TOOLS.has(tool)) return 'coder';
  if (ARCHITECT_TOOLS.has(tool)) return 'architect';

  if (step.kind === 'qc' || step.kind === 'build') return 'debugger';
  if (step.kind === 'edit' || step.kind === 'file' || step.kind === 'restart') return 'coder';
  return 'architect';
}

export function deriveIndividualAgentStatuses(
  steps: ActionStep[],
  isLoading: boolean,
  actionLog?: string | null
): IndividualAgentStatus[] {
  const definitions: Array<{ role: AgentRole; name: string; focus: string }> = [
    { role: 'architect', name: 'Architect', focus: 'Design & planning' },
    { role: 'coder', name: 'Coder', focus: 'Implementation' },
    { role: 'debugger', name: 'Debugger', focus: 'Verification & fixes' },
  ];

  const grouped: Record<AgentRole, ActionStep[]> = {
    architect: [],
    coder: [],
    debugger: [],
  };

  for (const step of steps) {
    if (step.kind === 'respond') continue;
    const role = inferStepAgentRole(step);
    grouped[role].push(step);
  }

  const logText = (actionLog || '').toLowerCase();
  const inferredRunningRoleFromLog: AgentRole | null = isLoading && logText
    ? /critic|self-healing|এরর|ফিক্স|verify|tsc|lint|debug|পরীক্ষা/i.test(logText)
      ? 'debugger'
      : /wrote|edit|executor|কোড|ফাইল|toggling|write/i.test(logText)
        ? 'coder'
        : /architect|omo|plan|skill|স্পেক|প্ল্যান/i.test(logText)
          ? 'architect'
          : null
    : null;

  return definitions.map(({ role, name, focus }) => {
    const roleSteps = grouped[role];
    const runningStep = [...roleSteps].reverse().find((s) => s.status === 'running');
    const latestStep = roleSteps[roleSteps.length - 1];

    let state: AgentExecutionState = 'idle';
    let activeTask: string | null = null;

    if (runningStep) {
      state = 'running';
      activeTask = runningStep.details
        ? `${runningStep.label} · ${runningStep.details}`
        : runningStep.label;
    } else if (isLoading && inferredRunningRoleFromLog === role) {
      state = 'running';
      activeTask = actionLog || null;
    } else if (latestStep) {
      state = latestStep.status === 'error' || latestStep.isError ? 'error' : 'done';
      activeTask = latestStep.details
        ? `${latestStep.label} · ${latestStep.details}`
        : latestStep.label;
    }

    return {
      role,
      name,
      focus,
      state,
      activeTask,
      stepsCount: roleSteps.length,
      lastDurationSec: latestStep?.durationSec,
    };
  });
}
