export interface SkillDefinition {
  name: string;
  category: 'design' | 'migration' | 'backend' | 'ai' | 'realtime' | 'spatial' | 'workflow';
  description: string;
  triggers: string[];
  instructions: string;
  compactInstructions?: string;
}

export const CODING_SKILLS_REGISTRY: SkillDefinition[] = [
  {
    name: 'frontend-design',
    category: 'design',
    description: 'Universal design constitution and domain-specific guidelines for production-grade websites, dashboards, e-commerce stores, portfolios, and games.',
    triggers: ['website', 'landing page', 'dashboard', 'ui', 'redesign', 'store', 'portfolio', 'game', 'saas', 'ecommerce', 'ওয়েবসাইট', 'ডিজাইন', 'ল্যান্ডিং'],
    instructions: `# Universal Frontend Design Constitution

1. Order of Resolution: Function (every button/tab/filter/form works) > Legibility & WCAG AA Contrast > Layout Integrity (desktop 1440px baseline + mobile 390px, zero overflow/clipping) > Spatial Math (outer padding >= child gap, 2x horizontal button padding) > Aesthetic Direction.
2. Top Bar 3-Zone Contract: Single row [1-line Brand wordmark] — [4-5 single-line nav links] — [1 primary CTA]. Keep all header items whitespace-nowrap shrink-0. Never crowd headers with taglines, status tickers, or dual CTA buttons.
3. Zero-Pill & Anti-Slop Discipline:
   - Never wrap static metadata (categories, dates, counts, tags) in rounded pill badges—render as clean unboxed inline text separated by "·" or "/". Reserve pill/tab styling strictly for interactive filter buttons.
   - Ban generic purple-indigo hero gradients, nested cards-within-cards, thick left accent borders (border-l-4), "// 01" comment prefixes, decorative pulsing green dots next to headings, and ghost watermark text behind headlines.
4. Typography & 2+1 Font Pairing:
   - Avoid lazy defaults (Inter, Roboto). Load real Google Fonts matching the domain:
     * SaaS / Fintech / Dashboard: Plus Jakarta Sans + DM Sans + JetBrains Mono (tabular-nums)
     * Editorial / Luxury / Portfolio: Playfair Display or Fraunces + Manrope or Source Serif 4
     * Agency / Brand Launch: Outfit or Bricolage Grotesque + DM Sans
     * Bengali / Bilingual Web App: Hind Siliguri + Plus Jakarta Sans
   - Use clamp(2.25rem, 4.5vw, 3.75rem) for hero titles, text-wrap: balance to prevent orphan words, and tabular-nums on all metrics/prices/tables.
5. Color & Imagery (60-30-10):
   - 60% clean neutral canvas, 30% subdued structural surfaces, 10% concentrated accent strictly on primary CTAs & active states.
   - Use \`fetch_stock_images\` (1 batch call, 0 Gemini image tokens) to download real stock photos locally into \`workspaces/<sessionId>/public/images/\` and reference them via \`./images/<file>\` for seed data, product catalogs, cards, galleries, and avatars. Reserve \`generate_image\` strictly for 1 bespoke hero/brand visual if needed (never fragile placeholder.com URLs). Apply gradient scrims (from-black/75 via-black/30) behind text over photography and provide styled fallback containers on <img> tags.
6. 100% Interactive Completeness:
   - Every nav link, category filter, search input, cart drawer, modal, tab switch, and contact/checkout form MUST run real JS state updates with user feedback.`,
    compactInstructions: `[COMPACT DESIGN RULES + 1-SHOT PATTERN]
- 3-Zone Header: [Brand] — [4 single-line links whitespace-nowrap] — [1 CTA]. Zero pills on static labels (use "·" separators). No border-l-4 or generic purple gradients.
- Fonts: Google Font in index.html (Plus Jakarta Sans / Hind Siliguri + JetBrains Mono), CSS uses \`@import "tailwindcss";\`.
- Media (0 Tokens): Call \`fetch_stock_images\` ONCE in batch for seed/card/product photos -> use returned \`./images/<file>\`. Never use placeholder.com or unverified external URLs.
- 100% Working State: every button/tab/filter/modal mutates React state + persists to localStorage.
Example Header+Grid:
\`\`\`tsx
<header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
  <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
    <span className="font-bold tracking-tight whitespace-nowrap shrink-0">Brand</span>
    <nav className="hidden md:flex items-center gap-6 text-sm">{tabs.map(t => <button key={t} onClick={() => setTab(t)} className="whitespace-nowrap">{t}</button>)}</nav>
    <button onClick={() => setOpen(true)} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white whitespace-nowrap shrink-0">Get Started</button>
  </div>
</header>
\`\`\``
  },
  {
    name: 'github-import-migration',
    category: 'migration',
    description: 'Execute-First migration protocol for cloning and booting GitHub repositories in Node.js 22 / Vite / Express on port 3000.',
    triggers: ['github', 'clone', 'repo', 'import', 'migrate', 'repository'],
    instructions: `# GitHub Import & Migration Skill
1. Triage & Clone:
   - Clone target repo using run_command ('git clone <url> <dir>') and inspect package.json + directory tree via view_file / list_dir.
2. Package Manager Normalization:
   - Remove bun.lock, yarn.lock, pnpm-lock.yaml; convert resolutions -> overrides; remove packageManager / preinstall scripts.
   - Install dependencies using install_applet_package or install_applet_dependencies (npm only).
3. Runtime & Port 3000 Constraints:
   - Ensure dev server binds to host '0.0.0.0' and port 3000.
   - Replace incompatible native addons (bcrypt -> bcryptjs, node-sass -> sass) and mock external DBs if offline.
4. Verification Loop:
   - Run compile_applet and lint_applet together, fix any missing imports or type errors, then call restart_dev_server.`,
    compactInstructions: `[COMPACT MIGRATION CHECKLIST]
- Call \`github_clone(repo, sessionId, autoStart: true)\` immediately for GitHub clones (do NOT rewrite from scratch).
- Verify live preview at \`/w/<sessionId>/\` via \`verify_live_preview\`; fix any missing packages via \`install_applet_package\`.`
  },
  {
    name: 'github-import-rewrite',
    category: 'migration',
    description: 'Cross-framework rewrite protocol when an imported project uses an unsupported runtime or mobile framework (Flutter, Python, Go, React Native).',
    triggers: ['rewrite', 'python', 'django', 'flask', 'fastapi', 'flutter', 'react-native', 'go'],
    instructions: `# GitHub Cross-Framework Rewrite Skill
1. Catalog core endpoints, data models, UI routes, and authentication flows from the source repo.
2. Target Stack: Vite + React + TypeScript + Tailwind CSS + Express (server.ts) on port 3000.
3. Reimplement core 3-5 workflows cleanly with in-memory or local persistence, verify with compile_applet + lint_applet.`
  },
  {
    name: 'gemini-api',
    category: 'ai',
    description: 'Coding patterns and model selection for @google/genai TypeScript SDK (streaming, function calling, structured output, image/audio).',
    triggers: ['gemini', 'genai', 'ai', 'llm', 'chatbot', 'streaming', 'function calling'],
    instructions: `# Gemini API (@google/genai) Skill
1. Always use the modern '@google/genai' SDK (never legacy '@google/generative-ai').
2. Keep GEMINI_API_KEY strictly server-side behind '/api/*' Express routes.
3. Use 'gemini-3.8-flash' (or 'gemini-3.1-flash-lite' for high-throughput) for text/multimodal/tool calling.
4. Sanitize chat turn alternation (user -> model -> user) and avoid empty text parts to prevent protobuf errors.`
  },
  {
    name: 'gemini-interactions-api',
    category: 'ai',
    description: 'Patterns for Deep Research agent, Omni models (video generation/editing), Live API real-time audio, and Lyria music generation.',
    triggers: ['interactions api', 'deep research', 'omni', 'live api', 'lyria', 'video generation'],
    instructions: `# Gemini Interactions API Skill
1. Use server-side proxy routes for Interactions API, Deep Research, and Omni video/multimodal workflows.
2. Stream progress events over SSE ('text/event-stream') to keep the frontend responsive during long-running tasks.`
  },
  {
    name: 'pwa-integration',
    category: 'workflow',
    description: 'Full Progressive Web App (PWA) compliance: manifest.webmanifest, Service Worker offline caching, icons, and install prompt.',
    triggers: ['pwa', 'offline', 'service worker', 'manifest', 'installable', 'mobile app'],
    instructions: `# PWA Integration Skill
1. Provide valid manifest.webmanifest (name, short_name, start_url, display: 'standalone', theme_color, 192x192 & 512x512 icons).
2. Register Service Worker (sw.js) with network-first for HTML documents and cache-first for static assets.
3. Listen for 'beforeinstallprompt' on window and provide a working Install App button + offline indicator.`
  },
  {
    name: 'applet-seo',
    category: 'design',
    description: 'Configures SEO meta tags, OpenGraph social cards, Twitter cards, canonical URLs, and Schema.org JSON-LD.',
    triggers: ['seo', 'meta', 'opengraph', 'og:', 'json-ld', 'schema.org', 'social card'],
    instructions: `# Applet SEO Skill
1. Sync <title>, <meta name="description">, og:title, og:description, og:type, twitter:card in index.html.
2. Add semantic HTML5 landmarks (<header>, <main>, <article>, <footer>) and JSON-LD structured data when building public web apps.`
  },
  {
    name: 'firebase-integration',
    category: 'backend',
    description: 'Autonomously designs firebase-blueprint.json, provisions Firebase Auth/Firestore/Storage via set_up_firebase, generates strict firestore.rules with RBAC & schema validation, and deploys rules via deploy_firebase.',
    triggers: ['firebase', 'firestore', 'auth', 'login', 'signup', 'rbac', 'rules', 'persistent database', 'user account', 'realtime', 'লগইন', 'ফায়ারবেস', 'ডাটাবেজ'],
    instructions: `# Autonomous Firebase & Firestore Integration Skill
1. **Schema-First Blueprint**: Design entities (requiredFields, allowedFields) and collections (path, entity, access: 'owner' | 'authenticated' | 'public_read_auth_write' | 'admin_only' | 'role_based', ownerField).
2. **Automatic Workspace Provisioning**: Call \`set_up_firebase\` with \`platform: 'web'\`, \`sessionId\`, and \`blueprint\`. This automatically:
   - Inherits the user's connected Nexus Firebase Config (if saved in Firebase Modal) OR scaffolds safe \`isFirebaseConfigured\` placeholders.
   - Writes \`firebase-blueprint.json\`, \`firebase-config.json\`, \`firebase-applet-config.json\`, \`firestore.rules\`, \`src/lib/firebase.ts\` (with \`db\`, \`auth\`, \`storage\`, \`signInWithGoogle\`, \`OperationType\`, \`handleFirestoreError\`, \`testFirestoreConnection\`), and \`src/components/FirebaseProvider.tsx\` (\`FirebaseProvider\`, \`useFirebase\`) inside the active session workspace.
3. **Security Hardening & Deployment**: Ensure \`firestore.rules\` enforces \`isAuthenticated()\`, \`isOwner()\`, \`isAdmin()\`, \`isValidId()\`, field validation, and default deny (\`match /{document=**} { allow read, write: if false; }\`). Call \`deploy_firebase\` to syntax-check, security-audit, and live-deploy rules to Firestore (when Service Account / token is connected).
4. **Frontend SDK Best Practices**:
   - Wrap the app in \`<FirebaseProvider>\` and gate Firestore listeners (\`onSnapshot\`) behind \`authReady && user\` so unauthenticated requests don't fail with permission errors.
   - Always pass an error callback to \`onSnapshot\` using \`handleFirestoreError(err, OperationType.LIST, path)\`.
   - When \`!isFirebaseConfigured\`, show a clean non-blocking setup notice ("Connect your Firebase config in the Firebase Modal 🔥 to go live") and keep UI interactive with graceful local preview state so the app never crashes.
   - Never expose Service Account keys or admin credentials in frontend code.`,
    compactInstructions: `[COMPACT FIREBASE 1-SHOT]
1. Call \`set_up_firebase(sessionId, platform: "web", blueprint: { entities: {...}, collections: [...] })\` + \`deploy_firebase(sessionId)\`.
2. Wrap \`src/App.tsx\` in \`<FirebaseProvider>\` from \`./components/FirebaseProvider\`.
3. Gate \`onSnapshot\` behind \`authReady && user\` and always include error callback \`(err) => handleFirestoreError(err, OperationType.LIST, path)\`.`
  },
  {
    name: 'cloudsql-setup',
    category: 'backend',
    description: 'PostgreSQL / Drizzle ORM schema design (src/db/schema.ts), relational modeling, and parameterized queries.',
    triggers: ['postgres', 'postgresql', 'sql', 'drizzle', 'relational', 'database', 'schema'],
    instructions: `# Cloud SQL / PostgreSQL & Drizzle Skill
1. Define normalized tables and foreign keys in 'src/db/schema.ts' using 'drizzle-orm/pg-core'.
2. Keep all DB connections and queries strictly on the server ('server.ts' / 'server/*'), never in browser code.
3. Always use parameterized Drizzle queries or prepared statements to prevent SQL injection.`
  },
  {
    name: 'cloudsql-execute-sql',
    category: 'backend',
    description: 'Executes SQL statements on the database instance for DQL/DML operations, seeding, data queries, and debugging.',
    triggers: ['execute sql', 'sql query', 'seed database', 'run query', 'query data', 'sql statement'],
    instructions: `# Cloud SQL Execute SQL Skill
1. Use 'cloudsql_execute_sql' for DQL/DML operations (SELECT, INSERT, UPDATE, DELETE).
2. Do not use for destructive DROP TABLE or DROP DATABASE operations.
3. Always verify table schema with 'src/db/schema.ts' before writing complex joins.`
  },
  {
    name: 'cloudsql-update-schema',
    category: 'backend',
    description: 'Updates and validates database schema in src/db/schema.ts and ensures type safety across queries.',
    triggers: ['update schema', 'drizzle schema', 'db migration', 'drizzle push', 'schema update'],
    instructions: `# Cloud SQL Update Schema Skill
1. Keep table definitions synchronized in 'src/db/schema.ts'.
2. Export all tables and relation schemas with strict TypeScript infer types.
3. Re-verify the app build with compile_applet and lint_applet after schema updates.`
  },
  {
    name: 'figma-import',
    category: 'design',
    description: 'Converts attached Figma designs, screenshots, or design tokens into production-ready React + Tailwind CSS code.',
    triggers: ['figma', 'figma design', 'import figma', 'figma.com', 'design mockup', 'design screenshot'],
    instructions: `# Figma Import Skill
1. Analyze color palette, typography hierarchy, responsive container widths, and grid layouts from Figma specs.
2. Port to clean React functional components using Tailwind CSS classes.
3. Ensure every button, input, drawer, and modal in the design has real interactive state.`
  },
  {
    name: 'focus-mode',
    category: 'workflow',
    description: 'Applies surgical edits to specific CSS selectors or selected UI components without modifying surrounding code.',
    triggers: ['focus mode', 'css selector', 'edit element', 'targeted edit', 'selected element', 'highlighted component'],
    instructions: `# Focus Mode Skill
1. When user selects a specific element (by CSS selector, ID, or class), locate its exact lines in the target file.
2. Use 'replace_file_content' to make a single contiguous edit to that component only.
3. Preserve all existing event handlers, state bindings, and props of surrounding sibling elements.`
  },
  {
    name: 'real-time-and-multi-user',
    category: 'realtime',
    description: 'Real-time WebSockets, SSE live sync, multiplayer game loops, and collaborative canvases.',
    triggers: ['websocket', 'realtime', 'multiplayer', 'chat', 'collaborative', 'live sync'],
    instructions: `# Real-Time & Multi-User Skill
1. Multiplex WebSockets on the same HTTP server on port 3000 (never open a separate port).
2. Keep authoritative state on the server and broadcast typed delta events to connected clients.`
  },
  {
    name: 'threejs',
    category: 'spatial',
    description: '3D WebGL scenes using Three.js, lighting, PBR materials, OrbitControls, shaders, and animation loops.',
    triggers: ['3d', 'threejs', 'three.js', 'webgl', 'shader', 'mesh', 'canvas 3d'],
    instructions: `# Three.js 3D Spatial Skill
1. Install 'three' and '@types/three' via install_applet_package before importing.
2. Configure WebGLRenderer with antialias, responsive ResizeObserver, ACESFilmicToneMapping, and dispose geometries/materials on unmount.`
  },
  {
    name: 'google-maps-platform',
    category: 'spatial',
    description: 'Interactive maps, geolocation, route planning, places search, and geocoding.',
    triggers: ['map', 'google maps', 'gps', 'location', 'coordinates', 'directions', 'routing'],
    instructions: `# Google Maps Platform Skill
1. Load Maps JS API safely with environment-configured key or Leaflet/OpenStreetMap fallback if key is absent.
2. Handle browser geolocation permission gracefully with manual coordinate/address fallback.`
  },
  {
    name: 'oauth-integration',
    category: 'backend',
    description: 'Third-party OAuth2 popup flows (GitHub, Discord, Spotify, Strava) compatible with iframe sandboxing.',
    triggers: ['oauth', 'third-party login', 'github login', 'spotify', 'discord'],
    instructions: `# Third-Party OAuth Skill
1. In iframe environments, open OAuth in a popup window and communicate completion back via 'window.opener.postMessage'.
2. Use 'SameSite=None; Secure' cookies and validate state parameter to prevent CSRF.`
  },
  {
    name: 'workspace-integration',
    category: 'backend',
    description: 'Google Workspace APIs (Drive, Docs, Sheets, Calendar, Gmail) using client-side OAuth tokens + Bearer headers.',
    triggers: ['google drive', 'google sheets', 'google calendar', 'gmail', 'google docs', 'workspace'],
    instructions: `# Google Workspace Integration Skill
1. Obtain Google Workspace access tokens client-side via OAuth2 token flow; never store client secrets in browser code.
2. Pass tokens to backend routes via 'Authorization: Bearer <token>' headers when server proxying is needed.`
  },
  {
    name: 'shadcn-ui',
    category: 'design',
    description: 'Composable accessible UI primitives with Tailwind CSS, Radix-style keyboard navigation, and clean token theming.',
    triggers: ['shadcn', 'radix', 'dialog', 'dropdown', 'popover', 'accessible ui'],
    instructions: `# shadcn/ui Component Skill
1. Build modular, accessible components using 'clsx' + 'tailwind-merge' ('cn()' helper in src/lib/utils.ts).
2. Support keyboard escape/focus handling on dialogs, drawers, and dropdown menus.`
  },
  {
    name: 'image-generation',
    category: 'ai',
    description: 'Zero-token batch stock photo fetching (fetch_stock_images) vs bespoke AI hero generation (generate_image) and inline SVGs.',
    triggers: ['image', 'illustration', 'banner', 'avatar', 'logo', 'icon', 'generate_image', 'fetch_stock_images', 'seed', 'stock'],
    instructions: `# Image Generation & Zero-Token Media Strategy Skill
1. For seed data, product catalogs, cards, galleries, blog thumbnails, and team avatars: ALWAYS call \`fetch_stock_images(items: [...], sessionId)\` in ONE batch call (0 Gemini image tokens, saves real stock photos into \`workspaces/<sessionId>/public/images/\` and returns \`./images/<file>\`).
2. Reserve \`generate_image\` strictly for 1 custom bespoke hero banner or brand artwork when stock photography isn't suitable.
3. Use Lucide icons or crisp inline SVGs for UI icons, badges, and vector logos.`
  },
  {
    name: 'planning-mode',
    category: 'workflow',
    description: 'Clarifying ambiguous user requests with ask_question and producing structured architectural implementation plans before coding.',
    triggers: ['plan', 'architecture', 'clarify', 'design first', 'spec'],
    instructions: `# Planning Mode & Focus Mode Skill
1. When requirements are ambiguous or multi-faceted, call 'ask_question' with concise plain-text questions and 2-6 short options.
2. Outline clear architectural decisions (files to create/edit, data models, verification steps) before writing code.
3. In Focus Mode (when a user targets a specific CSS selector or UI element), apply surgical edits via 'replace_file_content' without disturbing unrelated sections.`
  },
  {
    name: 'system-instructions-persona',
    category: 'workflow',
    description: 'Enforces a dedicated Developer Persona, target programming language (React, Node.js, Python, TypeScript), and strict coding standards.',
    triggers: ['persona', 'system instruction', 'typescript', 'python', 'react', 'nodejs', 'coding standard'],
    instructions: `# System Instructions & Developer Persona Skill
1. Adopt the active Developer Persona (e.g., Senior Full-Stack TypeScript/React, Node.js Backend Architect, Python Specialist).
2. Enforce clean modular architecture, strict TypeScript types, top-level imports, and idiomatic framework patterns.
3. Respect user-defined Custom System Instructions across all generated code, tool calls, and explanations.`
  },
  {
    name: 'structured-code-output',
    category: 'design',
    description: 'Formats generated code cleanly into fenced Markdown language blocks or strict JSON schemas.',
    triggers: ['json', 'markdown', 'format', 'schema', 'structured output', 'code block'],
    instructions: `# Structured Code Output Skill
1. Always wrap generated code in explicit language-tagged Markdown fences (\`\`\`tsx, \`\`\`ts, \`\`\`python, \`\`\`json, \`\`\`html) with clear file path headers.
2. When Structured JSON output is requested, return strictly valid JSON matching the requested schema without trailing prose.`
  },
  {
    name: 'multi-file-context-diff',
    category: 'migration',
    description: 'Reads multiple workspace files together, tracks line-by-line diffs, and preserves cross-file consistency.',
    triggers: ['multi-file', 'diff', 'compare', 'refactor', 'context', 'cross-file'],
    instructions: `# Multi-File Context & Diff Management Skill
1. Use 'read_multiple_files' or 'view_file' to load related frontend, backend, and type definition files before making cross-file edits.
2. Use 'compute_file_diff' or 'git_diff' to verify exact line changes and ensure imports, types, and API contracts stay synchronized.`
  },
  {
    name: 'debugging-error-analysis',
    category: 'workflow',
    description: 'Analyzes stack traces, compiler/lint logs, and runtime failures to diagnose root causes and apply verified fixes.',
    triggers: ['debug', 'error', 'bug', 'fix', 'stack trace', 'crash', 'exception', 'tsc'],
    instructions: `# Debugging & Error Analysis Skill
1. Call 'debug_error_analysis' to collect TypeScript/build diagnostics and inspect failing files.
2. Reproduce or verify logic inside 'code_execution_sandbox' when helpful.
3. Apply targeted surgical fixes via 'replace_file_content', then re-verify with 'compile_applet' and 'lint_applet'.`,
    compactInstructions: `[COMPACT DEBUG LOOP]
1. Call \`targeted_error_context\` (or \`debug_error_analysis\`) to get exact ±20 line error slices — do NOT read entire 500-line files blindly.
2. For full-stack bugs, call \`api_contract_checker\` to detect frontend/backend endpoint mismatches.
3. Patch with \`replace_file_content\` and re-run \`compile_applet\` + \`lint_applet\`.`
  },
  {
    name: 'ultraworkers-claw-harness',
    category: 'workflow',
    description: 'UltraWorkers Claw CLI agent harness integrating file operations, glob/grep search, shell execution, claw doctor, claw acp, claw prompt, and claw status.',
    triggers: ['claw', 'ultraworkers', 'harness', 'claw doctor', 'claw acp', 'claw status', 'claw prompt'],
    instructions: `# UltraWorkers Claw Code Harness Skill
1. Core Capabilities:
   - File Operations: view_file, write_to_file, replace_file_content, delete_file, move, list_dir.
   - Search: grep_search, find_by_name.
   - Shell Execution: run_command, manage_task, code_execution_sandbox.
2. Claw CLI Commands:
   - claw_doctor: Full local environment, configuration, and API connectivity health check.
   - claw_status: Session, loaded skills, background tasks, and memory status inspector.
   - claw_acp: Agent Client Protocol capability and session handshake manager.
   - claw_prompt: Structured task execution harness with configurable agent parameters.
3. Local OpenAI-Compatible & Custom Provider Setup:
   - Works seamlessly with Google Gemini, OpenRouter, Groq, Cerebras, Mistral, and local OpenAI-compatible endpoints.`
  },
  {
    name: 'omo-multi-agent-coordination',
    category: 'workflow',
    description: 'OmO (oh-my-openagent) multi-agent coordination layer with specialized Architect, Executor, and Reviewer sub-agents, automated handoffs, and verification loops.',
    triggers: ['omo', 'oh-my-openagent', 'multi-agent', 'handoff', 'architect', 'executor', 'reviewer', 'consensus'],
    instructions: `# OmO (oh-my-openagent) Multi-Agent Coordination Skill
1. Sub-Agent Specialization:
   - Architect: Decomposes tasks, designs system architecture, defines API contracts, schemas, and file boundaries.
   - Executor: Implements files, writes code, manages dependencies, and applies surgical refactors.
   - Reviewer: Validates code quality, runs verification tools (tsc, lint, build), checks edge-cases, and tests in sandbox.
2. Automated Handoffs & Consensus:
   - Call 'omo_coordinate' to orchestrate handoffs between Architect -> Executor -> Reviewer.
   - Resolve disagreements via consensus voting and persist verified outputs.`
  },
  {
    name: 'omx-structured-execution',
    category: 'workflow',
    description: 'OmX (oh-my-codex) workflow and orchestration layer that translates high-level prompts into structured execution protocols with phased workstreams and verification.',
    triggers: ['omx', 'oh-my-codex', 'protocol', 'staged execution', 'parallel workstream', 'verification loop'],
    instructions: `# OmX (oh-my-codex) Structured Execution Skill
1. Protocol Transformation:
   - Call 'omx_protocol' to translate human instructions into a 3-phase execution blueprint:
     * Phase 1: Problem Decomposition & Invariants Definition.
     * Phase 2: Parallel / Staged Workstream Execution Plan.
     * Phase 3: Persistent Verification Loop (tsc --noEmit, npm run build, runtime sandbox).
2. Execute workstreams sequentially or in parallel while maintaining strict cross-file type consistency.`
  },
  {
    name: 'clawhip-event-routing',
    category: 'workflow',
    description: 'ClawHip out-of-band event and notification router for Git commits, background tasks, GitHub issues & PRs, and agent milestones outside primary LLM context.',
    triggers: ['clawhip', 'event router', 'notification', 'git commit event', 'lifecycle', 'background event'],
    instructions: `# ClawHip Event & Notification Router Skill
1. Out-of-Band Routing:
   - Track background events (git commits, task completions, test results, PRs) via 'clawhip_router'.
   - Keep event logs out of the primary LLM context window to prevent context bloat and distraction.
2. Query event streams on demand when diagnosing regressions or verifying milestones.`
  },
  {
    name: 'ui-cookbook',
    category: 'design',
    description: 'Golden React 19 + Tailwind v4 component snippets (Navbar+Drawer, KPI Grid, Filterable Cards, Accessible Modal, Validated Form) to prevent broken layouts on free models.',
    triggers: ['cookbook', 'component', 'navbar', 'modal', 'drawer', 'table', 'form', 'card', 'tailwind', 'snippet', 'ui'],
    instructions: `# UI Cookbook — Golden React 19 + Tailwind v4 Snippets

1. **CSS Entry (Tailwind v4)**:
\`\`\`css
@import "tailwindcss";
@layer base { body { @apply bg-slate-50 text-slate-900 antialiased; } }
\`\`\`

2. **Responsive 3-Zone Navbar + Mobile Drawer**:
\`\`\`tsx
export function Navbar({ pages, activePage, onNavigate, ctaLabel, onCta }: any) {
  const [mobileOpen, setMobileOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
        <span className="text-lg font-bold tracking-tight whitespace-nowrap shrink-0">Studio</span>
        <nav className="hidden md:flex items-center gap-6">
          {pages.map((p: string) => (
            <button key={p} onClick={() => onNavigate(p)} className={\`text-sm font-medium whitespace-nowrap \${activePage === p ? 'text-slate-900' : 'text-slate-500 hover:text-slate-900'}\`}>{p}</button>
          ))}
        </nav>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={onCta} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white whitespace-nowrap">{ctaLabel}</button>
          <button onClick={() => setMobileOpen(!mobileOpen)} className="md:hidden p-2 rounded-lg border border-slate-200" aria-label="Menu">☰</button>
        </div>
      </div>
      {mobileOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white px-4 py-3 flex flex-col gap-2">
          {pages.map((p: string) => (
            <button key={p} onClick={() => { onNavigate(p); setMobileOpen(false); }} className="text-left py-1.5 text-sm font-medium">{p}</button>
          ))}
        </div>
      )}
    </header>
  );
}
\`\`\`

3. **Accessible Modal / Slide-over Drawer**:
\`\`\`tsx
{isOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
    <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">{title}</h3>
        <button onClick={onClose} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">✕</button>
      </div>
      {children}
    </div>
  </div>
)}
\`\`\`

4. **KPI Strip & Tabular Metrics**:
- Always use \`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4\` and \`tabular-nums\` on numbers.

5. **Pre-Built UI Primitives Kit (ALREADY IN \`src/components/ui/\`)**:
- Save ~40% tokens! Do NOT rewrite Modal/Drawer/Button/Toast/DataTable from scratch—import directly:
  \`import { Button, Badge, Modal, Drawer, Tabs, DataTable, ToastProvider, useToast } from '../components/ui';\`
  \`import { cn } from '../lib/utils';\``,
    compactInstructions: `[UI COOKBOOK + PRE-BUILT KIT]
- Import ready components from \`./components/ui\` (\`Button, Badge, Modal, Drawer, Tabs, DataTable, ToastProvider, useToast\`) & \`cn\` from \`./lib/utils\`—do NOT rewrite boilerplate modals/drawers/tables!
- CSS: \`@import "tailwindcss";\` (Tailwind v4). Numbers: \`tabular-nums\`. Static meta: \`Cat · $29\`.`
  },
  {
    name: 'motion-video-studio',
    category: 'design',
    description: 'Compact Remotion-style programmatic animation & WebM video exporter using HTML5 Canvas + motion/react + MediaRecorder (works 100% on free LLMs with 0 external video APIs).',
    triggers: ['animation', 'video', 'motion', 'reel', 'explainer', 'timeline', 'keyframe', 'এনিমেশন', 'ভিডিও', 'মোশন'],
    instructions: `# Programmatic Animation & Video Export Skill (Free Models / Zero Video API Cost)
1. **Architecture**: Text LLMs cannot output raw MP4 pixels directly, so build a **Scene-Timeline Motion Studio** inside React:
   - Define structured \`scenes[]\` (durationSec, title, subtitle, bgGradient, accent, animationStyle: 'kinetic' | 'chart' | 'showcase') and a real playback loop (\`requestAnimationFrame\`).
   - Draw crisp 1280x720 (or 1080x1920 Shorts/Reels) frames on HTML5 \`<canvas>\` with eased keyframes (cubic/spring), particle backdrops, typography reveal, and progress bars.
   - Provide **Play / Pause / Scrub Timeline / Scene Editor / Export Video (.webm)** using \`canvas.captureStream(60)\` + \`MediaRecorder(stream, { mimeType: 'video/webm' })\` to record & download a real playable video file!
2. Use \`motion/react\` (already installed) for interactive UI timeline controls & scene cards.`,
    compactInstructions: `[COMPACT MOTION VIDEO STUDIO PATTERN]
- Build a Scene-Timeline Studio in React: \`scenes[]\` + \`requestAnimationFrame\` driving a 1280x720 \`<canvas>\` with eased keyframes + Scrubbing Timeline + Scene Editor.
- Real Video Download (0 API cost):
\`\`\`ts
const stream = canvas.captureStream(60);
const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
const chunks: Blob[] = [];
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
rec.onstop = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })); a.download = 'animation.webm'; a.click(); };
rec.start();
\`\`\``
  }
];

export function getSkillByName(name: string): SkillDefinition | undefined {
  const normalized = (name || '').trim().toLowerCase();
  return CODING_SKILLS_REGISTRY.find(
    s => s.name.toLowerCase() === normalized || s.name.toLowerCase().includes(normalized)
  );
}

export function listAllSkillsSummary(): Array<{ name: string; category: string; description: string; triggers: string[] }> {
  return CODING_SKILLS_REGISTRY.map(({ name, category, description, triggers }) => ({
    name,
    category,
    description,
    triggers
  }));
}
