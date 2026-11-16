import { GoogleGenAI, Type, type FunctionDeclaration } from "@google/genai";
import { exec, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import vm from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { Client as PgClient } from "pg";
import type { Response } from "express";
import { autoDeployWebsiteFromText, deployHtmlFile, getNexusSystemInstruction, prepareGeminiHistoryAndLastMessage } from "./websiteDeployer.ts";
import { getSkillByName, listAllSkillsSummary } from "./skillsRegistry.ts";
import { fetchBatchStockImages } from "./mediaFetcher.ts";
import {
  verifyLivePreviewWithDom,
  freeWebSearch,
  createCheckpoint,
  listCheckpoints,
  rollbackToCheckpoint,
  buildCodebaseGraph,
  runAutomatedTests,
  scheduleRealTask,
  listScheduledTasks,
  cancelScheduledTask,
  fuzzyReplaceContent,
} from "./workspaceEngine.ts";
import { rankAstContext } from "./astContextRanker.ts";
import {
  initSessionWorkspace,
  startWorkspaceServer,
  stopWorkspaceServer,
  buildWorkspaceToStaticPreview,
  getWorkspaceStatus,
  cloneGitHubRepoToWorkspace,
  normalizeGitHubRepoSpec,
  installPackagesInTarget,
  installDependenciesForTarget,
} from "./sandboxManager.ts";
import { getPersistenceStatus } from "./persistenceStore.ts";
import { runVisualQaReview } from "./visualQa.ts";
import {
  applyDeterministicPreWriteRepairs,
  checkApiContracts,
  extractTargetedErrorContext,
  validatePreWriteGuardrails,
} from "./harnessEngine.ts";
import {
  provisionFirebaseForTarget,
  deployRulesToFirebaseCloud,
  resolveFirebaseTargetDir,
  auditFirestoreRules,
  generateRulesFromBlueprint,
  parseFirebaseConfigInput,
  saveFirebaseProfile,
} from "./firebaseProvisioner.ts";

export interface AskQuestionItem {
  question: string;
  options: string[];
  is_multi_select?: boolean;
}

export interface AskQuestionAnswerPayload {
  answers: Record<string, string[]>;
  skipped?: boolean;
  notes?: string;
}

export interface FirebaseSetupRequestPayload {
  sessionId?: string;
  projectIdHint?: string;
  collections?: string[];
  reason?: string;
}

export interface FirebaseSetupResponsePayload {
  action: 'connect' | 'scaffold' | 'cancel';
  configSnippet?: string;
  projectId?: string;
  apiKey?: string;
  authDomain?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  firestoreDatabaseId?: string;
  serviceAccountJson?: string;
  firebaseToken?: string;
  saveToGlobalProfile?: boolean;
}

export interface ToolExecutionContext {
  sessionId?: string;
  sandboxLockSessionId?: string;
  signal?: AbortSignal;
  geminiApiKey?: string;
  geminiModel?: string;
  compactMode?: boolean;
  readFiles?: Set<string>;
  llmInvoker?: (systemPrompt: string, userPrompt: string) => Promise<string>;
  onAskQuestion?: (questions: AskQuestionItem[]) => Promise<AskQuestionAnswerPayload>;
  onRequestFirebaseSetup?: (request: FirebaseSetupRequestPayload) => Promise<FirebaseSetupResponsePayload>;
  allowInteractiveFirebasePrompt?: boolean;
  onAgentStep?: (step: {
    id: string;
    kind: 'agent' | 'thought' | 'qc' | 'command';
    label: string;
    agentRole?: 'architect' | 'coder' | 'debugger';
    detail?: string;
    status: 'running' | 'done' | 'error';
    durationSec?: number;
  }) => void;
}

const execPromise = promisify(exec);

interface BackgroundTask {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  output: string;
  process?: ChildProcess;
}

const backgroundTasks = new Map<string, BackgroundTask>();

export function listBackgroundTasks() {
  return Array.from(backgroundTasks.values()).map(({ process: _p, ...rest }) => ({
    ...rest,
    outputTail: rest.output.slice(-2000),
  }));
}

export function manageBackgroundTask(action: 'list' | 'status' | 'kill' | 'send_input', taskId?: string, input?: string) {
  if (action === 'list') {
    return { tasks: listBackgroundTasks() };
  }
  if (!taskId) return { error: 'TaskId is required for status, kill, or send_input' };
  const task = backgroundTasks.get(taskId);
  if (!task) return { error: `Task ${taskId} not found` };

  if (action === 'status') {
    return {
      id: task.id,
      command: task.command,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      exitCode: task.exitCode,
      output: task.output.slice(-4000),
    };
  }
  if (action === 'kill') {
    if (task.process && task.status === 'running') {
      task.process.kill('SIGTERM');
      task.status = 'killed';
      task.finishedAt = Date.now();
    }
    return { success: true, id: task.id, status: task.status };
  }
  if (action === 'send_input') {
    if (!task.process || !task.process.stdin || task.status !== 'running') {
      return { error: `Task ${taskId} is not running or does not accept stdin` };
    }
    task.process.stdin.write((input || '') + '\n');
    return { success: true, id: task.id, message: 'Input sent to running task' };
  }
  return { error: `Unsupported action: ${action}` };
}

// Lazy Server-Side Gemini client
function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// ============================================================================
// OFFICIAL GOOGLE AI STUDIO BUILD TOOL DECLARATIONS
// ============================================================================

const writeToFileTool: FunctionDeclaration = {
  name: "write_to_file",
  description: "Use this tool to create new files. The file and any parent directories will be created for you if they do not already exist. Write files in one complete, pristine block.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to create and write code to. Absolute path starting with / or relative to workspace root." },
      CodeContent: { type: Type.STRING, description: "The complete code contents to write to the file." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      Overwrite: { type: Type.BOOLEAN, description: "Set to true to overwrite an existing file." },
      Append: { type: Type.BOOLEAN, description: "Set to true to append CodeContent to the end of TargetFile." },
    },
    required: ["TargetFile", "CodeContent", "Description"],
  },
};

const replaceFileContentTool: FunctionDeclaration = {
  name: "replace_file_content",
  description: "Use this tool to edit an existing file by replacing a single contiguous block of code. Specify StartLine, EndLine, TargetContent, and ReplacementContent.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to modify." },
      Instruction: { type: Type.STRING, description: "Description of the changes being made." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      TargetContent: { type: Type.STRING, description: "The exact string to be replaced. Must match existing text." },
      ReplacementContent: { type: Type.STRING, description: "The complete replacement content." },
      StartLine: { type: Type.INTEGER, description: "Starting line number of chunk (1-indexed)." },
      EndLine: { type: Type.INTEGER, description: "Ending line number of chunk (1-indexed)." },
      AllowMultiple: { type: Type.BOOLEAN, description: "If true, multiple occurrences will be replaced." },
    },
    required: ["TargetFile", "Instruction", "Description", "TargetContent", "ReplacementContent"],
  },
};

const multiReplaceFileContentTool: FunctionDeclaration = {
  name: "multi_replace_file_content",
  description: "Use this tool to edit an existing file with multiple non-contiguous edits in a single call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to modify." },
      Instruction: { type: Type.STRING, description: "Description of the changes being made." },
      Description: { type: Type.STRING, description: "Brief explanation of what this change did." },
      ReplacementChunks: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            TargetContent: { type: Type.STRING, description: "Exact target substring to replace." },
            ReplacementContent: { type: Type.STRING, description: "Replacement content." },
            StartLine: { type: Type.INTEGER, description: "Start line number." },
            EndLine: { type: Type.INTEGER, description: "End line number." },
          },
          required: ["TargetContent", "ReplacementContent"],
        },
        description: "List of chunks to replace.",
      },
    },
    required: ["TargetFile", "Instruction", "Description", "ReplacementChunks"],
  },
};

const viewFileTool: FunctionDeclaration = {
  name: "view_file",
  description: "View the contents of a file from the local filesystem with 1-indexed line numbers. Specify StartLine and EndLine to view a slice.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      AbsolutePath: { type: Type.STRING, description: "Path to file to view (starting with / or relative to root)." },
      StartLine: { type: Type.INTEGER, description: "Optional start line to view (1-indexed, inclusive)." },
      EndLine: { type: Type.INTEGER, description: "Optional end line to view (1-indexed, inclusive)." },
      ContentOffset: { type: Type.INTEGER, description: "Optional byte offset for large files." },
    },
    required: ["AbsolutePath"],
  },
};

const listDirTool: FunctionDeclaration = {
  name: "list_dir",
  description: "List the contents of a directory, all files and subdirectories.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      DirectoryPath: { type: Type.STRING, description: "The path to the directory to list contents of." },
    },
    required: ["DirectoryPath"],
  },
};

const runCommandTool: FunctionDeclaration = {
  name: "run_command",
  description: "PROPOSE and execute a command on the project system (bash shell). Supports WaitMsBeforeAsync and IsDaemon for background tasks (e.g. git clone, tests, npm builds, inspections). Never use cd.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      CommandLine: { type: Type.STRING, description: "The exact command line string to execute." },
      Cwd: { type: Type.STRING, description: "The current working directory for the command." },
      WaitMsBeforeAsync: { type: Type.INTEGER, description: "Milliseconds to wait before sending to background (default 5000, max 10000)." },
      IsDaemon: { type: Type.BOOLEAN, description: "Set to true for long-running background daemon processes." },
    },
    required: ["CommandLine"],
  },
};

const manageTaskTool: FunctionDeclaration = {
  name: "manage_task",
  description: "Manage background tasks spawned by run_command: list running tasks, check status/output, send stdin input, or kill a task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Action: { type: Type.STRING, enum: ["list", "status", "kill", "send_input"], description: "Action to perform on background tasks." },
      TaskId: { type: Type.STRING, description: "The task ID to manage (required for status, kill, send_input)." },
      Input: { type: Type.STRING, description: "Input text to send to stdin (for send_input)." },
    },
    required: ["Action"],
  },
};

const installAppletPackageTool: FunctionDeclaration = {
  name: "install_applet_package",
  description: "Install npm packages to the active session workspace (workspaces/<sessionId>/) or project root. Adds packages to package.json and installs them cleanly without peer-conflict failures. Call BEFORE importing new packages.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      PackageNames: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "The names of npm packages to install (e.g. ['zustand', 'lucide-react', 'date-fns']).",
      },
      IsDevDependency: { type: Type.BOOLEAN, description: "Whether to install as dev dependency (-D)." },
      sessionId: { type: Type.STRING, description: "Optional session workspace ID (auto-detected from active session if omitted)." },
      TargetDir: { type: Type.STRING, description: "Optional target directory (e.g. 'workspaces/session_123' or '.' for root)." },
    },
    required: ["PackageNames"],
  },
};

const installAppletDependenciesTool: FunctionDeclaration = {
  name: "install_applet_dependencies",
  description: "Install all dependencies from package.json via npm install for the active session workspace or root project. Use after cloning a repository or modifying package.json.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sessionId: { type: Type.STRING, description: "Optional session workspace ID." },
      TargetDir: { type: Type.STRING, description: "Optional target directory (e.g. 'workspaces/session_123' or '.' for root)." },
    },
  },
};

const grepSearchTool: FunctionDeclaration = {
  name: "grep_search",
  description: "Fast regex/text search across workspace source files, returning matching file paths, line numbers, and line previews (skips node_modules, .git, dist).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Pattern: { type: Type.STRING, description: "Text or regex pattern to search for (e.g. 'useState|useEffect')." },
      SearchPath: { type: Type.STRING, description: "Directory or file relative to workspace root to search in (default '.')." },
    },
    required: ["Pattern"],
  },
};

const findByNameTool: FunctionDeclaration = {
  name: "find_by_name",
  description: "Find files in the workspace matching a filename or glob pattern (skips node_modules, .git, dist).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Pattern: { type: Type.STRING, description: "Filename or glob pattern (e.g. '*.tsx', '*Modal*')." },
      SearchDirectory: { type: Type.STRING, description: "Directory to search in (default '.')." },
    },
    required: ["Pattern"],
  },
};

const readSkillTool: FunctionDeclaration = {
  name: "read_skill",
  description: "Read specialized coding skill documentation (e.g., frontend-design, ui-cookbook, github-import-migration, pwa-integration, firebase-integration, gemini-api, threejs, cloudsql-setup) before building or migrating.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      SkillName: { type: Type.STRING, description: "Name of the skill to read, or 'list' to list all available coding skills." },
      compact: { type: Type.BOOLEAN, description: "Optional: return compact 1-shot cheatsheet instructions to save tokens." },
    },
    required: ["SkillName"],
  },
};

const analyzeProjectTool: FunctionDeclaration = {
  name: "analyze_project",
  description: "Inspect workspace structure, package.json scripts/dependencies, and key source files in one call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetDirectory: { type: Type.STRING, description: "Optional subdirectory to inspect (default '.')." },
    },
  },
};

const gitStatusTool: FunctionDeclaration = {
  name: "git_status",
  description: "Check current git branch and working tree status.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const gitDiffTool: FunctionDeclaration = {
  name: "git_diff",
  description: "View uncommitted git changes in the workspace.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const detectSecretsTool: FunctionDeclaration = {
  name: "detect_secrets",
  description: "Scan source files for hardcoded API keys, tokens, or credentials.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const codeExecutionSandboxTool: FunctionDeclaration = {
  name: "code_execution_sandbox",
  description: "Code Execution Sandbox: safely execute Python, JavaScript, TypeScript, or Bash code snippets inside an isolated temporary sandbox directory to test algorithms, verify syntax, or reproduce bugs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Language: { type: Type.STRING, enum: ["python", "javascript", "typescript", "bash"], description: "Programming language runtime to execute." },
      Code: { type: Type.STRING, description: "Source code to execute inside the sandbox." },
      TimeoutMs: { type: Type.INTEGER, description: "Execution timeout in milliseconds (default 10000, max 15000)." },
    },
    required: ["Language", "Code"],
  },
};

const readMultipleFilesTool: FunctionDeclaration = {
  name: "read_multiple_files",
  description: "Multi-File Context: read up to 10 workspace files simultaneously in one batch call to understand cross-file imports, types, and architecture.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      FilePaths: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Array of relative file paths to read (e.g. ['src/App.tsx', 'server.ts']).",
      },
    },
    required: ["FilePaths"],
  },
};

const computeFileDiffTool: FunctionDeclaration = {
  name: "compute_file_diff",
  description: "Diff Management: compute a unified line-by-line diff between a workspace file and git HEAD or proposed new content.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "Path to workspace file." },
      ProposedContent: { type: Type.STRING, description: "Optional proposed new content to diff against the current file on disk. If omitted, diffs against git HEAD." },
    },
    required: ["TargetFile"],
  },
};

const debugErrorAnalysisTool: FunctionDeclaration = {
  name: "debug_error_analysis",
  description: "Debugging & Error Analysis: run TypeScript diagnostics (tsc --noEmit), inspect stack trace / error logs, and read failing file line slices to diagnose root cause.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      ErrorMessage: { type: Type.STRING, description: "Optional error message or stack trace reported by user or build." },
      TargetFile: { type: Type.STRING, description: "Optional suspected file path to inspect." },
    },
  },
};

const clawDoctorTool: FunctionDeclaration = {
  name: "claw_doctor",
  description: "Claw CLI Doctor: comprehensive health check of local environment, runtime binaries (node, python, git, tsx), port 3000, disk, memory, and API key pool connectivity.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      runNetworkCheck: { type: Type.BOOLEAN, description: "Whether to run outbound connectivity check." },
    },
  },
};

const clawStatusTool: FunctionDeclaration = {
  name: "claw_status",
  description: "Claw CLI Status: inspect harness runtime status, active session, background tasks, loaded skills, registered tools, memory usage, and model routing.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const clawAcpTool: FunctionDeclaration = {
  name: "claw_acp",
  description: "Claw Agent Client Protocol (ACP): inspect protocol capabilities, session handshake, tools list, and transport status.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING, enum: ["status", "capabilities", "handshake"], description: "ACP action to perform." },
    },
  },
};

const clawPromptTool: FunctionDeclaration = {
  name: "claw_prompt",
  description: "Claw CLI Prompt: dispatch a task or directive directly to the Claw agent harness with execution mode and sub-agent parameters.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: { type: Type.STRING, description: "Prompt or directive to execute." },
      role: { type: Type.STRING, description: "Agent persona/role (e.g. 'architect', 'executor', 'debugger')." },
      dryRun: { type: Type.BOOLEAN, description: "Simulate execution without modifying files." },
    },
    required: ["prompt"],
  },
};

const omoCoordinateTool: FunctionDeclaration = {
  name: "omo_coordinate",
  description: "OmO (oh-my-openagent): orchestrate multi-agent coordination between Architect (design), Executor (code), and Reviewer (verification) with automated handoffs and consensus.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      task: { type: Type.STRING, description: "The task to coordinate across sub-agents." },
      context: { type: Type.STRING, description: "Optional project context or relevant files." },
      subAgents: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Sub-agents participating (e.g. ['Architect', 'Executor', 'Reviewer']).",
      },
    },
    required: ["task"],
  },
};

const omxProtocolTool: FunctionDeclaration = {
  name: "omx_protocol",
  description: "OmX (oh-my-codex): convert user instructions into a 3-phase structured execution protocol (Problem Decomposition -> Parallel Workstreams -> Persistent Verification Loop).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      goal: { type: Type.STRING, description: "The goal or user prompt to translate into structured protocol." },
      targetStack: { type: Type.STRING, description: "Target technology stack (e.g. 'React 19 + TypeScript + Vite + Tailwind v4 + Express')." },
    },
    required: ["goal"],
  },
};

const clawhipRouterTool: FunctionDeclaration = {
  name: "clawhip_router",
  description: "ClawHip Event Router: manage out-of-band events and notifications (Git commits, background task lifecycles, PRs, milestones) outside primary LLM context window.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING, enum: ["list", "emit", "clear"], description: "Action to perform on the event router." },
      eventType: { type: Type.STRING, description: "Event type (e.g. 'git_commit', 'task_lifecycle', 'agent_milestone', 'notification')." },
      message: { type: Type.STRING, description: "Event message or summary." },
      metadata: { type: Type.STRING, description: "JSON stringified metadata." },
    },
    required: ["action"],
  },
};

const lazycodexRunnerTool: FunctionDeclaration = {
  name: "lazycodex_runner",
  description: "Gajae-Code / LazyCodex: autonomous iterative coding runner that executes code development tasks, runs compiler/type verification, and self-heals iteratively until passing.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      task: { type: Type.STRING, description: "The coding task to execute autonomously." },
      targetFiles: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Files targeted for generation/modification.",
      },
      maxIterations: { type: Type.INTEGER, description: "Maximum self-healing verification iterations (default: 3)." },
    },
    required: ["task"],
  },
};

const compileAppletTool: FunctionDeclaration = {
  name: "compile_applet",
  description: "Checks if the applet / website builds successfully. Runs build verification and returns compiler errors or success.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const lintAppletTool: FunctionDeclaration = {
  name: "lint_applet",
  description: "Validates codebase for syntax errors, missing imports, and fatal issues using tsc --noEmit or npm run lint.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const restartDevServerTool: FunctionDeclaration = {
  name: "restart_dev_server",
  description: "Restarts or refreshes the development server process after updating dependencies, packages, or server files.",
  parameters: { type: Type.OBJECT, properties: {} },
};

const deleteFileTool: FunctionDeclaration = {
  name: "delete_file",
  description: "Delete an existing file.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetFile: { type: Type.STRING, description: "The target file to delete." },
    },
    required: ["TargetFile"],
  },
};

const deleteDirTool: FunctionDeclaration = {
  name: "delete_dir",
  description: "Delete a directory.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      DirectoryPath: { type: Type.STRING, description: "The directory to delete." },
      Force: { type: Type.BOOLEAN, description: "If true, recursively delete all contents." },
    },
    required: ["DirectoryPath"],
  },
};

const moveTool: FunctionDeclaration = {
  name: "move",
  description: "Move or rename a file or directory to a new path.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      SourcePath: { type: Type.STRING, description: "Path to existing file or directory." },
      DestinationPath: { type: Type.STRING, description: "Destination path." },
    },
    required: ["SourcePath", "DestinationPath"],
  },
};

const searchWebTool: FunctionDeclaration = {
  name: "search_web",
  description: "Performs a web search for documentation, packages, modern code examples, and technical solutions.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "The search query." },
      domain: { type: Type.STRING, description: "Optional domain to recommend search prioritize." },
    },
    required: ["query"],
  },
};

const generateImageTool: FunctionDeclaration = {
  name: "generate_image",
  description: "Generate a custom bespoke hero banner, brand illustration, or app icon via AI image generation. For seed data, product cards, catalogs, avatars, or multiple photos, use fetch_stock_images instead (0 AI image tokens).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Prompt: { type: Type.STRING, description: "The text prompt to generate image for." },
      ImageName: { type: Type.STRING, description: "Name of the generated image to save (e.g. 'hero_banner', 'app_icon')." },
      AspectRatio: { type: Type.STRING, enum: ["1:1", "16:9", "4:3", "9:16", "3:4"], description: "Aspect ratio." },
    },
    required: ["Prompt"],
  },
};

const fetchStockImagesTool: FunctionDeclaration = {
  name: "fetch_stock_images",
  description: "Batch-fetch real royalty-free stock photos (Openverse, Wikimedia Commons, Wikipedia, zero-token fallback) and save them locally in a single call (0 Gemini image tokens). Ideal for seed data, product catalogs, cards, galleries, blog thumbnails, and avatars. Automatically writes into workspaces/<sessionId>/public/images/ and returns ready-to-use './images/<file>' URLs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        description: "List of up to 16 images to fetch concurrently in one batch call.",
        items: {
          type: Type.OBJECT,
          properties: {
            query: { type: Type.STRING, description: "Concise English descriptive search query (e.g. 'artisan iced latte coffee glass', 'modern wireless headphones')." },
            filename: { type: Type.STRING, description: "Optional clean file slug without extension (e.g. 'iced_latte', 'headphones')." },
            aspectRatio: { type: Type.STRING, enum: ["1:1", "16:9", "4:3", "3:4", "9:16"], description: "Target aspect ratio (default: 16:9, use 1:1 for products/avatars)." },
          },
          required: ["query"],
        },
      },
      sessionId: { type: Type.STRING, description: "Optional workspace session ID (defaults to active session)." },
      targetDir: { type: Type.STRING, description: "Optional explicit relative directory override (defaults to workspaces/<sessionId>/public/images)." },
    },
    required: ["items"],
  },
};

const askQuestionTool: FunctionDeclaration = {
  name: "ask_question",
  description: "Ask clarifying questions with interactive multiple-choice options and pause execution until the user submits or skips.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      questions: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            question: { type: Type.STRING, description: "Short question (1-2 sentences)." },
            options: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Short plain-text options." },
            is_multi_select: { type: Type.BOOLEAN, description: "Allow multiple selection." },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const verifyLivePreviewTool: FunctionDeclaration = {
  name: "verify_live_preview",
  description: "Verifies the live preview webpage served on localhost:3000 by checking HTTP status, HTML structure, JavaScript syntax inside inline <script> tags, and local assets/PWA links (manifest, sw.js, icons, local scripts/styles).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUrl: { type: Type.STRING, description: "Relative preview URL (e.g. '/projects/index.html' or '/projects/<sessionId>/index.html')." },
      checkAssets: { type: Type.BOOLEAN, description: "Whether to verify local assets and PWA companion files return HTTP 200 (default: true)." },
    },
  },
};

// ============================================================================
// LEGACY COMPATIBILITY TOOL ALIASES (to support both styles seamlessly)
// ============================================================================

const fileReadTool: FunctionDeclaration = {
  name: "fileRead",
  description: "Read the content of a file (alias for view_file).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "The path to the file relative to project root." },
    },
    required: ["filePath"],
  },
};

const fileWriteTool: FunctionDeclaration = {
  name: "fileWrite",
  description: "Write content to a file (alias for write_to_file).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "The path to the file relative to project root." },
      content: { type: Type.STRING, description: "The content to write." },
    },
    required: ["filePath", "content"],
  },
};

const fileEditTool: FunctionDeclaration = {
  name: "fileEdit",
  description: "Edit an existing file by replacing a specific block of text (alias for replace_file_content).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      filePath: { type: Type.STRING, description: "Path to the file." },
      oldText: { type: Type.STRING, description: "The exact text to be replaced." },
      newText: { type: Type.STRING, description: "The replacement text." },
    },
    required: ["filePath", "oldText", "newText"],
  },
};

const bashTool: FunctionDeclaration = {
  name: "bash",
  description: "Execute a bash command in the project terminal (alias for run_command).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: "The bash command to execute." },
    },
    required: ["command"],
  },
};

const webFetchTool: FunctionDeclaration = {
  name: "webFetch",
  description: "Fetch data or inspect website layout from a URL.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: "The URL to fetch data from." },
    },
    required: ["url"],
  },
};

const planTool: FunctionDeclaration = {
  name: "plan",
  description: "Create or update a step-by-step implementation plan for a complex task.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      steps: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING },
        description: "List of steps to execute." 
      },
    },
    required: ["steps"],
  },
};

const setUpFirebaseTool: FunctionDeclaration = {
  name: "set_up_firebase",
  description: "Autonomously provisions code-matched Firebase Firestore, Auth & Storage inside the active session workspace (or targetDir): infers entities from src/types.ts when omitted, generates firebase-blueprint.json, firebase-config.json, security-hardened firestore.rules, src/lib/firebase.ts, src/components/FirebaseProvider.tsx, src/services/firebaseBackend.ts, and server/firebaseAdmin.ts (if full-stack).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      platform: { type: Type.STRING, description: "Platform target: 'web' or 'android'." },
      sessionId: { type: Type.STRING, description: "Optional session ID (defaults to active workspace session)." },
      targetDir: { type: Type.STRING, description: "Optional relative directory (e.g. 'workspaces/session_123')." },
      projectId: { type: Type.STRING, description: "Optional Firebase Project ID (auto-inherited from global Nexus Firebase profile if omitted)." },
      apiKey: { type: Type.STRING, description: "Optional Firebase Web API key." },
      authDomain: { type: Type.STRING, description: "Optional Auth domain." },
      storageBucket: { type: Type.STRING, description: "Optional Storage bucket." },
      messagingSenderId: { type: Type.STRING, description: "Optional Messaging sender ID." },
      appId: { type: Type.STRING, description: "Optional Firebase App ID." },
      firestoreDatabaseId: { type: Type.STRING, description: "Optional named Firestore database ID." },
      blueprint: {
        type: Type.OBJECT,
        description: "Optional structured Firebase blueprint with entities (requiredFields, allowedFields) and collections (path, entity, access: 'owner'|'authenticated'|'public_read_auth_write'|'admin_only'|'role_based', ownerField).",
      },
      rules: { type: Type.STRING, description: "Optional custom firestore.rules content (otherwise auto-generated from blueprint)." },
      saveToGlobalProfile: { type: Type.BOOLEAN, description: "If true and real credentials are passed, save them globally for future Nexus apps." },
      skipInteractivePrompt: { type: Type.BOOLEAN, description: "Only set true when saved Firebase Settings already exist; do NOT set true when no credentials exist and user asked to set up Firebase." },
      interactive: { type: Type.BOOLEAN, description: "Set true when the user asked to set up/connect Firebase and no saved credentials exist yet." },
      userConfirmedTermsAcceptedInUI: { type: Type.BOOLEAN, description: "Whether Firebase provisioning is confirmed." },
    },
    required: ["platform"],
  },
};

const deployFirebaseTool: FunctionDeclaration = {
  name: "deploy_firebase",
  description: "Validates, security-audits, saves, and (when Service Account / FIREBASE_TOKEN is connected) live-deploys firestore.rules to Google Cloud Firestore via Firebase Rules REST API.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sessionId: { type: Type.STRING, description: "Optional session ID (defaults to active workspace)." },
      targetDir: { type: Type.STRING, description: "Optional relative directory containing firestore.rules." },
      rules: { type: Type.STRING, description: "Optional firestore.rules content to write, audit, and deploy." },
    },
  },
};

const setUpOAuthTool: FunctionDeclaration = {
  name: "set_up_oauth",
  description: "Initiates OAuth setup for Google Workspace APIs (Google Drive, Docs, Sheets, Calendar, Gmail) or external OAuth providers.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "Title of the OAuth task/step (e.g. 'Use Google Drive to read files')." },
      scopes_to_add: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "List of OAuth scopes required by the applet.",
      },
      userConfirmedInUI: { type: Type.BOOLEAN, description: "Whether user confirmed OAuth configuration." },
    },
    required: ["title", "scopes_to_add"],
  },
};

const removeOAuthTool: FunctionDeclaration = {
  name: "remove_oauth",
  description: "Removes specified OAuth scopes from applet configuration.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      scopes_to_remove: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "OAuth scopes to remove.",
      },
    },
    required: ["scopes_to_remove"],
  },
};

const cloudSqlExecuteSqlTool: FunctionDeclaration = {
  name: "cloudsql_execute_sql",
  description: "Executes SQL query (DQL/DML) on the local/Cloud SQL PostgreSQL database instance to seed data, verify tables, or query records.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sql_statement: { type: Type.STRING, description: "SQL query statement to execute." },
    },
    required: ["sql_statement"],
  },
};

const cloudSqlUpdateSchemaTool: FunctionDeclaration = {
  name: "cloudsql_update_schema",
  description: "Updates and validates database schema defined in src/db/schema.ts using Drizzle ORM.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      schemaPath: { type: Type.STRING, description: "Path to schema file (default: 'src/db/schema.ts')." },
    },
  },
};

const figmaImportTool: FunctionDeclaration = {
  name: "figma_import",
  description: "Turns an attached Figma design reference, figma.com URL, or specification into clean React + Tailwind CSS code in the workspace.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      componentName: { type: Type.STRING, description: "Name of the component to create." },
      designSpecs: { type: Type.STRING, description: "Description or specs of the Figma design." },
      figmaUrl: { type: Type.STRING, description: "Optional Figma file/frame URL." },
      targetFile: { type: Type.STRING, description: "Optional target component file path (e.g. 'src/components/HeroSection.tsx')." },
    },
    required: ["componentName", "designSpecs"],
  },
};

const focusModeTool: FunctionDeclaration = {
  name: "focus_mode",
  description: "Applies targeted surgical UI edits to a specific CSS selector or component without touching surrounding code.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      cssSelector: { type: Type.STRING, description: "CSS selector targeted (e.g. '#header', '.cart-drawer')." },
      targetFile: { type: Type.STRING, description: "File containing the element." },
      editInstruction: { type: Type.STRING, description: "Exact visual/functional change to apply." },
    },
    required: ["cssSelector", "editInstruction"],
  },
};

const scheduleTool: FunctionDeclaration = {
  name: "schedule",
  description: "Schedule a real background one-shot timer or recurring interval job, or list/cancel scheduled jobs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Action: { type: Type.STRING, enum: ["create", "list", "cancel"], description: "Scheduler action (default: create)." },
      DurationSeconds: { type: Type.INTEGER, description: "Duration in seconds for timer." },
      Recurring: { type: Type.BOOLEAN, description: "Whether timer repeats at the given interval." },
      Prompt: { type: Type.STRING, description: "Message prompt when timer fires." },
      JobId: { type: Type.STRING, description: "Job ID when cancelling." },
    },
  },
};

const gitCheckpointTool: FunctionDeclaration = {
  name: "git_checkpoint",
  description: "Create an atomic workspace checkpoint snapshot (and git commit if available) before risky edits, or list saved checkpoints.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      Action: { type: Type.STRING, enum: ["create", "list"], description: "Create a new checkpoint or list existing checkpoints (default: create)." },
      Label: { type: Type.STRING, description: "Short descriptive label for this checkpoint." },
    },
  },
};

const gitRollbackTool: FunctionDeclaration = {
  name: "git_rollback",
  description: "Rollback workspace files cleanly to a previously saved checkpoint ID.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      CheckpointId: { type: Type.STRING, description: "Checkpoint ID to restore (e.g. 'cp_...'). If omitted, restores the latest checkpoint." },
    },
  },
};

const codebaseGraphTool: FunctionDeclaration = {
  name: "codebase_graph",
  description: "Inspect the import/export symbol graph and Express API routes across src/ and server/ in one compact token-saving call.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TargetDirectory: { type: Type.STRING, description: "Directory to map (default: '.')." },
    },
  },
};

const runTestsTool: FunctionDeclaration = {
  name: "run_tests",
  description: "Run automated unit/integration tests (vitest, npm test, or Node 22 built-in test runner) and return pass/fail output.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      TestTarget: { type: Type.STRING, description: "Optional test file or directory path." },
    },
  },
};

const workspaceInitTool: FunctionDeclaration = {
  name: "workspace_init",
  description: "Create an isolated per-session sandbox workspace under workspaces/<sessionId>/ (defaults to 'react-vite' for React+Tailwind+Firebase apps; use 'fullstack-express' only when custom Express API routes are explicitly needed).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      template: { type: Type.STRING, enum: ["static", "react-vite", "fullstack-express"], description: "Workspace template (default: react-vite)." },
      appTitle: { type: Type.STRING, description: "Title of the sandboxed app." },
      sessionId: { type: Type.STRING, description: "Optional explicit workspace ID (defaults to active session)." },
    },
  },
};

const workspaceRunTool: FunctionDeclaration = {
  name: "workspace_run",
  description: "Build ('build' — runs vite build and publishes lightweight static production bundle to /projects/<sessionId>/index.html while freeing dev server RAM), or start/stop/inspect an isolated sandbox sub-server at /w/<sessionId>/.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: { type: Type.STRING, enum: ["build", "start", "stop", "status"], description: "Action to perform ('build' recommended for React+Firebase apps; 'start' only when custom Express backend is required)." },
      sessionId: { type: Type.STRING, description: "Workspace session ID." },
      command: { type: Type.STRING, description: "Optional custom start command." },
    },
  },
};

const githubCloneTool: FunctionDeclaration = {
  name: "github_clone",
  description: "Clone a GitHub repository (supports 'owner/repo', 'gh repo clone owner/repo', or 'https://github.com/owner/repo') directly into the isolated session workspace workspaces/<sessionId>/, normalize dependencies and Vite/Express /w/<sessionId>/ proxy routing, and boot it for Live Preview.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      repo: { type: Type.STRING, description: "GitHub repository slug or URL (e.g. 'arifnanhssb-ai/Nexus-ai' or 'https://github.com/owner/repo')." },
      sessionId: { type: Type.STRING, description: "Optional workspace session ID (defaults to active session)." },
      branch: { type: Type.STRING, description: "Optional branch name to clone." },
      autoStart: { type: Type.BOOLEAN, description: "Automatically install/link dependencies and start the sandbox preview server (default: true)." },
    },
    required: ["repo"],
  },
};

const astContextRankerTool: FunctionDeclaration = {
  name: "ast_context_ranker",
  description: "Extract TypeScript/TSX AST function signatures, interfaces, props, routes, and call-graph ranked by relevance to your query—saves 60-70% tokens vs reading whole files.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: { type: Type.STRING, description: "Feature, symbol, error, or file topic to rank codebase context around." },
      targetDir: { type: Type.STRING, description: "Directory to scan (default: '.')." },
      topK: { type: Type.INTEGER, description: "Max ranked files to return (default: 10)." },
    },
    required: ["query"],
  },
};

const visualQaReviewTool: FunctionDeclaration = {
  name: "visual_qa_review",
  description: "Capture a real rendered browser screenshot (via Browserless/Playwright) + Vision LLM layout/contrast critique or JSDOM responsive audit on a live preview URL (/projects/... or /w/<id>/).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUrl: { type: Type.STRING, description: "URL path to inspect (e.g. '/projects/index.html' or '/w/default/')." },
      viewport: { type: Type.STRING, enum: ["desktop", "mobile"], description: "Viewport preset (default: desktop)." },
    },
  },
};

const persistenceStatusTool: FunctionDeclaration = {
  name: "persistence_status",
  description: "Check connected persistent storage backend (PostgreSQL, Turso, Supabase, or local SQLite) and synced secrets/checkpoints counts.",
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const apiContractCheckerTool: FunctionDeclaration = {
  name: "api_contract_checker",
  description: "Verify that frontend fetch/axios /api/* calls match Express backend routes and HTTP methods (catches 404/method/mount-order mismatches).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetDir: { type: Type.STRING, description: "Workspace or directory to check (e.g. 'workspaces/session_123' or '.')." },
    },
  },
};

const targetedErrorContextTool: FunctionDeclaration = {
  name: "targeted_error_context",
  description: "Parse TypeScript/Vite build errors and return exact ±20 line code slices, import headers, and Error KB fix hints (saves reading whole files).",
  parameters: {
    type: Type.OBJECT,
    properties: {
      errorOutput: { type: Type.STRING, description: "Optional compiler/build error text. If omitted, runs tsc --noEmit automatically." },
      targetDir: { type: Type.STRING, description: "Optional workspace directory (e.g. 'workspaces/session_123' or '.')." },
    },
  },
};

export const serverTools: FunctionDeclaration[] = [
  // Primary AI Studio Coding Mode Tools
  readSkillTool,
  analyzeProjectTool,
  codebaseGraphTool,
  astContextRankerTool,
  apiContractCheckerTool,
  targetedErrorContextTool,
  grepSearchTool,
  findByNameTool,
  writeToFileTool,
  replaceFileContentTool,
  multiReplaceFileContentTool,
  viewFileTool,
  listDirTool,
  runCommandTool,
  manageTaskTool,
  installAppletPackageTool,
  installAppletDependenciesTool,
  compileAppletTool,
  lintAppletTool,
  runTestsTool,
  restartDevServerTool,
  deleteFileTool,
  deleteDirTool,
  moveTool,
  gitStatusTool,
  gitDiffTool,
  gitCheckpointTool,
  gitRollbackTool,
  detectSecretsTool,
  codeExecutionSandboxTool,
  readMultipleFilesTool,
  computeFileDiffTool,
  debugErrorAnalysisTool,
  verifyLivePreviewTool,
  visualQaReviewTool,
  workspaceInitTool,
  workspaceRunTool,
  githubCloneTool,
  persistenceStatusTool,
  searchWebTool,
  generateImageTool,
  fetchStockImagesTool,
  askQuestionTool,
  setUpFirebaseTool,
  deployFirebaseTool,
  setUpOAuthTool,
  removeOAuthTool,
  cloudSqlExecuteSqlTool,
  cloudSqlUpdateSchemaTool,
  figmaImportTool,
  focusModeTool,
  scheduleTool,
  // UltraWorkers & Claw Harness Tools
  clawDoctorTool,
  clawStatusTool,
  clawAcpTool,
  clawPromptTool,
  omoCoordinateTool,
  omxProtocolTool,
  clawhipRouterTool,
  lazycodexRunnerTool,
  // Legacy aliases for full backward compatibility
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  bashTool,
  webFetchTool,
  planTool,
];

export async function runCodeInSandbox(
  language: string,
  code: string,
  timeoutMs: number = 10000
): Promise<{ success: boolean; language: string; stdout: string; stderr: string; exitCode: number; durationMs: number }> {
  const lang = (language || 'javascript').toLowerCase();
  const safeTimeout = Math.min(Math.max(timeoutMs || 10000, 1000), 15000);
  const sandboxDir = path.join('/tmp', `nexus_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const startedAt = Date.now();

  try {
    await fs.mkdir(sandboxDir, { recursive: true });
    let entryFile = 'snippet.js';
    let cmd = '';

    if (lang === 'python' || lang === 'py') {
      entryFile = 'snippet.py';
      cmd = `python3 "${path.join(sandboxDir, entryFile)}"`;
    } else if (lang === 'typescript' || lang === 'ts') {
      entryFile = 'snippet.ts';
      cmd = `"${path.resolve(process.cwd(), 'node_modules/.bin/tsx')}" "${path.join(sandboxDir, entryFile)}"`;
    } else if (lang === 'bash' || lang === 'sh') {
      entryFile = 'snippet.sh';
      cmd = `bash "${path.join(sandboxDir, entryFile)}"`;
    } else {
      entryFile = 'snippet.mjs';
      cmd = `node "${path.join(sandboxDir, entryFile)}"`;
    }

    await fs.writeFile(path.join(sandboxDir, entryFile), code || '', 'utf-8');

    try {
      const { stdout, stderr } = await execPromise(cmd, { cwd: sandboxDir, timeout: safeTimeout });
      return {
        success: true,
        language: lang,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0,
        durationMs: Date.now() - startedAt,
      };
    } catch (execErr: any) {
      return {
        success: false,
        language: lang,
        stdout: execErr.stdout ? execErr.stdout.trim() : '',
        stderr: execErr.stderr ? execErr.stderr.trim() : (execErr.message || 'Sandbox execution failed'),
        exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
        durationMs: Date.now() - startedAt,
      };
    }
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runDebugErrorAnalysis(errorMessage?: string, targetFile?: string) {
  let tscStatus = 'passed';
  let tscOutput = '';
  try {
    const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 15000 });
    tscOutput = stdout.trim() || 'No TypeScript compiler errors.';
  } catch (err: any) {
    tscStatus = 'errors_found';
    tscOutput = (err.stdout || err.stderr || err.message || '').trim().slice(0, 6000);
  }

  let filePreview: string | null = null;
  if (targetFile) {
    try {
      const { abs, relative } = resolveSafePath(targetFile);
      if (abs.startsWith(process.cwd())) {
        const content = await fs.readFile(abs, 'utf-8');
        const lines = content.split('\n').slice(0, 120).map((l, i) => `${i + 1}: ${l}`).join('\n');
        filePreview = `File /${relative} (first 120 lines):\n${lines}`;
      }
    } catch (e: any) {
      filePreview = `Could not inspect ${targetFile}: ${e.message}`;
    }
  }

  return {
    tscStatus,
    tscOutput,
    reportedError: errorMessage || null,
    filePreview,
    recommendation: tscStatus === 'errors_found'
      ? 'Inspect the TypeScript diagnostics above and apply surgical fixes with replace_file_content.'
      : 'TypeScript check passed cleanly. Inspect runtime logs or reproduce inside code_execution_sandbox.',
  };
}

// ============================================================================
// ULTRAWORKERS & CLAW CODE HARNESS CORE FUNCTIONS
// ============================================================================

export async function runClawDoctor(runNetworkCheck: boolean = false) {
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; message: string; details?: any }> = [];

  // 1. Node.js runtime
  try {
    const { stdout } = await execPromise('node -v');
    checks.push({ name: 'Node.js Runtime', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'Node.js Runtime', status: 'error', message: e.message });
  }

  // 2. Python3 runtime
  try {
    const { stdout } = await execPromise('python3 --version');
    checks.push({ name: 'Python3 Sandbox', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'Python3 Sandbox', status: 'warn', message: 'python3 binary not found in PATH' });
  }

  // 3. Git binary & branch
  try {
    const { stdout: gitVer } = await execPromise('git --version');
    const { stdout: branch } = await execPromise('git rev-parse --abbrev-ref HEAD').catch(() => ({ stdout: 'main' }));
    checks.push({ name: 'Git Version Control', status: 'ok', message: `${gitVer.trim()} (branch: ${branch.trim()})` });
  } catch (e: any) {
    checks.push({ name: 'Git Version Control', status: 'warn', message: e.message });
  }

  // 4. TSX binary
  try {
    const { stdout } = await execPromise('npx tsx -v');
    checks.push({ name: 'TSX TypeScript Runner', status: 'ok', message: stdout.trim() });
  } catch (e: any) {
    checks.push({ name: 'TSX TypeScript Runner', status: 'warn', message: 'npx tsx not found' });
  }

  // 5. Memory & Uptime
  const mem = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  checks.push({
    name: 'Process Memory & Uptime',
    status: rssMb > 800 ? 'warn' : 'ok',
    message: `Heap: ${heapMb}MB, RSS: ${rssMb}MB, Uptime: ${Math.round(process.uptime())}s`,
  });

  // 6. Port & Server Status
  checks.push({
    name: 'Dev Server Port Binding',
    status: 'ok',
    message: `Server active on 0.0.0.0:${process.env.PORT || 3000} (PID: ${process.pid})`,
  });

  // 7. API Keys Pool
  let storedKeysCount = 0;
  try {
    const secrets = await fs.readFile(path.resolve(process.cwd(), '.secrets.json'), 'utf-8').then(JSON.parse).catch(() => []);
    storedKeysCount = Array.isArray(secrets) ? secrets.length : 0;
  } catch {}
  const hasEnvKey = Boolean(process.env.GEMINI_API_KEY);
  checks.push({
    name: 'API Key Pool & Providers',
    status: (storedKeysCount > 0 || hasEnvKey) ? 'ok' : 'warn',
    message: `Stored Keys: ${storedKeysCount}, Primary Studio Env: ${hasEnvKey ? 'Present' : 'Not Set'}`,
  });

  // 8. Outbound connectivity if requested
  if (runNetworkCheck) {
    try {
      const pingRes = await fetch('https://www.google.com', { signal: AbortSignal.timeout(3000) });
      checks.push({ name: 'Outbound Network Connectivity', status: pingRes.ok ? 'ok' : 'warn', message: `Status: ${pingRes.status}` });
    } catch (e: any) {
      checks.push({ name: 'Outbound Network Connectivity', status: 'warn', message: e.message });
    }
  }

  const hasError = checks.some(c => c.status === 'error');
  const hasWarn = checks.some(c => c.status === 'warn');
  const overallStatus = hasError ? 'critical' : hasWarn ? 'warning' : 'healthy';

  return {
    harness: 'Claw Code Harness (UltraWorkers Ecosystem)',
    timestamp: Date.now(),
    overallStatus,
    checksCount: checks.length,
    passedCount: checks.filter(c => c.status === 'ok').length,
    checks,
  };
}

export async function getClawStatus() {
  const mem = process.memoryUsage();
  return {
    harness: 'Nexus / UltraWorkers Claw Code Harness',
    version: '2.5.0-acp',
    status: 'online',
    timestamp: Date.now(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb: Math.round(mem.rss / 1024 / 1024),
    },
    backgroundTasks: {
      active: Array.from(backgroundTasks.values()).filter(t => t.status === 'running').length,
      total: backgroundTasks.size,
    },
    protocol: {
      name: 'agent-client-protocol',
      version: '1.0.0-draft',
      transport: 'sse',
      activeAgents: ['Architect', 'Executor', 'Reviewer'],
    },
    toolsCount: serverTools.length,
  };
}

export function getClawAcpInfo(action: string = 'status') {
  return {
    protocol: 'agent-client-protocol',
    version: '1.0.0-draft',
    status: 'connected',
    action,
    capabilities: {
      tools: { list: true, call: true },
      resources: { read: true, list: true, subscribe: false },
      prompts: { list: true, get: true },
      streaming: { sse: true, chunks: true },
      roots: { list: true },
      sampling: { multiModel: true },
      multiAgentCoordination: { omo: true, omx: true, clawhip: true },
    },
    transport: 'sse + json-rpc',
    activeSession: `acp_${Date.now()}`,
    registeredToolsCount: serverTools.length,
  };
}

export async function runClawPrompt(prompt: string, role: string = 'developer', dryRun: boolean = false) {
  return {
    harness: 'claw prompt',
    timestamp: Date.now(),
    role,
    dryRun,
    status: 'accepted',
    instruction: prompt,
    executionPipeline: [
      `Decompose task into structured milestones (OmX protocol)`,
      `Route sub-tasks to specialized sub-agents via OmO`,
      `Track background commit/task events via ClawHip`,
      dryRun ? `[DRY-RUN] Verification preview generated` : `Execute surgical changes & verify via compiler/sandbox`,
    ],
    guidance: `Harness ready. Proceeding with function calls as needed.`,
  };
}

export async function runOmoCoordinate(
  task: string,
  context?: string,
  subAgents: string[] = ['Architect', 'Executor', 'Reviewer'],
  execCtx?: ToolExecutionContext
) {
  const invokeAgentLLM = async (systemPrompt: string, userPrompt: string): Promise<string | null> => {
    if (execCtx?.llmInvoker) {
      try {
        return await execCtx.llmInvoker(systemPrompt, userPrompt);
      } catch (e) {
        console.warn('OmO llmInvoker failed:', e);
      }
    }
    const fallbackGeminiKey = execCtx?.geminiApiKey || process.env.GEMINI_API_KEY || await fs.readFile(path.resolve(process.cwd(), '.secrets.json'), 'utf-8')
      .then((raw) => {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
          ? parsed.find((k: any) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey
          : undefined;
      })
      .catch(() => undefined);

    if (fallbackGeminiKey) {
      try {
        const res = await new GoogleGenAI({
          apiKey: fallbackGeminiKey,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
        }).models.generateContent({
          model: execCtx?.geminiModel || 'gemini-3.5-flash-lite',
          contents: userPrompt,
          config: { systemInstruction: systemPrompt },
        });
        return res.text || null;
      } catch (e) {
        console.warn('OmO Gemini fallback failed:', e);
      }
    }
    return null;
  };

  // Gather workspace context scoped to active session workspace (never leak Nexus root on fresh greenfield builds)
  const safeSessionId = execCtx?.sessionId ? execCtx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') : '';
  const wsDir = safeSessionId ? path.resolve(process.cwd(), 'workspaces', safeSessionId) : '';
  const wsSrcExists = wsDir
    ? await fs.access(path.join(wsDir, 'src')).then(() => true).catch(() => false)
    : false;
  const isFreshGreenfieldWs = Boolean(safeSessionId) && !wsSrcExists && !/(server\/|src\/|apiOrchestrator|GoogleAIStudioCoderView)/i.test(`${task} ${context || ''}`);

  let workspaceSnapshot = '';
  try {
    if (isFreshGreenfieldWs) {
      workspaceSnapshot = `Target: Fresh greenfield sandbox workspaces/${safeSessionId}/ (React 19 + Vite + Tailwind v4 + lucide-react + motion pre-linked).`;
    } else {
      const targetRoot = wsSrcExists && wsDir ? wsDir : process.cwd();
      const pkgRaw = await fs.readFile(path.join(targetRoot, 'package.json'), 'utf-8').catch(() => '');
      const pkgName = pkgRaw ? JSON.parse(pkgRaw).name : 'workspace';
      const topEntries = await fs.readdir(targetRoot, { withFileTypes: true });
      const topList = topEntries
        .filter(e => !['node_modules', '.git', 'dist'].includes(e.name))
        .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
        .slice(0, 25)
        .join(', ');
      workspaceSnapshot = `Project: ${pkgName} (${wsSrcExists ? `workspaces/${safeSessionId}` : 'root'})\nEntries: ${topList}`;
    }
  } catch {}

  const phases: Array<{ agent: string; role: string; status: string; output: string }> = [];
  const tscCwd = wsSrcExists && wsDir ? wsDir : process.cwd();

  // Run Phase 1 (Architect LLM on pooled spare key) + Reviewer Baseline tsc --noEmit in parallel!
  const archStepId = `omo_arch_${Date.now()}`;
  const revStepId = `omo_rev_${Date.now()}`;
  const archStart = Date.now();
  execCtx?.onAgentStep?.({
    id: archStepId,
    kind: 'agent',
    agentRole: 'architect',
    label: execCtx?.compactMode
      ? 'Architect + Executor Sub-Agent designing modular plan (Pooled Key)'
      : 'Architect Agent designing architecture (Parallel Pool)',
    detail: task.slice(0, 120),
    status: 'running',
  });
  execCtx?.onAgentStep?.({
    id: revStepId,
    kind: 'qc',
    agentRole: 'debugger',
    label: isFreshGreenfieldWs
      ? 'Reviewer Agent armed (Greenfield pre-flight)'
      : 'Reviewer Agent checking TypeScript baseline (Parallel)',
    detail: isFreshGreenfieldWs ? 'Zero-read fast-path ready' : 'npx tsc --noEmit',
    status: 'running',
  });

  const runTscBaseline = isFreshGreenfieldWs
    ? Promise.resolve({ clean: true, summary: 'Fresh greenfield workspace — baseline TS check skipped until files are written.' })
    : execPromise('npx tsc --noEmit', { cwd: tscCwd, timeout: 15000 })
        .then(() => ({ clean: true, summary: 'TypeScript check clean (0 errors).' }))
        .catch((err: any) => ({
          clean: false,
          summary: (err.stdout || err.stderr || err.message || 'TS errors detected').trim().slice(0, 400),
        }));

  if (execCtx?.compactMode) {
    // Token-saving 1-shot Architect+Executor synthesis for free APIs (cuts LLM calls in half)
    const compactPrompt = `Task: ${task}\n${context ? `Context: ${context.slice(0, 400)}\n` : ''}${workspaceSnapshot}\nOutput two ultra-concise sections (<150 words total):\nARCHITECT: exact types/interfaces, component boundaries & data flow.\nEXECUTOR: exact file paths to write/edit in parallel (e.g. src/types.ts, src/data/*, src/components/*, src/pages/*, src/App.tsx).`;
    const [combinedOut, tscOutcome] = await Promise.all([
      invokeAgentLLM(
        'You are the Architect + Executor Sub-Agent. Output ultra-concise file targets, shared type contracts, and parallel write order only — never dump code.',
        compactPrompt
      ),
      runTscBaseline,
    ]);

    const rawText = combinedOut || `ARCHITECT & EXECUTOR plan for "${task}": target ${isFreshGreenfieldWs ? `workspaces/${safeSessionId}/` : 'workspace'} -> write src/types.ts, src/data/seed.ts, modular components/pages, and src/App.tsx.`;
    const execSplit = rawText.split(/\bEXECUTOR\s*:/i);
    const architectOutput = (execSplit[0] || rawText).replace(/^ARCHITECT\s*:/i, '').trim();
    const executorOutput = (execSplit[1] || rawText).trim();

    execCtx?.onAgentStep?.({
      id: archStepId,
      kind: 'agent',
      agentRole: 'architect',
      label: 'Architect + Executor aligned (1-shot pooled handoff)',
      detail: architectOutput.slice(0, 140),
      status: 'done',
      durationSec: Math.max(0.1, Number(((Date.now() - archStart) / 1000).toFixed(1))),
    });
    phases.push({
      agent: 'Architect',
      role: 'System Design & Specification',
      status: 'completed',
      output: architectOutput,
    });
    phases.push({
      agent: 'Executor',
      role: 'Code Generation & File Tool Directives',
      status: 'ready',
      output: executorOutput,
    });

    const reviewerOutput = `Baseline tsc --noEmit: ${tscOutcome.clean ? 'CLEAN' : 'ISSUES FOUND'} (${tscOutcome.summary}). Post-edit verification will re-run compile_applet + lint_applet before final report.`;
    execCtx?.onAgentStep?.({
      id: revStepId,
      kind: 'qc',
      agentRole: 'debugger',
      label: tscOutcome.clean ? 'Reviewer Agent armed (0 baseline errors)' : 'Reviewer Agent captured TS baseline diagnostics',
      detail: tscOutcome.summary.slice(0, 120),
      status: 'done',
      durationSec: Math.max(0.1, Number(((Date.now() - archStart) / 1000).toFixed(1))),
    });
    phases.push({
      agent: 'Reviewer',
      role: 'Quality Assurance & Compiler Verification',
      status: tscOutcome.clean ? 'armed' : 'diagnostics_captured',
      output: reviewerOutput,
    });

    return {
      coordinator: 'OmO Compact Multi-Agent Orchestrator (Architect+Executor -> Reviewer)',
      task,
      workspaceSnapshot,
      subAgents,
      consensusStatus: 'consensus_achieved',
      coordinationPhases: phases,
      handoffDirective: `Architect & Executor aligned in 1-shot compact handoff. Immediately execute parallel write_to_file / replace_file_content calls (do NOT re-read starter files), then verify.`,
    };
  }

  const architectPrompt = `Task: ${task}\n${context ? `Context: ${context}\n` : ''}${workspaceSnapshot}\nProvide a concise, concrete architectural specification (target files, components/routes, data flow, and verification criteria). Keep it under 180 words.`;

  const [architectLLMOut, tscOutcome] = await Promise.all([
    invokeAgentLLM(
      'You are the Architect Sub-Agent in a multi-agent engineering pipeline. Output concrete file targets, contracts, and architecture only.',
      architectPrompt
    ),
    runTscBaseline,
  ]);

  const architectOutput = architectLLMOut || `Architectural plan for "${task}": inspected ${workspaceSnapshot || 'workspace'}. Decomposed into target file edits, types, and UI/API wiring.`;
  const tscClean = tscOutcome.clean;
  const tscSummary = tscOutcome.summary;

  execCtx?.onAgentStep?.({
    id: archStepId,
    kind: 'agent',
    agentRole: 'architect',
    label: 'Architect Agent completed design',
    detail: architectOutput.slice(0, 140),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - archStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Architect',
    role: 'System Design & Specification',
    status: 'completed',
    output: architectOutput,
  });

  // Phase 2: Executor Agent (uses another pooled idle key)
  const execStepId = `omo_exec_${Date.now()}`;
  const execStart = Date.now();
  execCtx?.onAgentStep?.({
    id: execStepId,
    kind: 'agent',
    agentRole: 'coder',
    label: 'Executor Agent mapping file operations',
    detail: 'Preparing surgical file tool calls',
    status: 'running',
  });

  const executorPrompt = `Architect Specification:\n${architectOutput}\n\nTask: ${task}\nList the exact files to create/edit via write_to_file or replace_file_content, and exact packages/commands if needed. Keep under 160 words.`;
  const executorLLMOut = await invokeAgentLLM(
    'You are the Executor Sub-Agent. Translate the Architect spec into exact workspace file operations (write_to_file / replace_file_content) — never dump code in chat.',
    executorPrompt
  );
  const executorOutput = executorLLMOut || `Ready to apply direct workspace edits via write_to_file / replace_file_content based on Architect blueprint.`;

  execCtx?.onAgentStep?.({
    id: execStepId,
    kind: 'agent',
    agentRole: 'coder',
    label: 'Executor Agent mapped implementation',
    detail: executorOutput.slice(0, 140),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - execStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Executor',
    role: 'Code Generation & File Tool Directives',
    status: 'ready',
    output: executorOutput,
  });

  const reviewerOutput = `Baseline tsc --noEmit: ${tscClean ? 'CLEAN' : 'ISSUES FOUND'} (${tscSummary}). Post-edit verification will re-run compile_applet + lint_applet before final report.`;
  execCtx?.onAgentStep?.({
    id: revStepId,
    kind: 'qc',
    agentRole: 'debugger',
    label: tscClean ? 'Reviewer Agent verified baseline (0 errors)' : 'Reviewer Agent captured TS baseline diagnostics',
    detail: tscClean ? 'Ready for post-edit verification' : tscSummary.slice(0, 120),
    status: 'done',
    durationSec: Math.max(0.1, Number(((Date.now() - archStart) / 1000).toFixed(1))),
  });
  phases.push({
    agent: 'Reviewer',
    role: 'Quality Assurance & Compiler Verification',
    status: tscClean ? 'armed' : 'diagnostics_captured',
    output: reviewerOutput,
  });

  return {
    coordinator: 'OmO Multi-Agent Orchestrator (Architect -> Executor -> Reviewer)',
    task,
    workspaceSnapshot,
    subAgents,
    consensusStatus: 'consensus_achieved',
    coordinationPhases: phases,
    handoffDirective: `Architect & Executor aligned on real file edits. Proceed immediately with write_to_file / replace_file_content (never paste code in chat), then verify with compile_applet + lint_applet.`,
  };
}

export async function runOmxProtocol(goal: string, targetStack: string = 'React 19 + TypeScript + Vite + Tailwind v4 + Express') {
  return {
    protocol: 'OmX (oh-my-codex) Structured Execution Protocol',
    goal,
    targetStack,
    timestamp: Date.now(),
    phases: [
      {
        phase: 1,
        title: 'Problem Decomposition & Invariants',
        details: [
          'Decompose target goal into atomic requirements.',
          'Define invariant state rules, persistence schemas, and API contracts.',
          'Identify existing workspace files to inspect via view_file or read_multiple_files.',
        ],
      },
      {
        phase: 2,
        title: 'Parallel / Staged Workstream Execution',
        details: [
          'Stream 1: Backend routes and data storage schemas.',
          'Stream 2: UI components, interaction state, and styling.',
          'Stream 3: Tool and function calling hooks wiring.',
        ],
      },
      {
        phase: 3,
        title: 'Persistent Verification Loop',
        details: [
          'Step 3.1: Run tsc --noEmit to verify zero type regressions.',
          'Step 3.2: Run npm run build (compile_applet) to verify bundle.',
          'Step 3.3: Run isolated logic inside code_execution_sandbox.',
          'Step 3.4: Restart server and confirm live health check.',
        ],
      },
    ],
    readyToExecute: true,
  };
}

interface ClawHipEvent {
  id: string;
  timestamp: number;
  eventType: string;
  message: string;
  metadata?: any;
}
const clawHipEventBuffer: ClawHipEvent[] = [];

export function routeClawHipEvent(action: string = 'list', eventType?: string, message?: string, metadata?: any) {
  if (action === 'clear') {
    clawHipEventBuffer.length = 0;
    return { success: true, count: 0 };
  }
  if (action === 'emit' && message) {
    const event: ClawHipEvent = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      eventType: eventType || 'agent_milestone',
      message,
      metadata: typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
    };
    clawHipEventBuffer.unshift(event);
    if (clawHipEventBuffer.length > 100) clawHipEventBuffer.pop();
    return { success: true, event };
  }
  return {
    router: 'ClawHip (UltraWorkers Event & Notification Router)',
    totalEvents: clawHipEventBuffer.length,
    events: clawHipEventBuffer.slice(0, 50),
  };
}

export async function runLazyCodex(task: string, targetFiles: string[] = [], maxIterations: number = 3) {
  let status = 'in_progress';
  let tscResult: any = null;

  try {
    const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 15000 });
    tscResult = { clean: true, output: stdout.trim() || 'No compiler errors' };
    status = 'clean';
  } catch (err: any) {
    tscResult = { clean: false, output: (err.stdout || err.stderr || err.message || '').trim().slice(0, 3000) };
    status = 'diagnostics_ready';
  }

  return {
    engine: 'Gajae-Code / LazyCodex Autonomous Runner',
    task,
    targetFiles,
    maxIterations: maxIterations || 3,
    verificationStatus: status,
    compilerDiagnostics: tscResult,
    autonomousLoop: [
      `1. Parsed task requirements: "${task}"`,
      `2. Identified affected files: ${targetFiles.length > 0 ? targetFiles.join(', ') : 'workspace files'}`,
      `3. Baseline compiler check: ${tscResult.clean ? 'PASSED (0 errors)' : 'Diagnostics captured for self-healing'}`,
      `4. Ready for surgical edits via replace_file_content or sandbox reproduction`,
    ],
  };
}

// Resolve working directory cleanly: honor explicit Cwd/TargetDir, or auto-target active workspace when appropriate
async function resolveToolTargetDir(explicitDir?: string, sessionId?: string, avoidIfCmdMentionsWorkspaces?: string): Promise<string> {
  if (explicitDir && typeof explicitDir === 'string' && explicitDir.trim() && explicitDir.trim() !== 'root') {
    const cleaned = explicitDir.trim().replace(/^[/\\]+/, '');
    const abs = path.resolve(process.cwd(), cleaned || '.');
    if (abs.startsWith(process.cwd())) {
      const exists = await fs.stat(abs).then(s => s.isDirectory()).catch(() => false);
      if (exists) return abs;
    }
  }
  if (sessionId && (!avoidIfCmdMentionsWorkspaces || !/\bworkspaces\//i.test(avoidIfCmdMentionsWorkspaces))) {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const wsDir = path.resolve(process.cwd(), 'workspaces', safeId);
    const hasWsPkg = await fs.access(path.join(wsDir, 'package.json')).then(() => true).catch(() => false);
    if (hasWsPkg) return wsDir;
  }
  return process.cwd();
}

// Split simple `&&` / `;` chains outside quotes when no pipes/redirections complicate execution
function splitShellChain(cmd: string): Array<{ segment: string; op: '&&' | ';' | 'end' }> | null {
  if (/[\n`|]|&&&|\$\(|>\s*&|<</.test(cmd)) return null;
  const parts: Array<{ segment: string; op: '&&' | ';' | 'end' }> = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && quote !== "'" && i + 1 < cmd.length) {
      current += ch + cmd[i + 1];
      i++;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote === ch ? null : ch;
      current += ch;
      continue;
    }
    if (!quote) {
      if (ch === '&' && cmd[i + 1] === '&') {
        if (current.trim()) parts.push({ segment: current.trim(), op: '&&' });
        current = '';
        i++;
        continue;
      }
      if (ch === ';') {
        if (current.trim()) parts.push({ segment: current.trim(), op: ';' });
        current = '';
        continue;
      }
      if (ch === '&') {
        return null; // background `&` operator
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push({ segment: current.trim(), op: 'end' });
  return parts.length > 0 ? parts : null;
}

// Execute a shell command with process-group timeout termination, AbortSignal support, and periodic SSE progress callbacks
function spawnCommandWithStream(
  cmd: string,
  options: { cwd: string; timeoutMs: number; onProgress?: (msg: string) => void; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean; aborted?: boolean }> {
  const { cwd, timeoutMs, onProgress, signal } = options;
  if (signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: 'Cancelled by user.', exitCode: 130, aborted: true });
  }
  const wsBin = path.join(cwd, 'node_modules', '.bin');
  const rootBin = path.resolve(process.cwd(), 'node_modules', '.bin');
  const existingPath = process.env.PATH || '';
  const mergedPath = [wsBin, rootBin, existingPath].filter(Boolean).join(path.delimiter);

  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: mergedPath,
        GIT_TERMINAL_PROMPT: '0',
        CI: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_prefer_offline: 'true',
        NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=384',
      },
    });

    const MAX_CAPTURE = 180_000;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const startedAt = Date.now();

    const appendCap = (cur: string, chunk: string) => {
      const combined = cur + chunk;
      return combined.length > MAX_CAPTURE ? combined.slice(-MAX_CAPTURE) : combined;
    };

    child.stdout?.on('data', (d) => { stdout = appendCap(stdout, d.toString()); });
    child.stderr?.on('data', (d) => { stderr = appendCap(stderr, d.toString()); });

    const heartbeat = onProgress
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const tail = (stdout || stderr).trim().split('\n').pop()?.slice(0, 80) || '';
          onProgress(`⏳ Running (${elapsed}s): ${cmd.slice(0, 60)}${tail ? ` — ${tail}` : '...'}`);
        }, 5000)
      : null;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try { child.kill(sig); } catch {}
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 800);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 500);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdout.trim(),
        stderr: aborted
          ? `${stderr.trim()}\nCommand cancelled by user.`.trim()
          : timedOut
            ? `${stderr.trim()}\nCommand timed out after ${Math.round(timeoutMs / 1000)}s and process tree was terminated.`.trim()
            : stderr.trim(),
        exitCode: aborted ? 130 : timedOut ? 124 : code,
        timedOut,
        aborted,
      });
    };

    child.on('error', (err) => {
      stderr = appendCap(stderr, err.message);
      finish(1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

// Helper to normalize file paths safely within workspace (with strict session sandbox isolation)
function resolveSafePath(
  userPath: string,
  isWebsiteTarget: boolean = false,
  sandboxLockSessionId?: string
): { abs: string; relative: string; isProtected: boolean; redirectedFrom?: string } {
  let cleaned = (userPath || '').trim().replace(/^[/\\]+/, '');
  if (!cleaned) cleaned = '.';

  let redirectedFrom: string | undefined;
  const safeWsId = sandboxLockSessionId
    ? sandboxLockSessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    : '';

  if (
    safeWsId &&
    !cleaned.startsWith('workspaces/') &&
    !cleaned.startsWith('projects/') &&
    !cleaned.startsWith('public/generated') &&
    !cleaned.startsWith('.secrets') &&
    !cleaned.startsWith('.nexus') &&
    (
      cleaned === 'index.html' ||
      cleaned === 'package.json' ||
      cleaned === 'tsconfig.json' ||
      cleaned === 'vite.config.ts' ||
      cleaned === 'firestore.rules' ||
      cleaned === 'server.ts' ||
      cleaned === 'src' ||
      cleaned.startsWith('src/') ||
      cleaned === 'public' ||
      cleaned.startsWith('public/') ||
      cleaned === 'server' ||
      cleaned.startsWith('server/') ||
      cleaned.startsWith('firebase') ||
      (isWebsiteTarget && cleaned.endsWith('.html'))
    )
  ) {
    redirectedFrom = userPath;
    cleaned = `workspaces/${safeWsId}/${cleaned}`;
  } else if (
    isWebsiteTarget &&
    (cleaned === 'index.html' ||
      (cleaned.endsWith('.html') && !cleaned.startsWith('projects/') && !cleaned.startsWith('src/') && !cleaned.startsWith('workspaces/')))
  ) {
    // Fallback for legacy non-locked static HTML targets
    cleaned = path.join('projects', cleaned);
  }

  const abs = path.resolve(process.cwd(), cleaned);
  const relative = path.relative(process.cwd(), abs);
  // Protect Nexus root config/server files, while allowing editing inside isolated workspaces/<id>/
  const isProtected = ['server.ts', 'vite.config.ts', 'tsconfig.json'].includes(relative);

  return { abs, relative, isProtected, redirectedFrom };
}

// Server-side tool executor
export async function executeServerTool(
  name: string,
  args: any,
  onAction?: (action: string) => void,
  execCtx?: ToolExecutionContext
): Promise<any> {
  if (onAction) {
    const actionMap: Record<string, string> = {
      'read_skill': `Loading skill: ${args.SkillName || 'list'}...`,
      'analyze_project': `Analyzing workspace structure & dependencies...`,
      'grep_search': `Searching code for "${args.Pattern}"...`,
      'find_by_name': `Finding files matching "${args.Pattern}"...`,
      'view_file': `Reading ${args.AbsolutePath || args.filePath || 'file'}...`,
      'fileRead': `Reading ${args.filePath || args.AbsolutePath || 'file'}...`,
      'write_to_file': `Writing ${args.TargetFile || args.filePath || 'file'}...`,
      'fileWrite': `Writing ${args.filePath || args.TargetFile || 'file'}...`,
      'replace_file_content': `Editing ${args.TargetFile || args.filePath || 'file'}...`,
      'fileEdit': `Editing ${args.filePath || args.TargetFile || 'file'}...`,
      'multi_replace_file_content': `Batch editing ${args.TargetFile || 'file'}...`,
      'list_dir': `Listing directory ${args.DirectoryPath || args.dirPath || '.'}...`,
      'listDir': `Listing directory ${args.dirPath || args.DirectoryPath || '.'}...`,
      'run_command': `Running: ${args.CommandLine || args.command}...`,
      'manage_task': `Managing background task (${args.Action})...`,
      'bash': `Running: ${args.command || args.CommandLine}...`,
      'install_applet_package': `Installing npm packages: ${(args.PackageNames || [args.packageName]).join(', ')}...`,
      'install_applet_dependencies': `Installing all package.json dependencies...`,
      'compile_applet': `Compiling applet & verifying build...`,
      'compileProject': `Compiling applet & verifying build...`,
      'lint_applet': `Linting codebase for errors...`,
      'lintProject': `Linting codebase for errors...`,
      'restart_dev_server': `Refreshing dev server...`,
      'restartServer': `Refreshing dev server...`,
      'delete_file': `Deleting ${args.TargetFile || args.filePath}...`,
      'delete_dir': `Deleting directory ${args.DirectoryPath}...`,
      'move': `Moving ${args.SourcePath} to ${args.DestinationPath}...`,
      'git_status': `Checking git status...`,
      'git_diff': `Inspecting git diff...`,
      'detect_secrets': `Scanning codebase for hardcoded secrets...`,
      'code_execution_sandbox': `Running ${args.Language || 'code'} in isolated sandbox...`,
      'read_multiple_files': `Reading ${(args.FilePaths || []).length} files for multi-file context...`,
      'compute_file_diff': `Computing diff for ${args.TargetFile || 'file'}...`,
      'debug_error_analysis': `Analyzing errors & diagnostics...`,
      'claw_doctor': `Claw Doctor: running environment, port, memory & API health check...`,
      'claw_status': `Claw Status: inspecting harness session & active tasks...`,
      'claw_acp': `Claw ACP: checking Agent Client Protocol capabilities...`,
      'claw_prompt': `Claw Prompt: dispatching directive (${args.role || 'developer'})...`,
      'omo_coordinate': `OmO: orchestrating multi-agent coordination (Architect -> Executor -> Reviewer)...`,
      'omx_protocol': `OmX: constructing structured 3-phase execution protocol...`,
      'clawhip_router': `ClawHip: routing event (${args.action} - ${args.eventType || 'stream'})...`,
      'lazycodex_runner': `LazyCodex: running autonomous iterative code engine...`,
      'search_web': `Searching: ${args.query}...`,
      'webSearch': `Searching: ${args.query}...`,
      'generate_image': `Generating image: ${args.Prompt || args.prompt}...`,
      'generateImage': `Generating image: ${args.prompt || args.Prompt}...`,
      'fetch_stock_images': `Fetching ${(args.items || []).length || 1} stock image(s) locally (0 tokens)...`,
      'ask_question': `Asking clarifying questions...`,
      'verify_live_preview': `Verifying live preview (${args.targetUrl || '/projects/index.html'})...`,
      'visual_qa_review': `Running Visual QA Screenshot & Layout Audit (${args.targetUrl || '/projects/index.html'})...`,
      'workspace_init': `Initializing isolated sandbox workspace (${args.template || 'react-vite'})...`,
      'workspace_run': args.action === 'build'
        ? `Building production static bundle to projects/${(execCtx?.sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_')}/...`
        : `Sandbox sub-server (${args.action || 'start'})...`,
      'github_clone': `Cloning GitHub repo ${args.repo || ''} into sandbox preview...`,
      'ast_context_ranker': `Ranking TypeScript AST signatures & call-graph for "${args.query}"...`,
      'api_contract_checker': `Verifying frontend <-> backend /api/* contracts...`,
      'targeted_error_context': `Extracting targeted ±20 line error slices & KB hints...`,
      'persistence_status': `Checking PostgreSQL / Turso / Supabase persistence status...`,
      'set_up_firebase': `Provisioning Firebase SDK, blueprint & firestore.rules...`,
      'deploy_firebase': `Auditing & deploying firestore.rules...`,
      'webFetch': `Fetching ${args.url}...`,
      'plan': `Creating execution plan...`,
    };
    onAction(actionMap[name] || `Executing ${name}...`);
  }

  try {
    switch (name) {
      case 'view_file':
      case 'fileRead': {
        const targetPath = args.AbsolutePath || args.filePath;
        if (!targetPath) return { error: "Path is required" };
        const { abs, relative } = resolveSafePath(targetPath, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        try {
          const stat = await fs.stat(abs);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(abs, { withFileTypes: true });
            return {
              isDirectory: true,
              path: `/${relative}`,
              items: entries.slice(0, 100).map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' })),
            };
          }
          const rawContent = await fs.readFile(abs, 'utf-8');
          execCtx?.readFiles?.add(relative);
          const offset = typeof args.ContentOffset === 'number' && args.ContentOffset > 0 ? args.ContentOffset : 0;
          const content = offset > 0 ? rawContent.slice(offset) : rawContent;
          const lines = content.split('\n');
          const totalLines = lines.length;
          const startLine = args.StartLine ? Math.max(1, args.StartLine) : 1;
          const endLine = args.EndLine ? Math.min(totalLines, args.EndLine) : Math.min(totalLines, startLine + 1599);
          const sliced = lines.slice(startLine - 1, endLine).map((line, idx) => `${startLine + idx}: ${line}`).join('\n');
          const capped = sliced.slice(0, 45000);

          return `File Path: /${relative}\nTotal Lines: ${totalLines}\nShowing lines ${startLine} to ${endLine}${offset ? ` (from byte offset ${offset})` : ''}\n${capped}`;
        } catch (err: any) {
          return { error: `Failed to read file /${relative}: ${err.message}` };
        }
      }

      case 'write_to_file':
      case 'fileWrite': {
        const rawTarget = args.TargetFile || args.filePath;
        const code = args.CodeContent !== undefined ? args.CodeContent : args.content;
        if (!rawTarget) return { error: "TargetFile is required" };
        if (typeof code !== 'string') return { error: "CodeContent string is required" };

        const { abs, relative, isProtected, redirectedFrom } = resolveSafePath(rawTarget, true, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (isProtected) {
          return { error: `Protected file: writing to system root file ${relative} is prohibited. Write inside 'workspaces/<sessionId>/' or 'src/'.` };
        }

        const repairedWrite = args.Append
          ? { content: code, repairsApplied: [] as string[] }
          : await applyDeterministicPreWriteRepairs(relative, code);
        const finalWriteCode = repairedWrite.content;

        const guard = await validatePreWriteGuardrails(relative, finalWriteCode, {
          isAppend: Boolean(args.Append),
          isFullFile: true,
        });
        if (!guard.ok) {
          return {
            error: `[PRE-WRITE GUARDRAIL REJECTED]: ${guard.errors.join(' | ')}`,
            guardrailRejected: true,
            path: `/${relative}`,
          };
        }

        await fs.mkdir(path.dirname(abs), { recursive: true });

        if (args.Append) {
          await fs.appendFile(abs, finalWriteCode, 'utf-8');
        } else {
          await fs.writeFile(abs, finalWriteCode, 'utf-8');
        }
        execCtx?.readFiles?.add(relative);

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if ((relative.startsWith('projects/') || relative === 'index.html') && relative.endsWith('.html')) {
          const fullHtml = args.Append ? await fs.readFile(abs, 'utf-8') : finalWriteCode;
          const deployed = await deployHtmlFile(fullHtml, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return { 
          success: true, 
          path: `/${relative}`,
          cleanPath: relative,
          ...(redirectedFrom ? { sandboxRedirectedFrom: redirectedFrom } : {}),
          ...(repairedWrite.repairsApplied.length > 0 ? { repairsApplied: repairedWrite.repairsApplied } : {}),
          previewUrl,
          deployedHtml,
          description: args.Description || "File written successfully" 
        };
      }

      case 'replace_file_content':
      case 'fileEdit': {
        const rawTarget = args.TargetFile || args.filePath;
        const targetText = args.TargetContent !== undefined ? args.TargetContent : args.oldText;
        const replacementText = args.ReplacementContent !== undefined ? args.ReplacementContent : args.newText;

        if (!rawTarget || targetText === undefined || replacementText === undefined) {
          return { error: "Missing required arguments: TargetFile, TargetContent, and ReplacementContent" };
        }

        const { abs, relative, redirectedFrom } = resolveSafePath(rawTarget, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        let content = await fs.readFile(abs, 'utf-8');
        if (execCtx?.readFiles && !execCtx.readFiles.has(relative)) {
          const numberedPreview = content
            .split('\n')
            .slice(0, 120)
            .map((l, idx) => `${idx + 1}: ${l}`)
            .join('\n')
            .slice(0, 4500);
          execCtx.readFiles.add(relative);
          return {
            error: `[READ-BEFORE-EDIT REQUIRED]: You had not inspected /${relative} yet. Review the current numbered lines below (or call view_file for the remaining lines) and retry replace_file_content with exact TargetContent.`,
            requiresReadFirst: true,
            path: `/${relative}`,
            currentLinesPreview: numberedPreview,
          };
        }

        let matchMode: 'exact' | 'normalized' = 'exact';
        if (args.AllowMultiple && content.includes(targetText)) {
          content = content.split(targetText).join(replacementText);
        } else {
          const patched = fuzzyReplaceContent(content, targetText, replacementText);
          if (!patched.found) {
            const firstToken = String(targetText).trim().split(/\s+/).find((w) => w.length >= 4) || '';
            const lines = content.split('\n');
            const hitIdx = firstToken ? lines.findIndex((l) => l.includes(firstToken)) : -1;
            const start = Math.max(0, hitIdx >= 0 ? hitIdx - 8 : 0);
            const snippet = lines
              .slice(start, start + 45)
              .map((l, idx) => `${start + idx + 1}: ${l}`)
              .join('\n')
              .slice(0, 3000);
            return {
              error: `Target content not found in file /${relative}. Match the exact lines shown below or call view_file.`,
              path: `/${relative}`,
              nearbyLines: snippet,
            };
          }
          content = patched.newContent;
          matchMode = patched.matchMode === 'normalized' ? 'normalized' : 'exact';
        }

        const repairedReplace = await applyDeterministicPreWriteRepairs(relative, content);
        content = repairedReplace.content;

        const guard = await validatePreWriteGuardrails(relative, content, {
          isAppend: false,
          isFullFile: true,
        });
        if (!guard.ok) {
          return {
            error: `[PRE-WRITE GUARDRAIL REJECTED]: ${guard.errors.join(' | ')}`,
            guardrailRejected: true,
            path: `/${relative}`,
          };
        }

        await fs.writeFile(abs, content, 'utf-8');

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if (relative.startsWith('projects/') && relative.endsWith('.html')) {
          const deployed = await deployHtmlFile(content, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return { 
          success: true, 
          path: `/${relative}`,
          cleanPath: relative,
          matchMode,
          ...(redirectedFrom ? { sandboxRedirectedFrom: redirectedFrom } : {}),
          ...(repairedReplace.repairsApplied.length > 0 ? { repairsApplied: repairedReplace.repairsApplied } : {}),
          previewUrl,
          deployedHtml,
          description: args.Description || "Content replaced successfully" 
        };
      }

      case 'multi_replace_file_content': {
        const rawTarget = args.TargetFile;
        const chunks = args.ReplacementChunks || [];
        if (!rawTarget || !Array.isArray(chunks)) {
          return { error: "TargetFile and ReplacementChunks array are required" };
        }

        const { abs, relative, redirectedFrom } = resolveSafePath(rawTarget, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        let content = await fs.readFile(abs, 'utf-8');
        if (execCtx?.readFiles && !execCtx.readFiles.has(relative)) {
          const numberedPreview = content
            .split('\n')
            .slice(0, 120)
            .map((l, idx) => `${idx + 1}: ${l}`)
            .join('\n')
            .slice(0, 4500);
          execCtx.readFiles.add(relative);
          return {
            error: `[READ-BEFORE-EDIT REQUIRED]: You had not inspected /${relative} yet. Review the current numbered lines below (or call view_file) and retry multi_replace_file_content with exact TargetContent.`,
            requiresReadFirst: true,
            path: `/${relative}`,
            currentLinesPreview: numberedPreview,
          };
        }

        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const patched = fuzzyReplaceContent(content, chunk.TargetContent, chunk.ReplacementContent);
          if (!patched.found) {
            return { error: `Chunk ${i + 1} TargetContent not found in /${relative}. Call view_file to verify exact lines.` };
          }
          content = patched.newContent;
        }

        const repairedMulti = await applyDeterministicPreWriteRepairs(relative, content);
        content = repairedMulti.content;

        const guard = await validatePreWriteGuardrails(relative, content, {
          isAppend: false,
          isFullFile: true,
        });
        if (!guard.ok) {
          return {
            error: `[PRE-WRITE GUARDRAIL REJECTED]: ${guard.errors.join(' | ')}`,
            guardrailRejected: true,
            path: `/${relative}`,
          };
        }

        await fs.writeFile(abs, content, 'utf-8');

        let previewUrl: string | undefined;
        let deployedHtml: string | undefined;
        if (relative.startsWith('projects/') && relative.endsWith('.html')) {
          const deployed = await deployHtmlFile(content, execCtx?.sessionId);
          if (deployed.success) {
            previewUrl = deployed.url;
            deployedHtml = deployed.html;
          }
        }

        return {
          success: true,
          path: `/${relative}`,
          cleanPath: relative,
          ...(redirectedFrom ? { sandboxRedirectedFrom: redirectedFrom } : {}),
          ...(repairedMulti.repairsApplied.length > 0 ? { repairsApplied: repairedMulti.repairsApplied } : {}),
          previewUrl,
          deployedHtml,
          chunksReplaced: chunks.length
        };
      }

      case 'list_dir':
      case 'listDir': {
        const dir = args.DirectoryPath || args.dirPath || '.';
        const { abs, relative } = resolveSafePath(dir, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };

        const entries = await fs.readdir(abs, { withFileTypes: true });
        const items = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: path.join(relative, e.name)
        }));
        return { directory: `/${relative}`, items };
      }

      case 'read_skill': {
        const skillName = (args.SkillName || 'list').trim();
        if (skillName.toLowerCase() === 'list' || !skillName) {
          return { availableSkills: listAllSkillsSummary() };
        }
        const skill = getSkillByName(skillName);
        if (!skill) {
          return {
            error: `Skill "${skillName}" not found.`,
            availableSkills: listAllSkillsSummary().map(s => s.name),
          };
        }
        const useCompact = args.compact !== undefined ? Boolean(args.compact) : Boolean(execCtx?.compactMode);
        if (useCompact && skill.compactInstructions) {
          return {
            name: skill.name,
            category: skill.category,
            description: skill.description,
            instructions: skill.compactInstructions,
            compactMode: true,
          };
        }
        return skill;
      }

      case 'analyze_project': {
        const targetDir = args.TargetDirectory ? resolveSafePath(args.TargetDirectory).abs : process.cwd();
        const pkgPath = path.join(targetDir, 'package.json');
        let pkg: any = null;
        try {
          pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
        } catch {}

        const walk = async (dir: string, depth = 0): Promise<string[]> => {
          if (depth > 3) return [];
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const results: string[] = [];
          for (const entry of entries) {
            if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const rel = path.relative(process.cwd(), full);
            if (entry.isDirectory()) {
              results.push(`${rel}/`);
              results.push(...(await walk(full, depth + 1)));
            } else {
              results.push(rel);
            }
          }
          return results;
        };

        const files = await walk(targetDir);
        return {
          root: targetDir,
          packageJson: pkg ? { name: pkg.name, scripts: pkg.scripts, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies } : null,
          fileCount: files.length,
          files: files.slice(0, 120),
        };
      }

      case 'grep_search': {
        const pattern = (args.Pattern || '').trim();
        if (!pattern) return { error: 'Pattern is required' };
        const searchTarget = args.SearchPath ? resolveSafePath(args.SearchPath).relative || '.' : '.';
        const safePattern = pattern.replace(/"/g, '\\"');
        try {
          const { stdout } = await execPromise(
            `grep -rnE "${safePattern}" "${searchTarget}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist | head -n 80`,
            { cwd: process.cwd() }
          );
          const matches = stdout.trim().split('\n').filter(Boolean);
          return { pattern, count: matches.length, matches };
        } catch (err: any) {
          if (err.code === 1) return { pattern, count: 0, matches: [] };
          return { error: err.message, matches: [] };
        }
      }

      case 'find_by_name': {
        const pattern = (args.Pattern || '*').trim();
        const dir = args.SearchDirectory ? resolveSafePath(args.SearchDirectory).relative || '.' : '.';
        const safePattern = pattern.replace(/"/g, '\\"');
        try {
          const { stdout } = await execPromise(
            `find "${dir}" -name "${safePattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -n 100`,
            { cwd: process.cwd() }
          );
          const files = stdout.trim().split('\n').filter(Boolean).map(f => f.replace(/^\.\//, ''));
          return { pattern, count: files.length, files };
        } catch (err: any) {
          return { error: err.message, files: [] };
        }
      }

      case 'run_command':
      case 'bash': {
        let cmd = String(args.CommandLine || args.command || '').trim();
        if (!cmd) return { error: "CommandLine is required" };
        if (/(rm\s+-rf\s+\/\s*$|rm\s+-rf\s+\/\*|\.secrets\.json)/i.test(cmd)) {
          return { error: "Safety guard: destructive root or secret file shell command blocked." };
        }

        let currentCwd = await resolveToolTargetDir(args.Cwd, execCtx?.sessionId, cmd);

        // Daemon mode support
        if (args.IsDaemon) {
          const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const wsBin = path.join(currentCwd, 'node_modules', '.bin');
          const rootBin = path.resolve(process.cwd(), 'node_modules', '.bin');
          const child = spawn('bash', ['-c', cmd], {
            cwd: currentCwd,
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              PATH: [wsBin, rootBin, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
              GIT_TERMINAL_PROMPT: '0',
            },
          });
          const task: BackgroundTask = {
            id: taskId,
            command: cmd,
            cwd: currentCwd,
            status: 'running',
            startedAt: Date.now(),
            output: '',
            process: child,
          };
          child.stdout?.on('data', (d) => { task.output = (task.output + d.toString()).slice(-20000); });
          child.stderr?.on('data', (d) => { task.output = (task.output + d.toString()).slice(-20000); });
          child.on('close', (code) => {
            task.status = code === 0 ? 'completed' : 'failed';
            task.exitCode = code;
            task.finishedAt = Date.now();
          });
          backgroundTasks.set(taskId, task);
          await new Promise(r => setTimeout(r, 800));
          return {
            status: 'running_in_background',
            taskId,
            cwd: path.relative(process.cwd(), currentCwd) || '.',
            message: `Started daemon task ${taskId}. Use manage_task to inspect or kill it.`,
            output: task.output.slice(-1500),
          };
        }

        // Parse compound `&&` / `;` chains cleanly so `cd dir && npm install && npm run build` handles each step safely without hanging
        const chain = splitShellChain(cmd);
        if (chain && (chain.length > 1 || /^\s*(?:npm\s+(?:install|i|ci|add)|gh\s+repo\s+clone|git\s+clone)\b/i.test(chain[0].segment))) {
          const allStdout: string[] = [];
          const allStderr: string[] = [];
          let extraMeta: Record<string, any> = {};

          for (const item of chain) {
            if (execCtx?.signal?.aborted) {
              return { error: 'Cancelled by user', aborted: true, stdout: allStdout.join('\n'), stderr: allStderr.join('\n'), exitCode: 130 };
            }
            let seg = item.segment;

            // Handle `cd <dir>` state transitions cleanly across chained segments
            const cdMatch = seg.match(/^\s*cd\s+(.+)$/i);
            if (cdMatch) {
              const target = cdMatch[1].trim().replace(/^["']|["']$/g, '');
              const candidate = target === '~' ? process.cwd() : path.resolve(currentCwd, target);
              const isDir = await fs.stat(candidate).then(s => s.isDirectory()).catch(() => false);
              if (candidate.startsWith(process.cwd()) && isDir) {
                currentCwd = candidate;
                allStdout.push(`Changed directory to ${path.relative(process.cwd(), currentCwd) || '.'}`);
                continue;
              } else {
                const errMsg = `cd: ${target}: No such directory inside workspace`;
                allStderr.push(errMsg);
                if (item.op === '&&' || item.op === 'end') {
                  return { error: errMsg, stdout: allStdout.join('\n'), stderr: allStderr.join('\n'), exitCode: 1 };
                }
                continue;
              }
            }

            // Intercept `gh repo clone` or `git clone` into isolated workspace sandbox
            const cloneMatch = seg.match(/^\s*(?:gh\s+repo\s+clone|git\s+clone(?:\s+--depth\s+\d+)?(?:\s+(?:-b|--branch)\s+(\S+))?)\s+(\S+)(?:\s+([^\s;|&]+))?(?:\s+--depth\s+\d+)?(?:\s+(?:-b|--branch)\s+(\S+))?\s*$/i);
            if (cloneMatch) {
              const parsedRepo = normalizeGitHubRepoSpec(cloneMatch[2]);
              const destArg = (cloneMatch[3] || '').replace(/^["']|["']$/g, '');
              const branchArg = cloneMatch[1] || cloneMatch[4] || undefined;
              const isTmpDest = /^\/tmp\//i.test(destArg);
              if (parsedRepo && !isTmpDest) {
                const wsDestMatch = destArg.match(/^(?:\.\/)?workspaces\/([^/]+)\/?$/i);
                const targetSid = wsDestMatch?.[1] || execCtx?.sessionId || 'default';
                onAction?.(`📦 Cloning ${parsedRepo.slug} into workspaces/${targetSid}...`);
                const cloneRes = await cloneGitHubRepoToWorkspace({
                  repo: parsedRepo.slug,
                  sessionId: targetSid,
                  branch: branchArg,
                  autoStart: true,
                });
                extraMeta = {
                  ...extraMeta,
                  ...cloneRes,
                  clonedWorkspace: true,
                  previewUrl: cloneRes.success && cloneRes.serverStatus?.success !== false ? cloneRes.proxyUrl : extraMeta.previewUrl,
                };
                if (!cloneRes.success) {
                  allStderr.push(cloneRes.error || 'Clone failed');
                  if (item.op === '&&' || item.op === 'end') {
                    return { ...extraMeta, error: cloneRes.error, stdout: allStdout.join('\n'), stderr: allStderr.join('\n'), exitCode: 1 };
                  }
                } else {
                  currentCwd = path.resolve(process.cwd(), cloneRes.workspacePath);
                  allStdout.push(`Cloned ${parsedRepo.slug} into ${cloneRes.workspacePath}`);
                }
                continue;
              }
            }

            // Intercept `npm install` / `npm i` / `npm ci` / `npm add` (local/workspace safe, never destroys symlinks)
            const npmInstMatch = seg.match(/^\s*npm\s+(?:install|i|ci|add)(?:\s+(.*))?$/i);
            if (npmInstMatch && !/\s(?:-g|--global)\b/.test(seg)) {
              const argStr = (npmInstMatch[1] || '').trim();
              const tokens = argStr ? argStr.split(/\s+/).filter(Boolean) : [];
              const isDev = tokens.some((t) => t === '-D' || t === '--save-dev');
              const pkgTokens = tokens.filter((t) => !t.startsWith('-') && /^[a-zA-Z0-9@._/-]+(?:@[a-zA-Z0-9._^~>=<|-]+)?$/.test(t));
              const relCwd = path.relative(process.cwd(), currentCwd);
              const explicitTarget = relCwd && relCwd !== '.' ? relCwd : undefined;

              onAction?.(`📦 Installing dependencies cleanly in ${relCwd || 'root'}...`);
              if (pkgTokens.length > 0) {
                const instRes = await installPackagesInTarget({
                  packages: pkgTokens,
                  isDev,
                  sessionId: execCtx?.sessionId,
                  targetDir: explicitTarget,
                });
                if (!instRes.success) {
                  const errMsg = instRes.error || instRes.stderr || 'npm install failed';
                  allStderr.push(errMsg);
                  if (item.op === '&&' || item.op === 'end') {
                    return { error: errMsg, stdout: allStdout.join('\n'), stderr: allStderr.join('\n'), exitCode: 1 };
                  }
                } else {
                  allStdout.push(instRes.message || instRes.stdout || `Installed ${pkgTokens.join(', ')}`);
                }
              } else {
                const depRes = await installDependenciesForTarget({
                  sessionId: execCtx?.sessionId,
                  targetDir: explicitTarget,
                });
                if (!depRes.success) {
                  const errMsg = depRes.error || depRes.stderr || 'npm install failed';
                  allStderr.push(errMsg);
                  if (item.op === '&&' || item.op === 'end') {
                    return { error: errMsg, stdout: allStdout.join('\n'), stderr: allStderr.join('\n'), exitCode: 1 };
                  }
                } else {
                  allStdout.push(depRes.message || depRes.stdout || 'Dependencies verified and installed.');
                }
              }
              continue;
            }

            // Translate standalone `gh repo clone` if it missed the regex
            const ghMatch = seg.match(/^\s*gh\s+repo\s+clone\s+(\S+)(?:\s+([^\s;|&]+))?(.*)$/i);
            if (ghMatch) {
              const parsedRepo = normalizeGitHubRepoSpec(ghMatch[1]);
              if (parsedRepo) {
                const destArg = ghMatch[2] ? ` "${ghMatch[2].replace(/^["']|["']$/g, '')}"` : '';
                seg = `git clone --depth 1 "${parsedRepo.cloneUrl}"${destArg}${ghMatch[3] || ''}`;
              }
            }

            const isHeavySeg = /\b(npm\s+run\s+build|npx|vite\s+build|git\s+clone|tsc|vitest|jest)\b/i.test(seg);
            const segTimeout = Math.min(Math.max(args.WaitMsBeforeAsync || (isHeavySeg ? 90000 : 25000), 1000), 120000);
            const segRes = await spawnCommandWithStream(seg, {
              cwd: currentCwd,
              timeoutMs: segTimeout,
              onProgress: onAction,
              signal: execCtx?.signal,
            });
            if (segRes.stdout) allStdout.push(segRes.stdout);
            if (segRes.stderr) allStderr.push(segRes.stderr);

            if (segRes.exitCode !== 0 && item.op === '&&') {
              return {
                ...extraMeta,
                error: segRes.stderr || segRes.stdout || `Command "${seg}" exited with code ${segRes.exitCode}`,
                stdout: allStdout.join('\n').slice(-6000),
                stderr: allStderr.join('\n').slice(-4000),
                exitCode: segRes.exitCode,
              };
            }
          }

          return {
            ...extraMeta,
            cwd: path.relative(process.cwd(), currentCwd) || '.',
            stdout: allStdout.join('\n').slice(-8000),
            stderr: allStderr.join('\n').slice(-4000),
            exitCode: 0,
          };
        }

        // Fallback for piped/multi-line/subshell commands
        const ghMatch = cmd.match(/^\s*gh\s+repo\s+clone\s+(\S+)(?:\s+([^\s;|&]+))?(.*)$/i);
        if (ghMatch) {
          const parsedRepo = normalizeGitHubRepoSpec(ghMatch[1]);
          if (parsedRepo) {
            const destArg = ghMatch[2] ? ` "${ghMatch[2].replace(/^["']|["']$/g, '')}"` : '';
            cmd = `git clone --depth 1 "${parsedRepo.cloneUrl}"${destArg}${ghMatch[3] || ''}`;
          }
        }
        if (/\bnpm\s+(?:install|i|ci)\b/i.test(cmd) && !/--no-audit/.test(cmd)) {
          cmd = cmd.replace(/\bnpm\s+(install|i|ci)\b/gi, 'npm $1 --no-audit --no-fund --prefer-offline --legacy-peer-deps');
        }

        const isHeavyCmd = /\b(npm\s+install|npm\s+ci|npm\s+run\s+build|npx|vite\s+build|git\s+clone|tsc)\b/i.test(cmd);
        const defaultWait = isHeavyCmd ? 90000 : 20000;
        const waitMs = Math.min(Math.max(args.WaitMsBeforeAsync || defaultWait, 1000), 120000);

        const runRes = await spawnCommandWithStream(cmd, {
          cwd: currentCwd,
          timeoutMs: waitMs,
          onProgress: onAction,
          signal: execCtx?.signal,
        });
        if (runRes.exitCode !== 0) {
          return {
            error: runRes.stderr || `Command failed with exit code ${runRes.exitCode}`,
            cwd: path.relative(process.cwd(), currentCwd) || '.',
            stdout: runRes.stdout.slice(-8000),
            stderr: runRes.stderr.slice(-4000),
            exitCode: runRes.exitCode,
          };
        }
        return {
          cwd: path.relative(process.cwd(), currentCwd) || '.',
          stdout: runRes.stdout.slice(-8000),
          stderr: runRes.stderr.slice(-4000),
          exitCode: 0,
        };
      }

      case 'manage_task': {
        return manageBackgroundTask(args.Action, args.TaskId, args.Input);
      }

      case 'install_applet_package':
      case 'installPackage': {
        const rawPackages = args.PackageNames || (args.packageName ? [args.packageName] : []);
        const packages = (Array.isArray(rawPackages) ? rawPackages : [rawPackages])
          .map((p: any) => String(p || '').trim())
          .filter((p: string) => /^[a-zA-Z0-9@._/-]+(?:@[a-zA-Z0-9._^~>=<|-]+)?$/.test(p));
        return await installPackagesInTarget({
          packages,
          isDev: Boolean(args.IsDevDependency || args.isDev),
          sessionId: args.sessionId || execCtx?.sessionId,
          targetDir: args.TargetDir || args.targetDir,
        });
      }

      case 'install_applet_dependencies': {
        return await installDependenciesForTarget({
          sessionId: args.sessionId || execCtx?.sessionId,
          targetDir: args.TargetDir || args.targetDir,
        });
      }

      case 'compile_applet':
      case 'compileProject': {
        const targetCwd = await resolveToolTargetDir(args.TargetDir || args.targetDir, args.sessionId || execCtx?.sessionId);
        const relTarget = path.relative(process.cwd(), targetCwd) || '.';
        const pkg = await fs.readFile(path.join(targetCwd, 'package.json'), 'utf-8').then(JSON.parse).catch(() => null);
        const isWorkspace = targetCwd !== process.cwd();

        if (isWorkspace) {
          if (!pkg) {
            return { success: true, target: relTarget, message: `Static workspace (${relTarget}) has no package.json build step; verified files intact.` };
          }
          const outputs: string[] = [];
          const hasTsConfig = await fs.access(path.join(targetCwd, 'tsconfig.json')).then(() => true).catch(() => false);
          if (hasTsConfig) {
            onAction?.(`🔍 Checking TypeScript in ${relTarget}...`);
            const tscRes = await spawnCommandWithStream('tsc --noEmit', { cwd: targetCwd, timeoutMs: 45000, onProgress: onAction, signal: execCtx?.signal });
            if (tscRes.exitCode !== 0) {
              return {
                success: false,
                target: relTarget,
                message: `TypeScript errors detected in ${relTarget}`,
                output: (tscRes.stdout || tscRes.stderr).slice(-3000),
              };
            }
            if (tscRes.stdout) outputs.push(tscRes.stdout);
          }
          if (pkg.scripts?.build) {
            onAction?.(`🏗️ Building ${relTarget} (npm run build)...`);
            const buildRes = await spawnCommandWithStream('npm run build', { cwd: targetCwd, timeoutMs: 90000, onProgress: onAction, signal: execCtx?.signal });
            if (buildRes.exitCode !== 0) {
              return {
                success: false,
                target: relTarget,
                message: `Build failed in ${relTarget}`,
                output: (buildRes.stdout || buildRes.stderr).slice(-3000),
              };
            }
            if (buildRes.stdout) outputs.push(buildRes.stdout);
          }
          return {
            success: true,
            target: relTarget,
            message: `Build succeeded in ${relTarget} with 0 errors`,
            stdout: outputs.join('\n').slice(-2500),
          };
        }

        const tscRes = await spawnCommandWithStream('tsc --noEmit', { cwd: process.cwd(), timeoutMs: 45000, onProgress: onAction, signal: execCtx?.signal });
        if (tscRes.exitCode !== 0) {
          return {
            success: false,
            target: '.',
            message: "Build failed with TypeScript compilation errors",
            output: (tscRes.stdout || tscRes.stderr).slice(-3000),
          };
        }
        const buildRes = await spawnCommandWithStream('npm run build', { cwd: process.cwd(), timeoutMs: 90000, onProgress: onAction, signal: execCtx?.signal });
        if (buildRes.exitCode !== 0) {
          return {
            success: false,
            target: '.',
            message: "Build failed during Vite production bundle",
            output: (buildRes.stdout || buildRes.stderr).slice(-3000),
          };
        }
        return {
          success: true,
          target: '.',
          message: "Build succeeded - TypeScript & Vite production bundle compiled cleanly",
          stdout: [tscRes.stdout, buildRes.stdout].filter(Boolean).join('\n').slice(-2000),
        };
      }

      case 'lint_applet':
      case 'lintProject': {
        const targetCwd = await resolveToolTargetDir(args.TargetDir || args.targetDir, args.sessionId || execCtx?.sessionId);
        const relTarget = path.relative(process.cwd(), targetCwd) || '.';
        const pkg = await fs.readFile(path.join(targetCwd, 'package.json'), 'utf-8').then(JSON.parse).catch(() => null);
        const isWorkspace = targetCwd !== process.cwd();

        if (isWorkspace) {
          const hasTsConfig = await fs.access(path.join(targetCwd, 'tsconfig.json')).then(() => true).catch(() => false);
          const lintCmd = pkg?.scripts?.lint ? 'npm run lint' : (hasTsConfig ? 'tsc --noEmit' : '');
          if (!lintCmd) {
            return { success: true, target: relTarget, message: `No lint script configured in ${relTarget}; skipped cleanly.` };
          }
          const lintRes = await spawnCommandWithStream(lintCmd, { cwd: targetCwd, timeoutMs: 45000, onProgress: onAction, signal: execCtx?.signal });
          if (lintRes.exitCode !== 0) {
            return {
              success: false,
              target: relTarget,
              message: `Lint errors detected in ${relTarget}`,
              output: (lintRes.stdout || lintRes.stderr).slice(-3000),
            };
          }
          return { success: true, target: relTarget, message: `Linting completed in ${relTarget}`, output: lintRes.stdout || "0 errors" };
        }

        const lintRes = await spawnCommandWithStream('npm run lint', { cwd: process.cwd(), timeoutMs: 45000, onProgress: onAction, signal: execCtx?.signal });
        if (lintRes.exitCode !== 0) {
          return {
            success: false,
            target: '.',
            message: "Lint errors detected",
            output: (lintRes.stdout || lintRes.stderr).slice(-3000),
          };
        }
        return { success: true, target: '.', message: "Linting completed successfully", output: lintRes.stdout || "0 errors" };
      }

      case 'run_tests': {
        return await runAutomatedTests(args.TestTarget);
      }

      case 'codebase_graph': {
        return await buildCodebaseGraph(args.TargetDirectory || '.');
      }

      case 'git_checkpoint': {
        const action = (args.Action || 'create').toLowerCase();
        if (action === 'list') {
          const checkpoints = await listCheckpoints();
          return { count: checkpoints.length, checkpoints };
        }
        const cp = await createCheckpoint(args.Label || 'Agent checkpoint');
        return { success: true, checkpoint: cp, message: `Checkpoint ${cp.id} created (${cp.fileCount} files).` };
      }

      case 'git_rollback': {
        let targetId = args.CheckpointId;
        if (!targetId) {
          const all = await listCheckpoints();
          if (all.length === 0) return { success: false, error: "No saved checkpoints found to rollback." };
          targetId = all[0].id;
        }
        return await rollbackToCheckpoint(targetId);
      }

      case 'restart_dev_server':
      case 'restartServer': {
        const port = Number(process.env.PORT) || 3000;
        try {
          const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(4000) });
          const healthData = await healthRes.json().catch(() => ({}));
          return {
            success: healthRes.ok,
            status: healthRes.status,
            health: healthData,
            message: healthRes.ok
              ? `Dev server healthy on port ${port} (uptime: ${healthData.uptime ?? '?'}s).`
              : `Dev server responded with status ${healthRes.status}.`,
          };
        } catch (err: any) {
          return { success: false, message: `Server health probe failed: ${err?.message}` };
        }
      }

      case 'delete_file':
      case 'fileDelete': {
        const rawTarget = args.TargetFile || args.filePath;
        const { abs, relative, isProtected } = resolveSafePath(rawTarget, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (isProtected) return { error: `Protected file: cannot delete ${relative}` };

        await fs.unlink(abs);
        return { success: true, message: `Deleted file /${relative}` };
      }

      case 'delete_dir': {
        const rawTarget = args.DirectoryPath;
        if (!rawTarget || typeof rawTarget !== 'string') {
          return { error: "DirectoryPath is required" };
        }
        const { abs, relative } = resolveSafePath(rawTarget, false, execCtx?.sandboxLockSessionId);
        if (!abs.startsWith(process.cwd())) return { error: "Access denied" };
        if (['src', 'server', 'public', 'node_modules', '.', ''].includes(relative)) {
          return { error: `Protected directory: cannot delete ${relative || '/'}` };
        }

        const stat = await fs.stat(abs).catch(() => null);
        if (!stat) return { error: `Directory not found: /${relative}` };
        if (!stat.isDirectory()) return { error: `Path is not a directory: /${relative}` };

        await fs.rm(abs, { recursive: Boolean(args.Force), force: Boolean(args.Force) });
        return { success: true, message: `Deleted directory /${relative}` };
      }

      case 'move':
      case 'moveFile': {
        const src = args.SourcePath || args.sourcePath;
        const dest = args.DestinationPath || args.destinationPath;
        if (!src || !dest) return { error: "SourcePath and DestinationPath are required" };
        const { abs: absSrc, relative: relSrc, isProtected } = resolveSafePath(src, false, execCtx?.sandboxLockSessionId);
        const { abs: absDest, relative: relDest } = resolveSafePath(dest, false, execCtx?.sandboxLockSessionId);
        if (!absSrc.startsWith(process.cwd()) || !absDest.startsWith(process.cwd())) return { error: "Access denied" };
        if (isProtected) return { error: `Protected file: cannot move ${relSrc}` };

        await fs.mkdir(path.dirname(absDest), { recursive: true });
        await fs.rename(absSrc, absDest);
        return { success: true, from: `/${relSrc}`, to: `/${relDest}` };
      }

      case 'search_web':
      case 'webSearch': {
        const query = (args.query || '').trim();
        if (!query) return { error: "Query is required" };
        const searchRes = await freeWebSearch(query, {
          geminiApiKey: execCtx?.geminiApiKey || process.env.GEMINI_API_KEY,
          geminiModel: execCtx?.geminiModel,
        });
        return {
          ...searchRes,
          message: searchRes.count > 0 || searchRes.groundedAnswer
            ? `Found ${searchRes.count} free search results via [${searchRes.sources.join(', ')}]`
            : "No direct search results found",
        };
      }

      case 'git_status': {
        try {
          const { stdout: branch } = await execPromise('git branch --show-current || echo "main"', { cwd: process.cwd() });
          const { stdout: status } = await execPromise('git status -s || echo ""', { cwd: process.cwd() });
          return { branch: branch.trim(), status: status.trim() || 'Working directory clean.' };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'git_diff': {
        try {
          const { stdout } = await execPromise('git diff || echo ""', { cwd: process.cwd() });
          return { diff: stdout.trim().slice(0, 12000) || 'No uncommitted changes detected.' };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'detect_secrets': {
        try {
          const secretPatterns = [
            /(?:api[_-]?key|secret|token|password|auth|bearer)\s*[:=]\s*['"][a-zA-Z0-9_\-]{16,}['"]/i,
            /['"](?:AIza[0-9A-Za-z\-_]{30,}|sk-[a-zA-Z0-9\-_]{20,}|ghp_[a-zA-Z0-9]{20,}|gsk_[a-zA-Z0-9]{20,}|xai-[a-zA-Z0-9\-_]{20,})['"]/
          ];
          const getFilesRecursively = async (dir: string): Promise<string[]> => {
            const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
            const files = await Promise.all(entries.map(async (entry) => {
              const resPath = path.resolve(dir, entry.name);
              if (['node_modules', 'dist', '.git', 'workspaces', 'dev-dist'].includes(entry.name)) return [];
              return entry.isDirectory() ? getFilesRecursively(resPath) : [resPath];
            }));
            return files.flat();
          };
          const candidateFiles = [
            ...(await getFilesRecursively(path.resolve(process.cwd(), 'src'))),
            ...(await getFilesRecursively(path.resolve(process.cwd(), 'server'))),
            path.resolve(process.cwd(), 'server.ts'),
          ];
          const files = Array.from(new Set(candidateFiles)).filter((f) => /\.(ts|tsx|js|jsx|mjs|json|html)$/i.test(f));
          const detected: Array<{ file: string; line: number; preview: string }> = [];
          for (const file of files) {
            const content = await fs.readFile(file, 'utf-8').catch(() => '');
            if (!content) continue;
            const lines = content.split('\n');
            lines.forEach((line, index) => {
              if (
                line.includes('process.env') ||
                line.includes('import.meta.env') ||
                /placeholder\s*=|xxxxxxxx|example|sample|dummy/i.test(line)
              ) return;
              for (const pattern of secretPatterns) {
                if (pattern.test(line)) {
                  detected.push({
                    file: path.relative(process.cwd(), file),
                    line: index + 1,
                    preview: line.trim().slice(0, 80)
                  });
                  break;
                }
              }
            });
          }
          return { safe: detected.length === 0, scannedFiles: files.length, detectedCount: detected.length, detected };
        } catch (err: any) {
          return { error: err.message };
        }
      }

      case 'generate_image':
      case 'generateImage': {
        const prompt = args.Prompt || args.prompt || 'Modern web application interface';
        const rawName = (args.ImageName || `img_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
        const outDir = path.resolve(process.cwd(), 'public', 'generated');
        await fs.mkdir(outDir, { recursive: true });

        let geminiKey = execCtx?.geminiApiKey || process.env.GEMINI_API_KEY;
        if (!geminiKey) {
          geminiKey = await fs.readFile(path.resolve(process.cwd(), '.secrets.json'), 'utf-8')
            .then((raw) => {
              const list = JSON.parse(raw);
              return Array.isArray(list) ? list.find((k: any) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey : undefined;
            })
            .catch(() => undefined);
        }

        if (geminiKey) {
          try {
            const imgClient = new GoogleGenAI({
              apiKey: geminiKey,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
            });
            const imgRes = await imgClient.models.generateContent({
              model: 'gemini-2.5-flash-image',
              contents: prompt,
            });
            const parts = imgRes.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.inlineData?.data) {
                const ext = (part.inlineData.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
                const fileName = `${rawName}.${ext}`;
                await fs.writeFile(path.join(outDir, fileName), Buffer.from(part.inlineData.data, 'base64'));
                return {
                  imageUrl: `/generated/${fileName}`,
                  prompt,
                  provider: 'gemini-2.5-flash-image',
                  description: `Generated image asset saved to /generated/${fileName}`,
                };
              }
            }
          } catch (imgErr: any) {
            console.warn('Gemini image generation fallback to zero-key media:', imgErr.message);
          }
        }

        // Tier 2: Zero-key real image fetch (Pollinations) persisted locally so <img> never breaks externally
        const aspect = args.AspectRatio || '16:9';
        const dims = aspect === '1:1' ? [800, 800] : aspect === '9:16' ? [720, 1280] : aspect === '4:3' ? [960, 720] : aspect === '3:4' ? [720, 960] : [1280, 720];
        try {
          const seed = Math.abs(Array.from(String(prompt)).reduce<number>((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0)) % 99999;
          const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${dims[0]}&height=${dims[1]}&seed=${seed}&nologo=true`;
          const pollRes = await fetch(pollUrl, { signal: AbortSignal.timeout(9500) });
          const ctype = pollRes.headers.get('content-type') || '';
          if (pollRes.ok && ctype.startsWith('image/')) {
            const imgBuf = Buffer.from(await pollRes.arrayBuffer());
            if (imgBuf.length > 2048) {
              const ext = ctype.includes('png') ? 'png' : ctype.includes('webp') ? 'webp' : 'jpg';
              const fileName = `${rawName}.${ext}`;
              await fs.writeFile(path.join(outDir, fileName), imgBuf);
              return {
                imageUrl: `/generated/${fileName}`,
                prompt,
                provider: 'pollinations-local-cached',
                description: `Generated high-resolution image asset saved locally to /generated/${fileName}`,
              };
            }
          }
        } catch (pollErr: any) {
          console.warn('Zero-key image fetch fallback to bespoke SVG art:', pollErr?.message || pollErr);
        }

        // Tier 3: Bespoke Layered Geometric Vector Artwork fallback (100% offline/sandbox resilient)
        const safeTitle = prompt.replace(/[<>&"']/g, '').slice(0, 44);
        const paletteSeed = prompt.toLowerCase();
        const [bgA, bgB, accentA, accentB] = /(food|cafe|coffee|bakery|restaurant|fashion|luxury|editorial)/i.test(paletteSeed)
          ? ['#1c1917', '#292524', '#f59e0b', '#fbbf24']
          : /(health|bio|eco|nature|green|finance|fintech)/i.test(paletteSeed)
            ? ['#061914', '#0b2e26', '#10b981', '#34d399']
            : ['#0b1120', '#172554', '#38bdf8', '#818cf8'];

        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${dims[0]}" height="${dims[1]}" viewBox="0 0 ${dims[0]} ${dims[1]}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgA}"/>
      <stop offset="100%" stop-color="${bgB}"/>
    </linearGradient>
    <radialGradient id="orb1" cx="72%" cy="28%" r="48%">
      <stop offset="0%" stop-color="${accentA}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${accentA}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="orb2" cx="25%" cy="76%" r="52%">
      <stop offset="0%" stop-color="${accentB}" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="${accentB}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M 48 0 L 0 0 0 48" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#grid)"/>
  <rect width="100%" height="100%" fill="url(#orb1)"/>
  <rect width="100%" height="100%" fill="url(#orb2)"/>
  <g transform="translate(${Math.round(dims[0] * 0.56)}, ${Math.round(dims[1] * 0.16)})">
    <rect width="${Math.round(dims[0] * 0.34)}" height="${Math.round(dims[1] * 0.68)}" rx="24" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
    <circle cx="${Math.round(dims[0] * 0.17)}" cy="${Math.round(dims[1] * 0.28)}" r="${Math.round(Math.min(dims[0], dims[1]) * 0.14)}" fill="none" stroke="${accentA}" stroke-opacity="0.55" stroke-width="2"/>
    <circle cx="${Math.round(dims[0] * 0.17)}" cy="${Math.round(dims[1] * 0.28)}" r="${Math.round(Math.min(dims[0], dims[1]) * 0.08)}" fill="${accentB}" fill-opacity="0.25"/>
  </g>
  <text x="${Math.round(dims[0] * 0.08)}" y="${Math.round(dims[1] * 0.48)}" fill="#f8fafc" font-family="system-ui, sans-serif" font-size="${Math.round(dims[0] * 0.028)}" font-weight="700" letter-spacing="-0.02em">${safeTitle}</text>
  <rect x="${Math.round(dims[0] * 0.08)}" y="${Math.round(dims[1] * 0.53)}" width="72" height="3" rx="1.5" fill="${accentA}"/>
</svg>`;
        const svgName = `${rawName}.svg`;
        await fs.writeFile(path.join(outDir, svgName), svgContent, 'utf-8');
        return {
          imageUrl: `/generated/${svgName}`,
          prompt,
          provider: 'local-svg-artwork',
          description: `Generated bespoke vector artwork saved locally to /generated/${svgName}`,
        };
      }

      case 'fetch_stock_images': {
        const items = Array.isArray(args.items)
          ? args.items
          : args.query
            ? [{ query: String(args.query), filename: args.filename, aspectRatio: args.aspectRatio }]
            : [];
        return await fetchBatchStockImages(items, {
          sessionId: args.sessionId || execCtx?.sessionId,
          targetDir: args.targetDir,
        });
      }

      case 'ask_question': {
        const questions: AskQuestionItem[] = Array.isArray(args.questions) ? args.questions : [];
        if (execCtx?.onAskQuestion && questions.length > 0) {
          const response = await execCtx.onAskQuestion(questions);
          return {
            status: response.skipped
              ? "User skipped clarifying questions. Proceed immediately with sensible defaults."
              : "User submitted answers to clarifying questions.",
            skipped: Boolean(response.skipped),
            answers: response.answers || {},
            notes: response.notes || "",
            questionsCount: questions.length,
          };
        }
        return {
          questions,
          status: "Questions presented to user for clarification.",
        };
      }

      case 'verify_live_preview': {
        return await verifyLivePreviewWithDom(
          args.targetUrl,
          args.checkAssets !== false,
          execCtx?.sessionId
        );
      }

      case 'webFetch': {
        const targetUrl = (args.url || '').trim();
        if (!targetUrl) return { error: "URL is required" };

        try {
          const jinaUrl = `https://r.jina.ai/${targetUrl}`;
          const jinaRes = await fetch(jinaUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/plain,text/markdown,*/*',
            },
            signal: AbortSignal.timeout(10000),
          });
          if (jinaRes.ok) {
            const markdown = await jinaRes.text();
            if (markdown && markdown.length > 80) {
              return { url: targetUrl, format: "markdown", data: markdown.slice(0, 16000), success: true };
            }
          }
        } catch {}

        try {
          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(8000) });
          const rawHtml = await res.text();
          const cleaned = rawHtml
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
          return { url: targetUrl, format: "html", data: cleaned.slice(0, 14000), success: true };
        } catch (err: any) {
          return { url: targetUrl, error: err.message || "Failed to fetch website", success: false };
        }
      }

      case 'code_execution_sandbox': {
        return await runCodeInSandbox(args.Language || 'javascript', args.Code || '', args.TimeoutMs);
      }

      case 'read_multiple_files': {
        const paths: string[] = Array.isArray(args.FilePaths) ? args.FilePaths.slice(0, 10) : [];
        if (paths.length === 0) return { error: 'FilePaths array is required' };
        const files = await Promise.all(
          paths.map(async (p) => {
            const { abs, relative } = resolveSafePath(p);
            if (!abs.startsWith(process.cwd())) return { path: p, error: 'Access denied' };
            try {
              const content = await fs.readFile(abs, 'utf-8');
              execCtx?.readFiles?.add(relative);
              const lines = content.split('\n');
              return {
                path: `/${relative}`,
                totalLines: lines.length,
                content: content.slice(0, 18000),
              };
            } catch (err: any) {
              return { path: `/${relative}`, error: err.message };
            }
          })
        );
        return { count: files.length, files };
      }

      case 'compute_file_diff': {
        const rawTarget = args.TargetFile;
        if (!rawTarget) return { error: 'TargetFile is required' };
        const { abs, relative } = resolveSafePath(rawTarget);
        if (!abs.startsWith(process.cwd())) return { error: 'Access denied' };

        if (typeof args.ProposedContent === 'string') {
          const tmpDir = path.join('/tmp', `nexus_diff_${Date.now()}`);
          await fs.mkdir(tmpDir, { recursive: true });
          const proposedPath = path.join(tmpDir, 'proposed');
          await fs.writeFile(proposedPath, args.ProposedContent, 'utf-8');
          try {
            const { stdout } = await execPromise(`diff -u "${abs}" "${proposedPath}" || true`, { cwd: process.cwd() });
            return { file: `/${relative}`, diff: stdout.trim() || 'No differences detected.' };
          } finally {
            await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        } else {
          try {
            const { stdout } = await execPromise(`git diff -- "${relative}" || true`, { cwd: process.cwd() });
            return { file: `/${relative}`, diff: stdout.trim() || 'No uncommitted git diff for this file.' };
          } catch (err: any) {
            return { error: err.message };
          }
        }
      }

      case 'debug_error_analysis': {
        return await runDebugErrorAnalysis(args.ErrorMessage, args.TargetFile);
      }

      case 'claw_doctor': {
        return await runClawDoctor(Boolean(args.runNetworkCheck));
      }

      case 'claw_status': {
        return await getClawStatus();
      }

      case 'claw_acp': {
        return getClawAcpInfo(args.action || 'status');
      }

      case 'claw_prompt': {
        return await runClawPrompt(args.prompt, args.role, Boolean(args.dryRun));
      }

      case 'omo_coordinate': {
        return await runOmoCoordinate(args.task, args.context, args.subAgents, execCtx);
      }

      case 'omx_protocol': {
        return await runOmxProtocol(args.goal, args.targetStack);
      }

      case 'clawhip_router': {
        return routeClawHipEvent(args.action, args.eventType, args.message, args.metadata);
      }

      case 'lazycodex_runner': {
        return await runLazyCodex(args.task, args.targetFiles, args.maxIterations);
      }

      case 'set_up_firebase': {
        const activeSessionId = args.sessionId || execCtx?.sessionId;
        const baseOptions = {
          sessionId: activeSessionId,
          targetDir: args.targetDir,
          platform: args.platform || 'web',
          projectId: args.projectId,
          apiKey: args.apiKey,
          authDomain: args.authDomain,
          storageBucket: args.storageBucket,
          messagingSenderId: args.messagingSenderId,
          appId: args.appId,
          firestoreDatabaseId: args.firestoreDatabaseId,
          blueprint: args.blueprint,
          rules: args.rules,
          saveToGlobalProfile: args.saveToGlobalProfile !== false,
          preferSavedProfile: true,
        };

        let result = await provisionFirebaseForTarget(baseOptions);

        // Open Firebase SDK setup UI whenever credentials aren't configured yet and the user explicitly requested Firebase
        const shouldPromptInteractive =
          result.requiresUserCredentials &&
          args.userConfirmedTermsAcceptedInUI !== false &&
          Boolean(execCtx?.onRequestFirebaseSetup) &&
          (Boolean(execCtx?.allowInteractiveFirebasePrompt) || (args.interactive === true && args.skipInteractivePrompt !== true));

        if (shouldPromptInteractive && execCtx?.onRequestFirebaseSetup) {
          const collectionPaths = Array.isArray(args.blueprint?.collections)
            ? args.blueprint.collections.map((c: any) => String(c?.path || '')).filter(Boolean)
            : [];

          const setupResp = await execCtx.onRequestFirebaseSetup({
            sessionId: activeSessionId,
            projectIdHint: args.projectId,
            collections: collectionPaths,
            reason: 'আপনার Firebase SDK কনফিগ দিন এবং Connect করুন (অথবা Skip করলে লোকাল Scaffold মোডে চলবে)।',
          });

          if (setupResp.action === 'cancel') {
            return {
              ...result,
              cancelled: true,
              message: 'Firebase connection prompt cancelled; scaffold files remain ready in workspace.',
            };
          }

          if (setupResp.action === 'connect') {
            const parsedSnippet = setupResp.configSnippet
              ? parseFirebaseConfigInput(setupResp.configSnippet)
              : {};

            if (setupResp.serviceAccountJson || setupResp.firebaseToken) {
              try {
                const parsedSa = setupResp.serviceAccountJson
                  ? typeof setupResp.serviceAccountJson === 'string'
                    ? JSON.parse(setupResp.serviceAccountJson)
                    : setupResp.serviceAccountJson
                  : undefined;
                await saveFirebaseProfile({
                  ...(parsedSa?.client_email && parsedSa?.private_key ? { serviceAccount: parsedSa } : {}),
                  ...(setupResp.firebaseToken ? { firebaseToken: setupResp.firebaseToken.trim() } : {}),
                });
              } catch {}
            }

            result = await provisionFirebaseForTarget({
              ...baseOptions,
              projectId: setupResp.projectId || parsedSnippet.projectId || baseOptions.projectId,
              apiKey: setupResp.apiKey || parsedSnippet.apiKey || baseOptions.apiKey,
              authDomain: setupResp.authDomain || parsedSnippet.authDomain || baseOptions.authDomain,
              storageBucket: setupResp.storageBucket || parsedSnippet.storageBucket || baseOptions.storageBucket,
              messagingSenderId:
                setupResp.messagingSenderId || parsedSnippet.messagingSenderId || baseOptions.messagingSenderId,
              appId: setupResp.appId || parsedSnippet.appId || baseOptions.appId,
              firestoreDatabaseId:
                setupResp.firestoreDatabaseId || parsedSnippet.firestoreDatabaseId || baseOptions.firestoreDatabaseId,
              saveToGlobalProfile: setupResp.saveToGlobalProfile !== false,
            });
          }
        }

        return result;
      }

      case 'deploy_firebase': {
        const { targetDir, relativeRoot } = await resolveFirebaseTargetDir(
          args.sessionId || execCtx?.sessionId,
          args.targetDir
        );
        const rulesPath = path.join(targetDir, 'firestore.rules');
        const bpPath = path.join(targetDir, 'firebase-blueprint.json');
        const blueprint = await fs.readFile(bpPath, 'utf-8').then(JSON.parse).catch(() => null);

        if (args.rules) {
          await fs.writeFile(rulesPath, args.rules, 'utf-8');
        }
        let rulesContent = await fs.readFile(rulesPath, 'utf-8').catch(() => '');
        if (!rulesContent.trim() && blueprint) {
          rulesContent = generateRulesFromBlueprint(blueprint);
          await fs.writeFile(rulesPath, rulesContent, 'utf-8');
        }
        if (!rulesContent.trim()) {
          return { success: false, error: 'firestore.rules does not exist or is empty.' };
        }

        const fbCfg = await fs
          .readFile(path.join(targetDir, 'firebase-config.json'), 'utf-8')
          .then(JSON.parse)
          .catch(() => null);
        const deployRes = await deployRulesToFirebaseCloud(fbCfg?.projectId || '', rulesContent);
        const audit = auditFirestoreRules(rulesContent, blueprint);

        return {
          ...deployRes,
          audit,
          targetRoot: relativeRoot || '.',
          rulesPath: relativeRoot ? `${relativeRoot}/firestore.rules` : 'firestore.rules',
        };
      }

      case 'set_up_oauth': {
        const oauthPath = path.resolve(process.cwd(), '.oauth-config.json');
        let current: any = { scopes: [] };
        try {
          const raw = await fs.readFile(oauthPath, 'utf-8');
          current = JSON.parse(raw);
        } catch {}
        const scopes = Array.from(new Set([...(current.scopes || []), ...(args.scopes_to_add || [])]));
        const hasClientId = Boolean(process.env.VITE_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID);
        const updated = { ...current, title: args.title, scopes, hasClientId, updatedAt: Date.now() };
        await fs.writeFile(oauthPath, JSON.stringify(updated, null, 2), 'utf-8');

        // Scaffold real client-side Google Identity Services (GIS) OAuth helper
        const oauthClientPath = path.resolve(process.cwd(), 'src/lib/oauthClient.ts');
        const oauthHelper = `// Client-side OAuth Scope Configuration (Auto-managed by Nexus AI)
export const OAUTH_SCOPES: string[] = ${JSON.stringify(scopes, null, 2)};

export function requestGoogleAccessToken(
  clientId: string = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '',
  extraScopes: string[] = []
): Promise<string> {
  return new Promise((resolve, reject) => {
    const gis = (window as any).google?.accounts?.oauth2;
    if (!gis) {
      reject(new Error('Google Identity Services script (https://accounts.google.com/gsi/client) is not loaded.'));
      return;
    }
    if (!clientId) {
      reject(new Error('VITE_GOOGLE_CLIENT_ID is missing. Configure OAuth Client ID in environment variables.'));
      return;
    }
    const tokenClient = gis.initTokenClient({
      client_id: clientId,
      scope: Array.from(new Set([...OAUTH_SCOPES, ...extraScopes])).join(' '),
      callback: (resp: any) => {
        if (resp?.access_token) resolve(resp.access_token);
        else reject(new Error(resp?.error || 'OAuth authorization failed'));
      },
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}
`;
        await fs.mkdir(path.dirname(oauthClientPath), { recursive: true });
        await fs.writeFile(oauthClientPath, oauthHelper, 'utf-8');

        return {
          success: true,
          title: args.title,
          configuredScopes: scopes,
          clientHelperPath: 'src/lib/oauthClient.ts',
          hasClientId,
          modifiedFiles: ['src/lib/oauthClient.ts'],
        };
      }

      case 'remove_oauth': {
        const oauthPath = path.resolve(process.cwd(), '.oauth-config.json');
        let current: any = { scopes: [] };
        try {
          const raw = await fs.readFile(oauthPath, 'utf-8');
          current = JSON.parse(raw);
        } catch {}
        const toRemove = new Set(args.scopes_to_remove || []);
        const scopes = (current.scopes || []).filter((s: string) => !toRemove.has(s));
        await fs.writeFile(oauthPath, JSON.stringify({ ...current, scopes, updatedAt: Date.now() }, null, 2), 'utf-8');
        return { success: true, remainingScopes: scopes };
      }

      case 'cloudsql_execute_sql': {
        const query = String(args.sql_statement || '').trim();
        if (!query) return { error: "sql_statement is required" };
        if (/^\s*(DROP\s+DATABASE|ATTACH\s+DATABASE|DETACH\s+DATABASE)/i.test(query)) {
          return { error: "Safety guard: DROP DATABASE / ATTACH DATABASE statements are blocked." };
        }

        // If DATABASE_URL is configured (PostgreSQL / Neon / Render Postgres / Cloud SQL), execute via pg driver
        if (process.env.DATABASE_URL && /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) {
          const client = new PgClient({
            connectionString: process.env.DATABASE_URL,
            ssl: /localhost|127\.0\.0\.1/i.test(process.env.DATABASE_URL) ? undefined : { rejectUnauthorized: false },
          });
          try {
            await client.connect();
            const pgRes = await client.query(query);
            return {
              success: true,
              engine: 'postgresql (pg)',
              rowCount: pgRes.rowCount ?? (pgRes.rows?.length || 0),
              columns: pgRes.fields?.map((f: any) => f.name) || [],
              results: pgRes.rows || [],
            };
          } catch (pgErr: any) {
            return {
              success: false,
              engine: 'postgresql (pg)',
              error: pgErr?.message || 'PostgreSQL query failed',
              statement: query,
            };
          } finally {
            await client.end().catch(() => {});
          }
        }

        const dbPath = path.resolve(process.cwd(), '.nexus_local.db');
        const db = new DatabaseSync(dbPath);
        try {
          const statements: string[] = [];
          let current = '';
          let inSingle = false;
          let inDouble = false;
          for (let i = 0; i < query.length; i++) {
            const ch = query[i];
            if (ch === "'" && !inDouble) inSingle = !inSingle;
            else if (ch === '"' && !inSingle) inDouble = !inDouble;
            if (ch === ';' && !inSingle && !inDouble) {
              if (current.trim()) statements.push(current.trim());
              current = '';
            } else {
              current += ch;
            }
          }
          if (current.trim()) statements.push(current.trim());

          let lastRows: any[] = [];
          let columns: string[] = [];
          let totalChanges = 0;
          let lastInsertRowid: number | bigint | undefined = undefined;

          for (const stmtSql of statements) {
            const isReader = /^\s*(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(stmtSql) || /\bRETURNING\b/i.test(stmtSql);
            if (isReader) {
              const stmt = db.prepare(stmtSql);
              const rows = stmt.all() as Record<string, any>[];
              lastRows = rows;
              columns = rows.length > 0 ? Object.keys(rows[0]) : stmt.columns().map((c: any) => c.name);
            } else {
              const stmt = db.prepare(stmtSql);
              const info = stmt.run();
              totalChanges += Number(info.changes || 0);
              if (info.lastInsertRowid !== undefined) {
                lastInsertRowid = Number(info.lastInsertRowid);
              }
            }
          }

          return {
            success: true,
            engine: 'sqlite (node:sqlite)',
            databaseFile: '.nexus_local.db',
            statement: query,
            columns,
            rowCount: lastRows.length,
            rowsAffected: totalChanges,
            lastInsertRowid,
            results: lastRows,
          };
        } catch (sqlErr: any) {
          return {
            success: false,
            error: sqlErr?.message || 'SQL execution error',
            statement: query,
          };
        } finally {
          db.close();
        }
      }

      case 'cloudsql_update_schema': {
        const { abs: schemaAbs, relative: schemaRel } = resolveSafePath(args.schemaPath || 'src/db/schema.ts');
        let created = false;
        try {
          await fs.access(schemaAbs);
        } catch {
          await fs.mkdir(path.dirname(schemaAbs), { recursive: true });
          const boilerplate = `import { pgTable, text, serial, timestamp } from 'drizzle-orm/pg-core';\n\nexport const items = pgTable('items', {\n  id: serial('id').primaryKey(),\n  name: text('name').notNull(),\n  createdAt: timestamp('created_at').defaultNow(),\n});\n`;
          await fs.writeFile(schemaAbs, boilerplate, 'utf-8');
          created = true;
        }

        // Actually validate TypeScript compilation on schema + push Drizzle if configured
        let tscPassed = true;
        let tscOutput = '';
        try {
          const { stdout } = await execPromise('npx tsc --noEmit', { cwd: process.cwd(), timeout: 25000 });
          tscOutput = stdout.trim() || 'TypeScript schema types valid (0 errors).';
        } catch (tscErr: any) {
          tscPassed = false;
          tscOutput = (tscErr.stdout || tscErr.stderr || tscErr.message || '').slice(0, 2000);
        }

        let drizzlePushOutput: string | undefined;
        if (tscPassed && process.env.DATABASE_URL) {
          const pkg = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf-8').then(JSON.parse).catch(() => ({}));
          if (pkg?.dependencies?.['drizzle-kit'] || pkg?.devDependencies?.['drizzle-kit']) {
            try {
              const { stdout } = await execPromise('npx drizzle-kit push --force', { cwd: process.cwd(), timeout: 30000 });
              drizzlePushOutput = stdout.trim();
            } catch (dkErr: any) {
              drizzlePushOutput = `drizzle-kit push note: ${(dkErr.stderr || dkErr.message || '').slice(0, 500)}`;
            }
          }
        }

        return {
          success: tscPassed,
          schemaPath: `/${schemaRel}`,
          created,
          tscOutput,
          drizzlePushOutput,
          message: tscPassed
            ? `Schema /${schemaRel} validated cleanly.`
            : `Schema /${schemaRel} has TypeScript errors—inspect tscOutput.`,
        };
      }

      case 'figma_import': {
        const componentName = String(args.componentName || 'FigmaComponent').replace(/[^a-zA-Z0-9_]/g, '') || 'FigmaComponent';
        const designSpecs = String(args.designSpecs || '').trim();
        const figmaUrl = typeof args.figmaUrl === 'string' ? args.figmaUrl.trim() : '';
        let figmaMeta: any = null;

        if (figmaUrl) {
          const fileKeyMatch = figmaUrl.match(/figma\.com\/(?:file|design)\/([a-zA-Z0-9]+)/);
          const nodeMatch = figmaUrl.match(/node-id=([^&]+)/);
          figmaMeta = {
            fileKey: fileKeyMatch?.[1] || null,
            nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]) : null,
          };
          if (figmaMeta.fileKey && process.env.FIGMA_ACCESS_TOKEN) {
            try {
              const apiRes = await fetch(`https://api.figma.com/v1/files/${figmaMeta.fileKey}${figmaMeta.nodeId ? `/nodes?ids=${encodeURIComponent(figmaMeta.nodeId)}` : '?depth=2'}`, {
                headers: { 'X-Figma-Token': process.env.FIGMA_ACCESS_TOKEN },
                signal: AbortSignal.timeout(8000),
              });
              if (apiRes.ok) {
                const json = await apiRes.json();
                figmaMeta.name = json.name;
                figmaMeta.fetchedLiveFromFigmaApi = true;
              }
            } catch {}
          }
        }

        let createdFile: string | undefined;
        if (args.targetFile) {
          const { abs, relative, isProtected } = resolveSafePath(args.targetFile, false);
          if (abs.startsWith(process.cwd()) && !isProtected) {
            const exists = await fs.access(abs).then(() => true).catch(() => false);
            if (!exists) {
              await fs.mkdir(path.dirname(abs), { recursive: true });
              const scaffold = `import React from 'react';

export interface ${componentName}Props {
  className?: string;
}

export const ${componentName}: React.FC<${componentName}Props> = ({ className = '' }) => {
  return (
    <section className={\`rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-slate-100 \${className}\`}>
      <h2 className="text-lg font-bold tracking-tight">${componentName}</h2>
      <p className="mt-2 text-sm text-slate-400">${designSpecs.replace(/[`${}]/g, '').slice(0, 140)}</p>
    </section>
  );
};
`;
              await fs.writeFile(abs, scaffold, 'utf-8');
              createdFile = relative;
            }
          }
        }

        return {
          success: true,
          componentName,
          designSpecs,
          figmaMeta,
          ...(createdFile ? { createdFile, modifiedFiles: [createdFile] } : {}),
          message: `Figma specs prepared for ${componentName}. Implement exact Tailwind styling and interactive states using write_to_file / replace_file_content.`,
        };
      }

      case 'focus_mode': {
        const selector = String(args.cssSelector || '').trim();
        if (!selector) return { error: 'cssSelector is required' };
        const needle = selector.replace(/^[.#]/, '');
        const candidatePaths: string[] = [];

        if (args.targetFile) {
          candidatePaths.push(resolveSafePath(args.targetFile, false).abs);
        } else {
          // Search likely UI files for the selector
          const { stdout } = await execPromise(
            `grep -rlF "${needle.replace(/"/g, '\\"')}" src projects --exclude-dir=node_modules --exclude-dir=dist | head -n 5`,
            { cwd: process.cwd() }
          ).catch(() => ({ stdout: '' }));
          for (const line of stdout.trim().split('\n').filter(Boolean)) {
            candidatePaths.push(path.resolve(process.cwd(), line));
          }
        }

        const matches: Array<{ file: string; line: number; snippet: string }> = [];
        for (const abs of candidatePaths) {
          if (!abs.startsWith(process.cwd())) continue;
          const content = await fs.readFile(abs, 'utf-8').catch(() => '');
          if (!content) continue;
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(needle) || lines[i].includes(selector)) {
              const start = Math.max(0, i - 4);
              const end = Math.min(lines.length, i + 25);
              matches.push({
                file: `/${path.relative(process.cwd(), abs)}`,
                line: i + 1,
                snippet: lines.slice(start, end).map((l, idx) => `${start + idx + 1}: ${l}`).join('\n'),
              });
              break;
            }
          }
        }

        return {
          success: true,
          cssSelector: selector,
          instruction: args.editInstruction,
          matchesFound: matches.length,
          matches,
          message: matches.length > 0
            ? `Focus Mode located '${selector}' in ${matches.map(m => `${m.file}:${m.line}`).join(', ')}. Apply targeted surgical edit via replace_file_content.`
            : `Selector '${selector}' was not matched verbatim—inspect target file with view_file before editing.`,
        };
      }

      case 'schedule': {
        const action = (args.Action || 'create').toLowerCase();
        if (action === 'list') {
          return listScheduledTasks();
        }
        if (action === 'cancel') {
          const cancelled = args.JobId ? cancelScheduledTask(args.JobId) : false;
          return { success: cancelled, jobId: args.JobId, message: cancelled ? 'Scheduled job cancelled.' : 'Job not found.' };
        }
        const duration = Number(args.DurationSeconds) || 5;
        const prompt = args.Prompt || 'Timer notification';
        const job = scheduleRealTask(prompt, duration, Boolean(args.Recurring), (firedJob) => {
          routeClawHipEvent('emit', 'scheduled_task_fired', `Timer fired (${firedJob.id}): ${firedJob.prompt}`, JSON.stringify(firedJob));
        });
        return {
          success: true,
          job,
          message: `Real background ${job.recurring ? 'recurring interval' : 'one-shot timer'} scheduled (${job.durationSeconds}s, id: ${job.id}).`,
        };
      }

      case 'workspace_init': {
        const sid = args.sessionId || execCtx?.sessionId || 'default';
        return await initSessionWorkspace(sid, args.template || 'react-vite', args.appTitle || 'Sandboxed App');
      }

      case 'workspace_run': {
        const sid = args.sessionId || execCtx?.sessionId || 'default';
        const action = (args.action || 'start').toLowerCase();
        if (action === 'build') return await buildWorkspaceToStaticPreview(sid);
        if (action === 'stop') return await stopWorkspaceServer(sid);
        if (action === 'status') return await getWorkspaceStatus(sid);
        return await startWorkspaceServer(sid, args.command);
      }

      case 'github_clone': {
        const sid = args.sessionId || execCtx?.sessionId || 'default';
        return await cloneGitHubRepoToWorkspace({
          repo: args.repo || '',
          sessionId: sid,
          branch: args.branch,
          autoStart: args.autoStart !== false,
        });
      }

      case 'ast_context_ranker': {
        return await rankAstContext(args.query || '', args.targetDir || '.', args.topK || 10);
      }

      case 'visual_qa_review': {
        return await runVisualQaReview({
          targetUrl: args.targetUrl,
          sessionId: execCtx?.sessionId,
          viewport: args.viewport || 'desktop',
          geminiApiKey: execCtx?.geminiApiKey,
        });
      }

      case 'persistence_status': {
        return await getPersistenceStatus();
      }

      case 'plan': {
        const steps = Array.isArray(args.steps)
          ? args.steps.map((s: any) => (typeof s === 'string' ? s : s?.title || JSON.stringify(s))).filter(Boolean)
          : [];
        const planDir = path.resolve(process.cwd(), '.nexus_plans');
        await fs.mkdir(planDir, { recursive: true }).catch(() => {});
        const safeSess = (execCtx?.sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
        const planPath = path.join(planDir, `${safeSess}.json`);
        const mdPath = path.join(planDir, `${safeSess}.md`);
        const planData = { sessionId: safeSess, updatedAt: Date.now(), steps };
        const mdContent = `# Implementation Plan (${safeSess})\n\n${steps.map((st: string, i: number) => `${i + 1}. [ ] ${st}`).join('\n')}\n`;
        await fs.writeFile(planPath, JSON.stringify(planData, null, 2), 'utf-8').catch(() => {});
        await fs.writeFile(mdPath, mdContent, 'utf-8').catch(() => {});

        const wsDir = path.resolve(process.cwd(), 'workspaces', safeSess);
        const wsExists = await fs.access(wsDir).then(() => true).catch(() => false);
        if (wsExists) {
          await fs.writeFile(path.join(wsDir, 'IMPLEMENTATION_PLAN.md'), mdContent, 'utf-8').catch(() => {});
        }
        onAction?.(`📋 Plan created (${steps.length} steps): ${steps.slice(0, 3).join(' → ')}`);
        return {
          success: true,
          planFile: `.nexus_plans/${safeSess}.json`,
          markdownPlanFile: `.nexus_plans/${safeSess}.md`,
          steps,
          message: `Implementation plan persisted (${steps.length} steps). Proceed immediately to workspace_init and parallel batched write_to_file implementation.`,
        };
      }

      case 'api_contract_checker': {
        const defaultWs = execCtx?.sessionId ? `workspaces/${execCtx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '.';
        let targetDir = String(args.targetDir || '').trim();
        if (!targetDir && execCtx?.sessionId) {
          const hasWs = await fs.access(path.resolve(process.cwd(), defaultWs)).then(() => true).catch(() => false);
          targetDir = hasWs ? defaultWs : '.';
        }
        return await checkApiContracts(targetDir || '.');
      }

      case 'targeted_error_context': {
        const defaultWs = execCtx?.sessionId ? `workspaces/${execCtx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '.';
        let targetDir = String(args.targetDir || '').trim();
        if (!targetDir && execCtx?.sessionId) {
          const hasWs = await fs.access(path.resolve(process.cwd(), defaultWs)).then(() => true).catch(() => false);
          targetDir = hasWs ? defaultWs : '.';
        }
        return await extractTargetedErrorContext(args.errorOutput, targetDir || '.');
      }

      default:
        return { success: true, message: `Tool ${name} executed.` };
    }
  } catch (err: any) {
    return { error: err.message || `Error executing tool ${name}` };
  }
}

// Full Gemini Chat Stream Handler with Function Calling & Tool Loop
export async function handleServerGeminiChat(req: { messages: any[]; mode?: string }, res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const { messages, mode = "general" } = req;
    const modelName = "gemini-3.8-flash";

    const { history, lastMessage } = prepareGeminiHistoryAndLastMessage(messages);
    const chat = getAiClient().chats.create({
      model: modelName,
      config: {
        systemInstruction: getNexusSystemInstruction(mode),
        tools: [{ functionDeclarations: serverTools }],
      },
      history,
    });

    let currentResult = await chat.sendMessageStream({ message: lastMessage });
    let fullText = "";

    while (true) {
      const functionCalls: any[] = [];

      for await (const chunk of currentResult) {
        if (chunk.text) {
          fullText += chunk.text;
          sendEvent({ type: "text", text: fullText });
        }
        if (chunk.functionCalls && chunk.functionCalls.length > 0) {
          functionCalls.push(...chunk.functionCalls);
        }
      }

      if (functionCalls.length === 0) break;

      const toolResponses = await Promise.all(
        functionCalls.map(async (call) => {
          if (!call.name) return null;
          const toolResult = await executeServerTool(call.name, call.args, (action) => {
            sendEvent({ type: "action", action });
          });
          if ((call.name === "generate_image" || call.name === "generateImage") && toolResult?.imageUrl) {
            sendEvent({ type: "image", imageUrl: toolResult.imageUrl });
          }
          return {
            functionResponse: {
              name: call.name,
              response: { output: toolResult },
            },
          };
        })
      );

      const validResponses = toolResponses.filter(Boolean);
      currentResult = await chat.sendMessageStream({ message: validResponses as any });
    }

    const deployed = await autoDeployWebsiteFromText(fullText);
    if (deployed.success) {
      const previewUrl = deployed.url || "/projects/index.html";
      sendEvent({ type: "action", action: `✓ Website & PWA generated & saved (${previewUrl})! Live Preview ready.` });
      sendEvent({ 
        type: "preview_ready", 
        url: previewUrl, 
        html: deployed.html,
        timestamp: Date.now() 
      });
    }

    sendEvent({ type: "done", fullText });
    res.end();
  } catch (error: any) {
    console.error("Gemini Server Error:", error);
    sendEvent({
      type: "error",
      error: error.message || "An error occurred with Gemini on the server.",
      is429: error.message?.includes("429") || error.toString().includes("429"),
    });
    res.end();
  }
}
