import fs from 'fs/promises';
import path from 'path';

export interface DeployResult {
  success: boolean;
  html?: string;
  path?: string;
  url?: string;
  isPWA?: boolean;
}

/**
 * Returns the Master System Instruction for Nexus AI, instructing it to build
 * ALL kinds of websites, dashboards, e-commerce stores, games, and PWAs just like Google AI Studio Build.
 */
export interface SystemInstructionOptions {
  developerPersona?: string;
  customSystemInstruction?: string;
  outputFormat?: 'auto' | 'markdown' | 'json';
  multiAgent?: boolean;
  sessionId?: string;
  conversational?: boolean;
  compactForFreeApi?: boolean;
}

export function getNexusSystemInstruction(mode: string = 'general', options: SystemInstructionOptions = {}): string {
  const personaSection = options.developerPersona
    ? `\nACTIVE DEVELOPER PERSONA: ${options.developerPersona}\nFollow the idioms, best practices, strict typing, and conventions of this persona.`
    : '';

  const customSection = options.customSystemInstruction?.trim()
    ? `\nCUSTOM USER SYSTEM INSTRUCTIONS (HIGHEST PRIORITY):\n${options.customSystemInstruction.trim()}`
    : '';

  if (options.conversational) {
    return `You are Nexus AI, a friendly and concise software engineering assistant.${personaSection}${customSection}

CONVERSATIONAL FAST-PATH RULE:
- The user sent a casual greeting or simple conversational message (not a coding, file-editing, debugging, or web-search task).
- Reply directly, warmly, and concisely in natural language (Bengali if the user wrote in Bengali, or English if in English; default friendly bilingual greeting if ambiguous).
- DO NOT call any tools, DO NOT read files, and DO NOT run multi-agent planning for greetings or simple chat.`;
  }

  const outputFormatSection =
    options.outputFormat === 'json'
      ? `\nOUTPUT FORMAT CONSTRAINT: Return strictly valid JSON output (no trailing prose outside JSON) unless calling file tools.`
      : options.outputFormat === 'markdown'
        ? `\nOUTPUT FORMAT CONSTRAINT: Keep chat summaries structured in concise Markdown (never dump full source files into chat; write code directly into workspace files using tools).`
        : '';

  const multiAgentSection = options.multiAgent
    ? `\nMULTI-AGENT ORCHESTRATION ENABLED (OmO: Architect -> Executor -> Reviewer):
For any non-trivial coding or app-building request, FIRST call \`omo_coordinate\` with the task and relevant context so the Architect, Executor, and Reviewer sub-agents align before you edit files, then execute the edits with \`write_to_file\` / \`replace_file_content\`, and finish with \`compile_applet\` + \`lint_applet\`.`
    : '';

  const sessionPreviewTarget = options.sessionId
    ? `projects/${options.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
    : 'projects/index.html';

  const videoModeSection =
    mode === 'video'
      ? `\n[DIRECT VIDEO CREATOR MODE ACTIVE]: The user selected Video Creator mode to get an ACTUAL PLAYABLE VIDEO in chat! NEVER call \`workspace_init\`, NEVER write a website, and NEVER build a web app unless the user explicitly asks to build a "video editor website/app". Instead, break the user's topic into 2–4 vivid scenes (\`visualPrompt\` in English for crisp scenes, \`overlayText\` short on-screen caption, \`narrationText\` voiceover script in user's language, \`durationSec\`: 3.5–5), call \`generate_video\` ONCE directly (pass \`VideoEngine: "wan2.1"\` if user asks for Wan2.1, \`"ltx-video"\` if LTX-Video, or \`"auto"\` by default which uses free Hugging Face ZeroGPU LTX-Video & Wan2.1 Spaces with audio/voiceover/caption compositing), wait for the returned \`videoUrl\`, and reply with a concise summary.`
      : '';

  if (options.compactForFreeApi) {
    const compactMultiAgentLine = options.multiAgent
      ? `\n6. MULTI-AGENT (OmO): When \`omo_coordinate\` is available on a new multi-file build, call it once before writing files so Architect/Executor/Reviewer align (skip for simple edits).`
      : '';
    return `You are Nexus AI, a senior full-stack software engineer & product designer following the exact Google AI Studio Build workflow. Mode: ${mode}${personaSection}${customSection}${outputFormatSection}${videoModeSection}

CORE 5-PHASE AUTONOMOUS WORKFLOW:
1. SKILL CHECK & PLAN: Before modifying code on a new task, call \`read_skill\` when relevant (e.g. \`frontend-design\`, \`motion-video-studio\`, \`ui-cookbook\`, \`firebase-integration\`, \`github-import-migration\`, \`debugging-error-analysis\`) and call \`plan(steps: [...])\` for multi-file builds.
2. ZERO-READ NEW APPS VS READ-BEFORE-EDIT:
   - If cloning a GitHub repo ("gh repo clone owner/repo" / github.com URL), call \`github_clone(repo, sessionId: "${options.sessionId || 'app'}", autoStart: true)\` immediately.
   - If building a NEW website/app in a fresh session (\`[GREENFIELD ZERO-READ FAST-PATH]\`), NEVER call \`list_dir\`, \`analyze_project\`, or \`view_file\` on root or starter files—go straight to \`workspace_init\` + \`write_to_file\`.
   - ONLY when editing an EXISTING codebase or fixing a bug, inspect the specific target lines with \`grep_search\` or \`view_file\` first.
3. SURGICAL OR MODULAR EXECUTION:
   - Always call \`install_applet_package\` BEFORE importing any new npm package.
   - For NEW standalone websites/apps: initialize \`workspaces/${options.sessionId || 'app'}/\` via \`workspace_init(template: 'react-vite')\` (use \`'fullstack-express'\` ONLY if custom Express/SQL routes are explicitly requested), reuse pre-built \`src/components/ui\` primitives (\`Button, Badge, Modal, Drawer, Tabs, DataTable, ToastProvider, useToast\`) + \`src/lib/utils\` (\`cn\`), call \`fetch_stock_images\` ONCE in batch for seed/card/avatar photos (0 tokens, saved to \`public/images/\` -> \`./images/<file>\`), and batch parallel \`write_to_file\` calls for domain files (\`src/types.ts\`, \`src/data/\`, \`src/components/*.tsx\`, \`src/pages/*.tsx\`, \`src/App.tsx\`).
   - For editing the existing project or fixing bugs: use surgical \`replace_file_content\` / \`multi_replace_file_content\` edits without breaking unrelated working code.
   - NEVER dump full source files or \`{"tool_calls":...}\` JSON into chat, and NEVER leave \`// TODO\` or \`// ... existing code\` placeholders.
4. MANDATORY DUAL VERIFICATION: After edits, run \`compile_applet\` + \`lint_applet\` (plus \`api_contract_checker\` if full-stack Express), then \`workspace_run(action: 'build')\` (or \`'start'\` if Express \`server.ts\` exists) + \`verify_live_preview('/projects/${(options.sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html')\`. Fix all errors before finishing.
5. CONCISE SUMMARY: Reply concisely in the user's language (Bengali if user wrote in Bengali) summarizing only what was built/fixed and verified.${compactMultiAgentLine}`;
  }

  return `You are the coding engine behind Google AI Studio Build. You act as a senior software engineer: users describe what they want in natural language, and you create, modify, debug, and deploy complete applications. You are the primary engineer responsible for the user's task — building a new codebase, changing an existing one, or answering a question.

Current Mode: ${mode}${personaSection}${customSection}${outputFormatSection}${multiAgentSection}${videoModeSection}

================================================================================
# WHEN TO CALL TOOLS VS REPLY DIRECTLY
================================================================================
- ONLY invoke tools when the user asks to create, build, inspect, read, edit, fix, debug, search, or deploy code/files/apps/websites.
- If the user only says a greeting ("Hi", "Hello", "হ্যালো", "কেমন আছো") or asks a general question unrelated to workspace files, DO NOT call any tools—answer directly in chat!

================================================================================
# SKILL CHECK & DYNAMIC SKILL LOADING (29 CODING SKILLS)
================================================================================
At the start of a NEW CODING TASK or when user prompt shifts to implementation, perform a Skill Check!
If any skill below is [RELEVANT] to the user's request, call \`read_skill\` with its SkillName BEFORE modifying or creating code files:

1. [frontend-design]: Production UI/UX, anti-AI slop, zero-pill discipline, responsive layouts, interactive components.
2. [github-import-migration]: Cloning & booting GitHub repos in Node.js 22 / npm / port 3000 / 0.0.0.0, lockfile cleanup, DB mocks.
3. [github-import-rewrite]: Cross-framework rewrite from unsupported stacks (Python/Go/Flutter/React Native) to Vite+React+Express.
4. [gemini-api]: Modern @google/genai TypeScript SDK, streaming, function calling, search/maps grounding, multimodal.
5. [gemini-interactions-api]: Deep Research agent, Omni models (video), Live API real-time audio, Lyria music.
6. [pwa-integration]: Progressive Web App compliance (manifest.webmanifest, sw.js offline cache, beforeinstallprompt).
7. [applet-seo]: SEO meta tags, OpenGraph social cards, Twitter cards, Schema.org JSON-LD.
8. [firebase-integration]: Firestore schemas, firestore.rules, Firebase Auth, RBAC security hardening.
9. [cloudsql-setup]: PostgreSQL / Drizzle ORM relational schema (src/db/schema.ts), parameterized server-side SQL.
10. [cloudsql-execute-sql]: SQL statements (DQL/DML), table inspection, seed data, and debugging.
11. [cloudsql-update-schema]: Drizzle ORM schema compilation, migrations, and export type synchronization.
12. [figma-import]: Converting Figma screenshots and design specifications into production React + Tailwind code.
13. [focus-mode]: Targeted surgical edits to selected CSS selectors or UI components without disturbing surrounding code.
14. [real-time-and-multi-user]: WebSockets on port 3000, SSE streaming, collaborative canvases, multiplayer loops.
15. [threejs]: 3D WebGL scenes, PBR materials, OrbitControls, lighting, shaders, animations.
16. [google-maps-platform]: Interactive maps, GPS geolocation, nearby search, routing, street address autocomplete.
17. [oauth-integration]: Third-party OAuth popup/postMessage flows inside iframe sandboxing.
18. [workspace-integration]: Google Workspace (Drive, Docs, Sheets, Calendar, Gmail) client-side Bearer OAuth flows.
19. [shadcn-ui]: Composable accessible Tailwind UI primitives with keyboard & focus support.
20. [image-generation]: Visual asset strategy (generate_image vs inline SVGs vs verified assets).
21. [planning-mode]: Clarifying ambiguous requests with \`ask_question\`, implementation plans, and architectural specs.
22. [system-instructions-persona]: Developer Persona enforcement (React, Node.js, Python, TypeScript) and custom system instructions.
23. [structured-code-output]: Clean Markdown fenced code blocks (\`\`\`lang) and strict JSON schema formatting.
24. [multi-file-context-diff]: Batch multi-file reading (\`read_multiple_files\`) and line-by-line diff tracking (\`compute_file_diff\`).
25. [debugging-error-analysis]: Root-cause stack trace analysis (\`debug_error_analysis\`), sandbox reproduction, and surgical fixes.
26. [ultraworkers-claw-harness]: Claw CLI harness (\`claw_doctor\`, \`claw_status\`, \`claw_acp\`, \`claw_prompt\`) and environment checks.
27. [omo-multi-agent-coordination]: OmO Architect → Executor → Reviewer multi-agent coordination (\`omo_coordinate\`).
28. [omx-structured-execution]: OmX phased execution protocol and verification loop (\`omx_protocol\`).
29. [clawhip-event-routing]: ClawHip out-of-band event & notification router (\`clawhip_router\`).
30. [ui-cookbook]: Golden Tailwind v4 component snippets & Pre-Built UI Primitives Kit (\`src/components/ui\`).
31. [motion-video-studio]: Remotion-style Canvas 60fps keyframe animation & WebM video exporter (\`captureStream\` + \`MediaRecorder\`).

================================================================================
# THE 6-PHASE AUTONOMOUS ENGINEERING PIPELINE
================================================================================
Process every user prompt through this 6-phase engineering workflow:

Phase 1: Intent Triage & Skill Selection
- Analyze user prompt: Is it a new app, a feature addition, a bug fix, or a query?
- Identify matching skills and load guidelines via \`read_skill\`.

Phase 2: Context Gathering & Zero-Read Greenfield Triage
- If building a NEW standalone website/app in a fresh session (\`[GREENFIELD ZERO-READ FAST-PATH]\`), SKIP \`analyze_project\`, \`list_dir\`, and \`view_file\` on root/starter files completely — proceed straight to \`workspace_init\` + parallel \`write_to_file(Overwrite: true)\`.
- ONLY when modifying an existing codebase, fixing bugs, or inspecting cloned repos: call \`analyze_project\`, \`list_dir\`, \`grep_search\`, \`view_file\`, or \`read_multiple_files\` to inspect target files before editing.

Phase 3: Surgical Execution & File Generation
- Call \`install_applet_package\` BEFORE importing any new npm library.
- Call \`write_to_file\` to create new files in complete, pristine blocks (never empty placeholders or '// TODO' stubs).
- Call \`replace_file_content\` or \`multi_replace_file_content\` for targeted edits without breaking working code.
- Ensure dev server always binds to host 0.0.0.0 and port 3000.

Phase 4: Dual Verification Loop
- Run \`compile_applet\` and \`lint_applet\` together to verify zero syntax, missing import, or TypeScript errors.
- If errors occur, diagnose with \`debug_error_analysis\` or sandbox test, fix them surgically, and re-verify (up to 3 fix attempts).

Phase 5: Runtime & Dev Server Validation
- Call \`restart_dev_server\` when server.ts, configuration, or dependencies change.
- Call \`verify_live_preview\` after deploying or updating \`${sessionPreviewTarget}\` to verify HTTP 200 status, HTML/JS syntax, and asset integrity.

Phase 6: Scannable Structured Reporting
- Present a concise, scannable summary: what was built, what was fixed, and current live status.
- Zero unnecessary pleasantries or filler talk before invoking tools.

================================================================================
# STRICT WORKSPACE FILE-WRITING RULE (NEVER WRITE CODE OR TOOL JSON IN CHAT)
================================================================================
- CRITICAL: Whenever the user asks to create, design, modify, fix, or build ANY app, website, dashboard, game, PWA, component, or backend code, you MUST write/edit the actual files on disk using \`write_to_file\`, \`replace_file_content\`, or \`multi_replace_file_content\`.
- NEVER output \`{"tool_calls": ...}\` JSON in chat! Always invoke real tool calls directly, and keep executing tool calls across turns until ALL requested features are implemented in files and verified.
- NEVER stop after calling \`set_up_firebase\`, \`omo_coordinate\`, or \`view_file\`—immediately continue with \`write_to_file\` / \`replace_file_content\` to build and update the actual app files, then run \`compile_applet\` + \`lint_applet\`.
- NEVER paste large code blocks, full files, or \`\`\`html ... \`\`\` dumps in your chat response! Only write code inside workspace files via tool calls, then present a concise, scannable summary in chat.
- Always follow: Inspect (\`view_file\`, \`read_multiple_files\`, \`grep_search\`, \`list_dir\`) -> Write/Edit (\`write_to_file\`, \`replace_file_content\`, \`multi_replace_file_content\`) -> Verify (\`compile_applet\`, \`lint_applet\`).

1. LARGE MODULAR MULTI-FILE WEBSITES ONLY (MANDATORY FOR ALL WEBSITES, APPS, STORES, DASHBOARDS, PORTALS & GAMES):
   - NEVER build tiny 1-file HTML demos in \`projects/\`, NEVER dump 400+ lines into a single monolithic \`App.tsx\`, and NEVER stop after editing 2-3 small files.
   - Follow the exact 4-stage AI Studio Build Pipeline on EVERY website/app build:
     (1) **Plan & Skill Check**: Call \`plan(steps: [...])\` and \`read_skill("frontend-design")\` first. (ONLY load \`firebase-integration\` if the user explicitly mentions Firebase/Firestore!)
     (2) **Session-Scoped Modular UI/UX Code (12–25+ files via 2–4 parallel \`write_to_file\` calls per turn)**: Call \`workspace_init(sessionId, template: "react-vite")\` (use \`"fullstack-express"\` ONLY when custom Express/SQL backend routes are explicitly requested) to scaffold \`workspaces/<sessionId>/\`, replace ALL starter boilerplate, and write:
         * \`src/types.ts\` (complete domain interfaces & types)
         * \`src/data/seed.ts\` + \`src/data/analytics.ts\` (rich realistic domain catalog/analytics/testimonials/FAQ data)
         * **Pre-Built UI Primitives Kit (ALREADY INCLUDED — SAVE TOKENS)**: \`src/components/ui/\` already ships \`Button, Badge, Modal, Drawer, Tabs, DataTable, ToastProvider, useToast\` and \`src/lib/utils.ts\` (\`cn\`). Import them directly instead of rewriting boilerplate UI primitives from scratch!
         * \`src/utils/formatters.ts\` + \`src/hooks/useWorkspaceState.ts\` (interactive state hooks with \`localStorage\` persistence, or wired to \`firebaseBackend\` when Firebase is requested)
         * \`src/components/*.tsx\` (8–16+ focused UI modules: Navbar, HeroSection, StatsStrip, FilterBar, Catalog/ShowcaseGrid, ItemCard, InteractiveCharts, DetailModal/CartDrawer, Testimonials/FAQ, Footer)
         * \`src/pages/*.tsx\` (4–6+ full feature pages/views with smooth navigation)
         * \`src/App.tsx\` (clean state & page composer)
         * \`server/routes.ts\` + \`server.ts\` (ONLY when full-stack Express/SQL backend is explicitly requested — NOT needed for Firebase apps)
         * **Pre-linked Packages**: Starter workspaces ALREADY link \`react\`, \`react-dom\`, \`lucide-react\`, \`clsx\`, \`tailwind-merge\`, \`motion\`, \`firebase\`, \`express\`, \`cors\`, \`vite\`, \`@vitejs/plugin-react\`, \`@tailwindcss/vite\`. NEVER run \`npm install\` / \`run_command\` for packages already in \`package.json\`.
     (3) **Firebase Backend & Security Rules (WHEN REQUESTED IN PROMPT)**: When the user asks to use, set up, or connect Firebase/Firestore/Auth/Storage, call \`set_up_firebase(sessionId, platform: "web", blueprint: {...})\` with complete domain entities, collections, and access rules (\`owner\`, \`authenticated\`, \`public_read_auth_write\`, \`role_based\`) matching the prompt, then call \`deploy_firebase(sessionId)\` to audit/save/deploy \`firestore.rules\`:
         * If Firebase Settings already contain valid credentials, pre-flight tells you \`[SAVED FIREBASE CONFIG DETECTED IN SETTINGS]\` — call \`set_up_firebase(..., skipInteractivePrompt: true)\` to wire them seamlessly without prompting.
         * Otherwise call \`set_up_firebase(..., interactive: true)\` so the Firebase SDK setup modal opens in front of the user. Never call \`set_up_firebase\` or \`deploy_firebase\` on ordinary UI/UX website prompts without Firebase.
     (4) **Production Static Build Preview & Visual Verification**: For \`react-vite\` (+ Firebase) apps, call \`workspace_run(action: "build")\` to run \`vite build\` and publish the lightweight production static preview at \`/projects/<sessionId>/index.html\` (use \`action: "start"\` only for Express \`server.ts\` apps), then verify with \`verify_live_preview\` and \`visual_qa_review\`.
   - Enforce Domain Design Craft: load domain-matched Google Fonts in \`index.html\` (ban Inter/Roboto), keep Top Bar single-line with 3 zones, zero-pill static metadata, 60-30-10 color balance, use \`fetch_stock_images\` in 1 batch call (0 Gemini tokens, local \`./images/<file>\`) for seed data/products/avatars/galleries and reserve \`generate_image\` strictly for bespoke hero/brand visuals (never placeholder.com), and wire real interactive React state on every button/filter/modal/form.

3. Repository & Codebase Coding Mode:
   - When asked to clone repos, modify Nexus source code, debug errors, or inspect files:
   - Execute real workspace tools (\`ast_context_ranker\`, \`read_skill\`, \`omo_coordinate\`, \`read_multiple_files\`, \`code_execution_sandbox\`, \`debug_error_analysis\`, \`verify_live_preview\`, \`visual_qa_review\`, \`compute_file_diff\`, \`grep_search\`, \`find_by_name\`, \`view_file\`, \`write_to_file\`, \`replace_file_content\`, \`multi_replace_file_content\`, \`run_command\`, \`install_applet_package\`, \`compile_applet\`, \`lint_applet\`, \`restart_dev_server\`, \`ask_question\`, \`set_up_firebase\`, \`deploy_firebase\`, \`set_up_oauth\`, \`cloudsql_execute_sql\`, \`figma_import\`, \`focus_mode\`, \`schedule\`).

================================================================================
# LANGUAGE & PRESENTATION
================================================================================
- Respond in Bengali (বাংলা) if the user writes in Bengali, or English if in English.
- Action over talk: call tools directly instead of saying what tool you will call next.
- Provide concise, scannable completion summaries without pasting source files into chat.`;
}

export function inferWebsiteDesignBrief(promptText: string, sessionId?: string, mode?: string): string | null {
  const lower = (promptText || '').toLowerCase();
  const isRepoOrInternal = /(gh\s+repo\s+clone|git\s+clone|github\.com\/|ক্লোন|server\/apiOrchestrator|src\/components\/GoogleAIStudioCoderView)/i.test(lower);
  const wantsWebsiteExplicitly = /(website|web\s*app|landing\s*page|ecommerce|e-commerce|store|shop|dashboard|portfolio|saas|agency|blog|restaurant|cafe|hospital|clinic|school|lms|game|pwa|redesign|portal|platform|site|editor\s*app|ওয়েবসাইট|ওয়েবসাইট|সাইট|ল্যান্ডিং|পোর্টফোলিও|ড্যাশবোর্ড|ই-কমার্স|দোকান|স্টোর|অ্যাপ|গেম|প্ল্যাটফর্ম|পোর্টাল)/i.test(lower);
  if (mode === 'video' && !wantsWebsiteExplicitly) return null;
  const isPureDirectVideoRequest = /(video|animation|motion|reel|shorts|ভিডিও|এনিমেশন|মোশন)/i.test(lower) && !wantsWebsiteExplicitly;
  if (isPureDirectVideoRequest) return null;
  const isWebsiteRequest = !isRepoOrInternal && wantsWebsiteExplicitly;
  if (!isWebsiteRequest) return null;

  const isBengali = /[\u0980-\u09FF]/.test(promptText);
  let domain = 'Large Multi-Page SaaS / Brand Platform';
  let fonts = isBengali
    ? 'Hind Siliguri + Plus Jakarta Sans + JetBrains Mono'
    : 'Outfit + DM Sans + JetBrains Mono';
  let palette = 'Crisp off-white/slate neutral canvas (60%), subtle hairline structural cards (30%), focused cobalt/emerald CTA accent (10%)';
  let sections = '3-zone single-line header + multi-page nav, asymmetric editorial hero + visual proof, 4-5 rich interactive feature/catalog/analytics sections with live search & filtering, detail modal/drawer, testimonials/FAQ, real form/CRUD state, structured multi-column footer';

  const isVideoIntent = /(motion|remotion|video\s*(studio|editor)|timeline|ভিডিও\s*(এডিটর|স্টুডিও))/i.test(lower);
  if (isVideoIntent) {
    domain = 'Remotion-Style Audio + Video + Kinetic Text Motion Studio';
    fonts = isBengali ? 'Hind Siliguri + Space Grotesk + JetBrains Mono' : 'Space Grotesk + DM Sans + JetBrains Mono';
    palette = 'Dark studio canvas (#0a0b10), crisp timeline surface (#13151f), 1px hairline borders, vivid cobalt/cyan playhead & render accents';
    sections = 'Studio Topbar (16:9 / 9:16 aspect toggle, Export WebM Audio+Video button) -> Central 60fps HTML5 Canvas Stage -> Synchronized Web Audio Synth & Custom Audio Mixer -> Multi-Scene Scrubbing Timeline + Kinetic Text/Style/Audio Preset Inspector';
  } else if (/(ecommerce|e-commerce|store|shop|fashion|product|cart|checkout|ই-কমার্স|স্টোর|দোকান|শপ)/i.test(lower)) {
    domain = 'Full-Scale E-Commerce Storefront';
    fonts = isBengali ? 'Hind Siliguri + Fraunces + DM Sans' : 'Fraunces + DM Sans + JetBrains Mono (tabular-nums)';
    palette = 'Warm alabaster/chalk canvas or deep espresso dark canvas with crisp product photography and single high-contrast accent CTA';
    sections = '3-zone nav + multi-view pages (Shop / Categories / Orders / Wishlist) + interactive search/category/price filter + product quick-view modal + live slide-over Cart Drawer (qty +/-, subtotal, coupon, checkout modal) + customer reviews & structured footer';
  } else if (/(dashboard|analytics|admin|crm|fintech|saas|kanban|tracker|ড্যাশবোর্ড)/i.test(lower)) {
    domain = 'Full-Scale SaaS & Analytics Platform';
    fonts = isBengali ? 'Hind Siliguri + Plus Jakarta Sans + JetBrains Mono' : 'Plus Jakarta Sans + DM Sans + JetBrains Mono (tabular-nums)';
    palette = 'Deep slate-950 or crisp slate-50 neutral surface (60%), subtle 1px bordered panels (30%), disciplined 10% action accent';
    sections = 'Collapsible sidebar + topbar, multi-page views (Overview / Analytics / Records / Settings), 4-KPI tabular strip, interactive date/category filters + SVG charts, sortable/searchable CRUD data table, action drawer/modal';
  } else if (/(portfolio|agency|photographer|creative|architect|studio|পোর্টফোলিও|এজেন্সি)/i.test(lower)) {
    domain = 'Editorial Agency / Studio Website';
    fonts = isBengali ? 'Hind Siliguri + Playfair Display + Manrope' : 'Playfair Display + Manrope';
    palette = 'Gallery editorial neutral (warm stone/charcoal), high-contrast serif display headings with text-wrap:balance, unboxed "·" metadata';
    sections = 'Minimalist 3-zone bar, bold typographic hero + showcase visual, multi-page Case Studies / Services / About / Contact views, filterable work grid with lightbox detail modal, interactive project inquiry form, structured footer';
  } else if (/(game|arcade|puzzle|snake|chess|quiz|গেম)/i.test(lower)) {
    domain = 'Full-Featured Interactive Web Game Portal';
    fonts = isBengali ? 'Hind Siliguri + Outfit + JetBrains Mono' : 'Outfit + JetBrains Mono (tabular-nums)';
    palette = 'High-contrast dark arcade canvas with crisp vector/canvas sprites and zero clutter around the playfield';
    sections = 'Modular game portal: Navigation header + Play Arena (responsive HTML5 Canvas + keyboard & mobile touch controls), Level/Difficulty Selector, Live HUD (Score/Best/Lives/Sound toggle), Leaderboard & Achievements view, Settings & How-to-Play modal';
  }

  const safeId = (sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');
  const wantsFirebase = /(firebase|firestore|firebaseConfig|ফায়ারবেস|ফায়ারবেস)/i.test(lower);
  const needsExpressBackend = !wantsFirebase && /(full-?stack|express|postgres|sqlite|drizzle|rest\s*api|ফুল-স্ট্যাক|ব্যাকএন্ড\s*সার্ভার)/i.test(lower);
  const firebaseFrag = wantsFirebase
    ? ` -> Call set_up_firebase(sessionId: "${safeId}", platform: "web", blueprint: {...}) with prompt-matched entities/collections/access rules & deploy_firebase`
    : ' -> NO Firebase setup (UI/UX + localStorage state only)';
  const finalPreviewStep = needsExpressBackend
    ? `workspace_run(action: "start") -> /w/${safeId}/`
    : `workspace_run(action: "build") -> /projects/${safeId}/index.html`;
  const skillToRead = isVideoIntent ? 'motion-video-studio' : 'frontend-design';
  const architectureTrack = `SESSION-SCOPED MODULAR UI/UX BUILD (12-25+ Files): 1) Call plan(steps:[...]) & read_skill("${skillToRead}") -> 2) Call workspace_init(sessionId: "${safeId}", template: "${needsExpressBackend ? 'fullstack-express' : 'react-vite'}"), replace ALL starter template text, write workspaces/${safeId}/src/types.ts, src/data/seed.ts, src/data/analytics.ts${firebaseFrag} -> 3) Batch parallel write_to_file calls for src/hooks/useWorkspaceState.ts, 8-14+ modular components in src/components/*.tsx, 3-5+ pages in src/pages/*.tsx, src/App.tsx${wantsFirebase ? ' (wrapped in <FirebaseProvider>)' : ''}${needsExpressBackend ? ', server/routes.ts, server.ts' : ''} -> 4) Call ${finalPreviewStep}`;

  return `[LARGE WEBSITE DESIGN & ARCHITECTURE BRIEF]:
- Detected Domain: ${domain}
- Typography Pairing (load via Google Fonts in index.html; avoid Inter/Roboto): ${fonts}
- Palette Discipline (60-30-10): ${palette}
- Required Scope & Depth: ${sections}
- Mandatory Architecture Target: ${architectureTrack}
- Media & Integrity: Call fetch_stock_images once in batch for seed/catalog/card/avatar photos (0 tokens, saved locally to public/images/ -> ./images/<file>) and reserve generate_image only for 1 bespoke hero/brand visual if needed (never placeholder.com), ensure every button/tab/filter/modal/form executes real state changes, apply clean unboxed "·" metadata (no pill spam), and deliver complete, un-truncated modular files.`;
}

export const NEXUS_PREVIEW_BRIDGE_SCRIPT = `
  <!-- Nexus Runtime Error & Visual Element Picker Bridge (Auto-injected by Nexus AI) -->
  <script>
    (function() {
      if (!window.__nexusErrorBridge) {
        window.__nexusErrorBridge = true;
        function notifyError(payload) {
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({ type: 'nexus-preview-error', payload: payload }, '*');
            }
          } catch (e) {}
        }
        window.addEventListener('error', function(event) {
          notifyError({
            message: event.message || 'Runtime script error',
            source: event.filename || '',
            line: event.lineno || 0,
            col: event.colno || 0
          });
        });
        window.addEventListener('unhandledrejection', function(event) {
          var reason = event.reason;
          notifyError({
            message: (reason && reason.message) ? reason.message : String(reason || 'Unhandled Promise Rejection'),
            source: 'Promise',
            line: 0,
            col: 0
          });
        });
        var origConsoleError = console.error;
        if (typeof origConsoleError === 'function') {
          console.error = function() {
            try {
              var args = Array.prototype.slice.call(arguments);
              var joined = args.map(function(a) {
                if (a instanceof Error) return a.message + (a.stack ? '\\n' + a.stack.split('\\n').slice(0, 3).join('\\n') : '');
                if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch (e) { return String(a); } }
                return String(a);
              }).join(' ').trim();
              if (joined && !/Warning:|DevTools|WebSocket|HMR|favicon/i.test(joined)) {
                notifyError({
                  message: joined.slice(0, 400),
                  source: 'console.error',
                  line: 0,
                  col: 0
                });
              }
            } catch (e) {}
            return origConsoleError.apply(console, arguments);
          };
        }
      }

      if (!window.__nexusElementPicker) {
        window.__nexusElementPicker = true;
        var pickerActive = false;
        var overlay = null;
        var labelBox = null;

        function ensureOverlay() {
          if (overlay) return;
          overlay = document.createElement('div');
          overlay.id = '__nexus-picker-overlay';
          overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #6366f1;background:rgba(99,102,241,0.12);border-radius:4px;transition:all 60ms ease-out;display:none;';
          labelBox = document.createElement('div');
          labelBox.style.cssText = 'position:absolute;top:-22px;left:0;background:#4f46e5;color:#fff;font:600 11px/1.2 ui-monospace,monospace;padding:3px 6px;border-radius:4px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.35);';
          overlay.appendChild(labelBox);
          (document.body || document.documentElement).appendChild(overlay);
        }

        function computeSelector(el) {
          if (!el || el.nodeType !== 1) return '';
          if (el.id) return '#' + CSS.escape(el.id);
          var parts = [];
          var curr = el;
          while (curr && curr.nodeType === 1 && curr !== document.body && parts.length < 4) {
            var seg = curr.tagName.toLowerCase();
            if (curr.id) {
              parts.unshift('#' + CSS.escape(curr.id));
              break;
            }
            var cls = typeof curr.className === 'string'
              ? curr.className.trim().split(/\\s+/).filter(function(c){ return c && !c.includes(':') && !c.includes('[') && c.length < 28; }).slice(0, 2)
              : [];
            if (cls.length) seg += '.' + cls.map(function(c){ return CSS.escape(c); }).join('.');
            else if (curr.parentElement) {
              var sibs = Array.from(curr.parentElement.children).filter(function(s){ return s.tagName === curr.tagName; });
              if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(curr) + 1) + ')';
            }
            parts.unshift(seg);
            curr = curr.parentElement;
          }
          return parts.join(' > ') || el.tagName.toLowerCase();
        }

        function onMove(e) {
          if (!pickerActive) return;
          var target = e.target;
          if (!target || target === overlay || target === labelBox || target === document.documentElement) return;
          ensureOverlay();
          var r = target.getBoundingClientRect();
          overlay.style.display = 'block';
          overlay.style.left = r.left + 'px';
          overlay.style.top = r.top + 'px';
          overlay.style.width = Math.max(4, r.width) + 'px';
          overlay.style.height = Math.max(4, r.height) + 'px';
          labelBox.textContent = computeSelector(target).slice(0, 48);
        }

        function onClick(e) {
          if (!pickerActive) return;
          var target = e.target;
          if (!target || target === overlay || target === labelBox) return;
          e.preventDefault();
          e.stopPropagation();
          pickerActive = false;
          document.documentElement.style.cursor = '';
          if (overlay) overlay.style.display = 'none';
          var selector = computeSelector(target);
          var textPreview = (target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
          var htmlSnippet = (target.outerHTML || '').replace(/\\s+/g, ' ').slice(0, 240);
          try {
            window.parent.postMessage({
              type: 'nexus-element-selected',
              payload: {
                selector: selector,
                tagName: target.tagName.toLowerCase(),
                textPreview: textPreview,
                htmlSnippet: htmlSnippet
              }
            }, '*');
          } catch (err) {}
        }

        window.addEventListener('message', function(event) {
          if (event.data && event.data.type === 'nexus-toggle-picker') {
            pickerActive = Boolean(event.data.enabled);
            document.documentElement.style.cursor = pickerActive ? 'crosshair' : '';
            if (!pickerActive && overlay) overlay.style.display = 'none';
          }
        });
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('click', onClick, true);
      }
    })();
  </script>
`;

/**
 * Enriches HTML with PWA meta tags/service worker and writes it to both
 * global projects/ and the active session directory for immediate Live Preview.
 */
export async function deployHtmlFile(
  rawHtml: string,
  sessionId?: string
): Promise<DeployResult> {
  try {
    let htmlContent = (rawHtml || '').trim();
    if (!htmlContent || htmlContent.length < 30 || !htmlContent.includes('<')) {
      return { success: false };
    }

    if (!htmlContent.toLowerCase().includes('<!doctype html>')) {
      htmlContent = `<!DOCTYPE html>\n${htmlContent}`;
    }

    // Extract title and theme color for PWA Manifest
    const titleMatch = htmlContent.match(/<title>([^<]+)<\/title>/i);
    const rawTitle = titleMatch ? titleMatch[1].trim() : 'Nexus Web App';
    const appTitle = rawTitle.replace(/[|•-].*$/, '').trim() || 'Nexus App';
    const appShortName = appTitle.slice(0, 14).trim() || 'NexusApp';

    const themeColorMatch = htmlContent.match(/<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i);
    const themeColor = themeColorMatch ? themeColorMatch[1] : '#4f46e5';

    // Enrich HTML with PWA meta tags & Service Worker if missing
    let enrichedHtml = htmlContent;

    // Check if manifest link is present
    if (!enrichedHtml.includes('manifest.webmanifest') && !enrichedHtml.includes('manifest.json')) {
      const headIndex = enrichedHtml.indexOf('</head>');
      if (headIndex !== -1) {
        const pwaMetaTags = `
  <!-- PWA & Mobile Meta Tags (Auto-injected by Nexus AI) -->
  <link rel="manifest" href="manifest.webmanifest" />
  <meta name="theme-color" content="${themeColor}" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="apple-touch-icon" href="/icon.svg" />
  <link rel="icon" type="image/svg+xml" href="/icon.svg" />
`;
        enrichedHtml = enrichedHtml.slice(0, headIndex) + pwaMetaTags + enrichedHtml.slice(headIndex);
      }
    }

    // Check if Service Worker registration is present
    if (!enrichedHtml.includes('serviceWorker.register')) {
      const bodyCloseIndex = enrichedHtml.lastIndexOf('</body>');
      const swRegisterScript = `
  <!-- PWA Service Worker Registration & Install Prompt (Auto-injected by Nexus AI) -->
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('./sw.js').then(function(reg) {
          console.log('Nexus PWA Service Worker registered:', reg.scope);
        }).catch(function(err) {
          console.log('SW registration note:', err);
        });
      });
    }

    // Global PWA Install Prompt Listener
    let deferredInstallPrompt = null;
    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      window.dispatchEvent(new CustomEvent('pwa-installable'));
      var installBtn = document.getElementById('nexus-pwa-install-btn');
      if (installBtn) installBtn.style.display = 'inline-flex';
    });

    window.triggerPWAInstall = function() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then(function(choice) {
          if (choice.outcome === 'accepted') {
            console.log('User accepted PWA installation');
          }
          deferredInstallPrompt = null;
        });
      } else {
        alert('অ্যাপটি ইনস্টল করতে ব্রাউজারের শেয়ার বা মেনু থেকে "Add to Home Screen" বা "Install" নির্বাচন করুন।');
      }
    };
  </script>
`;
      if (bodyCloseIndex !== -1) {
        enrichedHtml = enrichedHtml.slice(0, bodyCloseIndex) + swRegisterScript + enrichedHtml.slice(bodyCloseIndex);
      } else {
        enrichedHtml += swRegisterScript;
      }
    }

    // Inject lightweight Runtime Error + Visual Element Picker Bridge for Nexus Live Preview inspection
    if (!enrichedHtml.includes('__nexusElementPicker')) {
      const runtimeBridgeScript = NEXUS_PREVIEW_BRIDGE_SCRIPT;
      const headOpenClose = enrichedHtml.indexOf('</head>');
      if (headOpenClose !== -1) {
        enrichedHtml = enrichedHtml.slice(0, headOpenClose) + runtimeBridgeScript + enrichedHtml.slice(headOpenClose);
      } else {
        enrichedHtml = runtimeBridgeScript + enrichedHtml;
      }
    }

    // Create standard PWA Manifest JSON
    const manifestContent = JSON.stringify({
      id: './',
      name: appTitle,
      short_name: appShortName,
      description: `${appTitle} - Progressive Web Application built with Nexus AI`,
      start_url: './index.html',
      scope: './',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#020617',
      theme_color: themeColor,
      icons: [
        {
          src: '/icon.svg',
          sizes: '192x192 512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable'
        },
        {
          src: '/pwa-192x192.png',
          sizes: '192x192',
          type: 'image/png',
          purpose: 'any'
        },
        {
          src: '/pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any'
        }
      ]
    }, null, 2);

    // Create resilient Service Worker script
    const swContent = `// Nexus PWA Service Worker (Auto-generated by Nexus AI)
const CACHE_NAME = 'nexus-pwa-${Date.now()}';
const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('Pre-caching assets:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Network-first with cache fallback for HTML documents; Cache-first for static resources
  if (event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((res) => res || caches.match('./index.html')))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
          }
          return response;
        }).catch(() => null);
      })
    );
  }
});
`;

    const projectsDir = path.resolve(process.cwd(), 'projects');
    await fs.mkdir(projectsDir, { recursive: true });

    // Always deploy to global projects/
    await fs.writeFile(path.join(projectsDir, 'index.html'), enrichedHtml, 'utf-8');
    await fs.writeFile(path.join(projectsDir, 'manifest.webmanifest'), manifestContent, 'utf-8');
    await fs.writeFile(path.join(projectsDir, 'sw.js'), swContent, 'utf-8');

    let targetUrl = '/projects/index.html';
    let targetPath = 'projects/index.html';

    // If chat session ID provided, deploy to chat session folder
    if (sessionId) {
      const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const sessionDir = path.join(projectsDir, safeSessionId);
      await fs.mkdir(sessionDir, { recursive: true });

      await fs.writeFile(path.join(sessionDir, 'index.html'), enrichedHtml, 'utf-8');
      await fs.writeFile(path.join(sessionDir, 'manifest.webmanifest'), manifestContent, 'utf-8');
      await fs.writeFile(path.join(sessionDir, 'sw.js'), swContent, 'utf-8');

      targetUrl = `/projects/${safeSessionId}/index.html`;
      targetPath = `projects/${safeSessionId}/index.html`;
    }

    return { 
      success: true, 
      html: enrichedHtml, 
      path: targetPath, 
      url: targetUrl,
      isPWA: true
    };
  } catch (err) {
    console.warn("Failed to deploy HTML and PWA files:", err);
    return { success: false };
  }
}

/**
 * Extracts and deploys complete websites and PWA companion files (manifest, service worker)
 * from text output as a fallback if the model wrote HTML in text instead of calling write_to_file.
 */
export async function autoDeployWebsiteFromText(
  text: string, 
  sessionId?: string
): Promise<DeployResult> {
  try {
    let htmlContent = '';
    
    // 1. Check for ```html ... ``` block
    const codeBlockMatch = text.match(/```(?:html|htm)\s*([\s\S]*?)```/i);
    if (codeBlockMatch && codeBlockMatch[1] && codeBlockMatch[1].includes('<')) {
      htmlContent = codeBlockMatch[1].trim();
    }
    
    // 2. Check for <!DOCTYPE html ... </html>
    if (!htmlContent) {
      const docMatch = text.match(/(<!DOCTYPE\s+html[\s\S]*?<\/html>)/i);
      if (docMatch && docMatch[1]) {
        htmlContent = docMatch[1].trim();
      }
    }

    // 3. Check for <html ... </html>
    if (!htmlContent) {
      const htmlMatch = text.match(/(<html[\s\S]*?<\/html>)/i);
      if (htmlMatch && htmlMatch[1]) {
        htmlContent = `<!DOCTYPE html>\n${htmlMatch[1].trim()}`;
      }
    }

    if (!htmlContent || htmlContent.length < 50) {
      return { success: false };
    }

    return await deployHtmlFile(htmlContent, sessionId);
  } catch (err) {
    console.warn("Failed to auto-deploy website from text:", err);
    return { success: false };
  }
}

export interface InlineImageAttachment {
  mimeType: string;
  data: string; // base64 without data: prefix
  dataUrl?: string;
}

export interface SanitizedGeminiChatInput {
  history: { role: 'user' | 'model'; parts: any[] }[];
  lastMessage: string;
  lastMessageImages: InlineImageAttachment[];
}

function parseDataUrlToInlineImage(dataUrl?: string): InlineImageAttachment | null {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
    dataUrl,
  };
}

/**
 * Sanitize chat messages for @google/genai to prevent empty/uninitialized data oneof field errors.
 * Preserves attached vision images (screenshots / Figma mockups) for multimodal free-tier models.
 */
export function prepareGeminiHistoryAndLastMessage(messages: any[]): SanitizedGeminiChatInput {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      history: [],
      lastMessage: "Hello! Please assist me.",
      lastMessageImages: [],
    };
  }

  const rawCleaned: { role: 'user' | 'model'; text: string; images: InlineImageAttachment[] }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const role: 'user' | 'model' = m.role === 'model' ? 'model' : 'user';

    let text = '';
    const images: InlineImageAttachment[] = [];

    if (Array.isArray(m.parts)) {
      for (const p of m.parts) {
        if (typeof p === 'string' && p.trim()) {
          text += (text ? '\n' : '') + p.trim();
        } else if (p && typeof p.text === 'string' && p.text.trim()) {
          text += (text ? '\n' : '') + p.text.trim();
        } else if (p?.inlineData?.data && p?.inlineData?.mimeType) {
          images.push({
            mimeType: p.inlineData.mimeType,
            data: p.inlineData.data,
            dataUrl: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}`,
          });
        }
      }
    } else if (typeof m.content === 'string' && m.content.trim()) {
      text = m.content.trim();
    } else if (typeof m.text === 'string' && m.text.trim()) {
      text = m.text.trim();
    }

    // Also inspect attached imageDataUrl / attachments on message object
    if (typeof m.imageDataUrl === 'string') {
      const parsed = parseDataUrlToInlineImage(m.imageDataUrl);
      if (parsed) images.push(parsed);
    }
    if (Array.isArray(m.attachments)) {
      for (const att of m.attachments) {
        const parsed = parseDataUrlToInlineImage(att?.dataUrl || att);
        if (parsed) images.push(parsed);
      }
    }

    if (!text.trim()) {
      if (images.length > 0) {
        const hasPdf = images.some((img) => img.mimeType === 'application/pdf');
        const hasImage = images.some((img) => img.mimeType.startsWith('image/'));
        if (hasPdf && !hasImage) {
          text = 'Please read and analyze the attached PDF document and summarize or build what is requested.';
        } else {
          text = 'Please inspect the attached screenshot/design file and implement or fix what is shown.';
        }
      } else if (m.imageUrl) {
        text = `[Attached Image: ${m.imageUrl}]`;
      } else if (role === 'model') {
        text = 'Code and architecture implemented.';
      } else {
        text = 'Please proceed with implementation.';
      }
    }

    rawCleaned.push({ role, text: text.trim(), images });
  }

  if (rawCleaned.length === 0) {
    return {
      history: [],
      lastMessage: "Hello! Please assist me.",
      lastMessageImages: [],
    };
  }

  const lastTurn = rawCleaned.pop()!;
  let lastMessage = lastTurn.text;
  const lastMessageImages = [...lastTurn.images];

  const history: { role: 'user' | 'model'; parts: any[] }[] = [];

  for (const item of rawCleaned) {
    const parts: any[] = [{ text: item.text }];
    // Only attach inlineData for recent turns so history stays lean on free APIs
    if (history.length === 0) {
      history.push({ role: item.role, parts });
    } else {
      const prev = history[history.length - 1];
      if (prev.role === item.role) {
        prev.parts[0].text += '\n\n' + item.text;
      } else {
        history.push({ role: item.role, parts });
      }
    }
  }

  if (history.length > 0 && history[history.length - 1].role === 'user') {
    const trailingUser = history.pop()!;
    lastMessage = trailingUser.parts[0].text + '\n\n' + lastMessage;
  }

  if (history.length > 0 && history[0].role === 'model') {
    history.unshift({ role: 'user', parts: [{ text: 'Hello' }] });
  }

  return {
    history,
    lastMessage: lastMessage.trim() || 'Please proceed with the task.',
    lastMessageImages,
  };
}
