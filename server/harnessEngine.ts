import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { builtinModules } from 'module';
import { DatabaseSync } from 'node:sqlite';
import { transformSync } from 'esbuild';
import { rankAstContext } from './astContextRanker.ts';
import { buildCodebaseGraph } from './workspaceEngine.ts';
import { isPlaceholderValue, loadFirebaseProfile } from './firebaseProvisioner.ts';

const execPromise = promisify(exec);

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith('node:') ? m : `node:${m}`)),
]);

export interface GuardrailResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface ErrorKbEntry {
  id: string;
  pattern: string;
  fixHint: string;
  hits: number;
  updatedAt: number;
}

const DEFAULT_ERROR_KB: Array<{ id: string; pattern: string; fixHint: string }> = [
  {
    id: 'kb_tailwind_v4',
    pattern: 'tailwind|@apply|unknown at rule|postcss',
    fixHint: 'Tailwind v4 uses `@import "tailwindcss";` in CSS. Avoid `@tailwind base/components/utilities` or legacy v3 config assumptions.',
  },
  {
    id: 'kb_ts_import_ext',
    pattern: 'Cannot find module|TS2307|ERR_MODULE_NOT_FOUND|allowImportingTsExtensions',
    fixHint: 'Verify exact relative import path and file extension; in server/ TypeScript files use `.ts` extensions on relative imports, and ensure third-party packages exist in package.json.',
  },
  {
    id: 'kb_jsx_unclosed',
    pattern: 'Unexpected token|Expected corresponding JSX closing tag|Unterminated|JSX element',
    fixHint: 'Ensure every JSX tag is properly closed, fragments (`<>...</>`) wrap adjacent siblings, and no partial snippet was truncated.',
  },
  {
    id: 'kb_react_hooks',
    pattern: 'Invalid hook call|Rendered more hooks|useEffect|useState is not defined',
    fixHint: 'Import hooks explicitly from `react` and call them only at the top level of React function components (never inside loops/conditions).',
  },
  {
    id: 'kb_empty_root_html',
    pattern: 'emptyRootDetected|TRUNCATED_HTML|missing closing',
    fixHint: 'Complete the full HTML document through `</body></html>`, wrap DOM scripts in `DOMContentLoaded` or place at the end of `<body>`, and ensure `#root`/`#app` renders real visible content.',
  },
  {
    id: 'kb_express_listen',
    pattern: 'EADDRINUSE|Cannot GET|404|express',
    fixHint: 'Mount all `/api/*` routes BEFORE static/Vite SPA fallback middleware and bind servers to `0.0.0.0` on the configured port.',
  },
];

let kbInitialized = false;

function getKbDb(): DatabaseSync {
  const dbPath = path.resolve(process.cwd(), '.nexus_local.db');
  const db = new DatabaseSync(dbPath);
  if (!kbInitialized) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS nexus_error_kb (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        fix_hint TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `);
    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM nexus_error_kb`).get() as { c?: number } | undefined;
    if (!countRow || Number(countRow.c || 0) === 0) {
      const insert = db.prepare(
        `INSERT OR IGNORE INTO nexus_error_kb (id, pattern, fix_hint, hits, updated_at) VALUES (?, ?, ?, 1, ?)`
      );
      const now = Date.now();
      for (const item of DEFAULT_ERROR_KB) {
        insert.run(item.id, item.pattern, item.fixHint, now);
      }
    }
    kbInitialized = true;
  }
  return db;
}

export function lookupErrorKnowledgeBase(errorText: string): string[] {
  if (!errorText || !errorText.trim()) return [];
  try {
    const db = getKbDb();
    try {
      const rows = db.prepare(`SELECT id, pattern, fix_hint, hits FROM nexus_error_kb ORDER BY hits DESC, updated_at DESC LIMIT 60`).all() as Array<{
        id: string;
        pattern: string;
        fix_hint: string;
        hits: number;
      }>;
      const lower = errorText.toLowerCase();
      const matched: string[] = [];
      for (const row of rows) {
        const tokens = row.pattern
          .split('|')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        if (tokens.some((t) => lower.includes(t))) {
          matched.push(row.fix_hint);
        }
        if (matched.length >= 4) break;
      }
      return matched;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function recordErrorFixResolution(errorSummary: string, fixSummary: string): void {
  const cleanErr = (errorSummary || '').trim();
  const cleanFix = (fixSummary || '').trim();
  if (cleanErr.length < 8 || cleanFix.length < 8) return;

  // Extract meaningful tokens for pattern matching
  const tokens = Array.from(
    new Set(
      cleanErr
        .replace(/[^\w\s/-]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !/^(error|failed|line|file|from|with|that|this|your|recent)$/i.test(w))
    )
  ).slice(0, 5);
  if (tokens.length === 0) return;

  const pattern = tokens.join('|');
  const id = `kb_${tokens.join('_').toLowerCase().slice(0, 48)}`;

  try {
    const db = getKbDb();
    try {
      const existing = db.prepare(`SELECT id, hits FROM nexus_error_kb WHERE id = ?`).get(id) as { id: string; hits: number } | undefined;
      if (existing) {
        db.prepare(`UPDATE nexus_error_kb SET fix_hint = ?, hits = ?, updated_at = ? WHERE id = ?`).run(
          cleanFix.slice(0, 320),
          existing.hits + 1,
          Date.now(),
          id
        );
      } else {
        db.prepare(
          `INSERT INTO nexus_error_kb (id, pattern, fix_hint, hits, updated_at) VALUES (?, ?, ?, 1, ?)`
        ).run(id, pattern, cleanFix.slice(0, 320), Date.now());
      }
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal persistence failure
  }
}

async function loadPackageDependencySet(relativePath: string): Promise<Set<string> | null> {
  const cleanRel = relativePath.replace(/^\/+/, '');
  const wsMatch = cleanRel.match(/^workspaces\/([^/]+)\//);
  const rootPkgPath = path.resolve(process.cwd(), 'package.json');
  const pkgPaths = wsMatch
    ? [path.resolve(process.cwd(), 'workspaces', wsMatch[1], 'package.json'), rootPkgPath]
    : [rootPkgPath];

  const deps = new Set<string>();
  let loadedAny = false;
  for (const pkgPath of pkgPaths) {
    try {
      const raw = await fs.readFile(pkgPath, 'utf-8');
      const parsed = JSON.parse(raw);
      loadedAny = true;
      for (const name of [
        ...Object.keys(parsed.dependencies || {}),
        ...Object.keys(parsed.devDependencies || {}),
        ...Object.keys(parsed.peerDependencies || {}),
      ]) {
        deps.add(name);
      }
    } catch {}
  }
  return loadedAny ? deps : null;
}

function extractBarePackageImports(code: string): string[] {
  const packages = new Set<string>();
  const importRegex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(code)) !== null) {
    const spec = (m[1] || '').trim();
    if (!spec) continue;
    if (
      spec.startsWith('.') ||
      spec.startsWith('/') ||
      spec.startsWith('@/') ||
      spec.startsWith('~/') ||
      spec.startsWith('http://') ||
      spec.startsWith('https://') ||
      spec.startsWith('virtual:')
    ) {
      continue;
    }
    if (NODE_BUILTINS.has(spec)) continue;
    const pkgName = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    if (pkgName) packages.add(pkgName);
  }
  return Array.from(packages);
}

// Deterministic Pre-Write Auto-Repair: fixes common free-model slips (Tailwind v3 directives, missing React hook imports, missing .ts server imports) without wasting an LLM retry
export async function applyDeterministicPreWriteRepairs(
  relativePath: string,
  content: string
): Promise<{ content: string; repairsApplied: string[] }> {
  let out = content;
  const repairsApplied: string[] = [];
  const cleanRel = relativePath.replace(/^\/+/, '');
  const ext = path.extname(cleanRel).toLowerCase();

  // 1. Tailwind v3 directives -> Tailwind v4 `@import "tailwindcss";`
  if (ext === '.css' && /@tailwind\s+(?:base|components|utilities)\s*;/i.test(out)) {
    const stripped = out
      .replace(/@tailwind\s+base\s*;\s*/gi, '')
      .replace(/@tailwind\s+components\s*;\s*/gi, '')
      .replace(/@tailwind\s+utilities\s*;\s*/gi, '');
    out = /@import\s+["']tailwindcss["']\s*;/i.test(stripped)
      ? stripped
      : `@import "tailwindcss";\n${stripped.trimStart()}`;
    repairsApplied.push('Converted legacy @tailwind directives to Tailwind v4 `@import "tailwindcss";`');
  }

  // 2. Missing React hook imports in .ts/.tsx/.jsx
  if (['.tsx', '.ts', '.jsx'].includes(ext) && /(?:^|\/)src\//i.test(cleanRel)) {
    const hooks = ['useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext', 'useReducer'];
    const usedHooks = hooks.filter((h) => new RegExp(`\\b${h}\\s*\\(`).test(out));
    if (usedHooks.length > 0) {
      const reactImportMatch = out.match(/import\s+(?:React\s*,\s*)?\{([^}]*)\}\s+from\s+['"]react['"]\s*;?/);
      const defaultReactOnly = out.match(/import\s+React\s+from\s+['"]react['"]\s*;?/);
      const typeOnlyReact = /import\s+type\s+/.test(reactImportMatch?.[0] || '');

      if (reactImportMatch && !typeOnlyReact) {
        const existingNamed = reactImportMatch[1]
          .split(',')
          .map((s) => s.trim().split(/\s+as\s+/)[0])
          .filter(Boolean);
        const missing = usedHooks.filter(
          (h) => !existingNamed.includes(h) && !new RegExp(`React\\.${h}\\b`).test(out)
        );
        if (missing.length > 0) {
          const merged = [...existingNamed, ...missing].join(', ');
          const replacement = reactImportMatch[0].replace(`{${reactImportMatch[1]}}`, `{ ${merged} }`);
          out = out.replace(reactImportMatch[0], replacement);
          repairsApplied.push(`Auto-imported React hook(s): ${missing.join(', ')}`);
        }
      } else if (defaultReactOnly && !reactImportMatch) {
        const missing = usedHooks.filter((h) => !new RegExp(`React\\.${h}\\b`).test(out));
        if (missing.length > 0) {
          out = out.replace(defaultReactOnly[0], `import React, { ${missing.join(', ')} } from 'react';`);
          repairsApplied.push(`Auto-imported React hook(s): ${missing.join(', ')}`);
        }
      } else if (!/from\s+['"]react['"]/.test(out)) {
        const missing = usedHooks.filter((h) => !new RegExp(`React\\.${h}\\b`).test(out));
        if (missing.length > 0) {
          out = `import { ${missing.join(', ')} } from 'react';\n${out}`;
          repairsApplied.push(`Added missing react import for: ${missing.join(', ')}`);
        }
      }
    }
  }

  // 3. Server ESM TypeScript relative imports missing `.ts` extension (root server/ files)
  if (ext === '.ts' && (cleanRel.startsWith('server/') || cleanRel === 'server.ts')) {
    const fileDir = path.dirname(path.resolve(process.cwd(), cleanRel));
    const importMatches = Array.from(out.matchAll(/(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g));
    for (const m of importMatches) {
      const spec = m[2];
      if (/\.(ts|tsx|js|jsx|mjs|json|css)$/i.test(spec)) continue;
      const candidateTs = path.resolve(fileDir, `${spec}.ts`);
      const exists = await fs.access(candidateTs).then(() => true).catch(() => false);
      if (exists) {
        out = out.replace(m[0], `${m[1]}${spec}.ts${m[3]}`);
        repairsApplied.push(`Appended .ts extension to server ESM import: ${spec}`);
      }
    }
  }

  return { content: out, repairsApplied };
}

// Pre-Write Static Guardrails: validates syntax, placeholders, missing packages, and HTML completeness BEFORE writing to disk
export async function validatePreWriteGuardrails(
  relativePath: string,
  content: string,
  options: { isAppend?: boolean; isFullFile?: boolean } = {}
): Promise<GuardrailResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const cleanRel = relativePath.replace(/^\/+/, '');
  const ext = path.extname(cleanRel).toLowerCase();

  if (options.isAppend) {
    return { ok: true, errors, warnings };
  }

  // 1. Lazy placeholder / truncated stub detection on code files
  if (['.ts', '.tsx', '.js', '.jsx', '.css', '.html'].includes(ext) && content.split('\n').length > 12) {
    const placeholderPatterns = [
      /\/\/\s*\.\.\.\s*(?:existing|rest\s+of|remaining|other|more)\s+(?:code|lines|implementation|components|styles)/i,
      /\/\*\s*\.\.\.\s*(?:existing|rest\s+of|remaining)\s+(?:code|styles)\s*\*\//i,
      /\{\s*\/\*\s*\.\.\.\s*(?:rest\s+of|remaining|existing)\s+[\w\s]*\*\/\s*\}/i,
      /<!--\s*\.\.\.\s*(?:rest\s+of|remaining|existing)\s+[\w\s]*-->/i,
    ];
    for (const pat of placeholderPatterns) {
      if (pat.test(content)) {
        errors.push(
          `Lazy placeholder detected (${pat.source}). Write the COMPLETE implementation without "// ... existing code" or "// ... remaining" stubs.`
        );
        break;
      }
    }
  }

  // 2. JSON syntax validation
  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (err: any) {
      errors.push(`Invalid JSON in /${cleanRel}: ${err?.message || 'Parse error'}`);
    }
  }

  // 3. Real AST syntax validation via esbuild for JS/TS/JSX/TSX
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    const loader = ext.slice(1) as 'ts' | 'tsx' | 'js' | 'jsx';
    try {
      transformSync(content, {
        loader,
        jsx: 'automatic',
        logLevel: 'silent',
      });
    } catch (err: any) {
      const firstErr = Array.isArray(err?.errors) && err.errors[0]
        ? `${err.errors[0].text} (line ${err.errors[0].location?.line || '?'}, col ${err.errors[0].location?.column || '?'})`
        : err?.message || 'Syntax error';
      errors.push(`Syntax error in /${cleanRel}: ${firstErr}`);
    }

    // 4. Verify third-party package imports exist in package.json (skip server/test scripts if needed, check project code)
    if (cleanRel.startsWith('src/') || cleanRel.startsWith('server/') || cleanRel.startsWith('workspaces/')) {
      const installedDeps = await loadPackageDependencySet(cleanRel);
      if (installedDeps) {
        const importedPkgs = extractBarePackageImports(content);
        const missing = importedPkgs.filter((p) => !installedDeps.has(p));
        if (missing.length > 0) {
          errors.push(
            `Uninstalled package import(s) in /${cleanRel}: [${missing.join(', ')}]. Call install_applet_package(PackageNames: ${JSON.stringify(missing)}) first, or use already installed packages (e.g. lucide-react, motion, native HTML5 Drag & Drop).`
          );
        }
      }
    }
  }

  // 5. Block single-file Track-A website dumps into projects/*.html — Nexus ONLY builds large modular websites in workspaces/<sessionId>/
  if (/^projects\/.+\.html$/i.test(cleanRel) || cleanRel === 'projects/index.html') {
    errors.push(
      `Single-file HTML websites in /${cleanRel} are disabled. Nexus ONLY builds large modular multi-file websites inside workspaces/<sessionId>/. Call workspace_init first, then build 10-15+ modular files (src/types.ts, src/data/, src/components/*.tsx, src/pages/*.tsx, src/App.tsx) and run workspace_run(action: "start").`
    );
  }

  // 6. Monolithic App.tsx anti-dump guard: prevent 380+ line single-file React dumps without modular imports
  if (/(?:^|\/)src\/App\.tsx$/i.test(cleanRel)) {
    const lineCount = content.split('\n').length;
    const hasModularImports = /from\s+['"]\.\/(?:components|pages|data|hooks|lib|types)\b/i.test(content);
    if (lineCount > 380 && !hasModularImports) {
      errors.push(
        `Monolithic App.tsx rejected (${lineCount} lines with no modular imports). Split large apps into 10-15+ small focused files under src/types.ts, src/data/, src/hooks/, src/components/, src/pages/, and server/routes.ts.`
      );
    }
  }

  // 7. Full HTML document completeness check (only when writing complete HTML files)
  if (ext === '.html' && options.isFullFile !== false && /<html[\s>]/i.test(content)) {
    if (!/<\/html>/i.test(content)) {
      warnings.push(`HTML file /${cleanRel} is missing closing </html> tag — make sure to complete it or append remaining markup.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function isGitHubClonePrompt(promptText: string): boolean {
  const lower = (promptText || '').toLowerCase();
  return /(?:gh\s+repo\s+clone|git\s+clone|github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+|(?:clone|import|ক্লোন|ইমপোর্ট).*(?:repo|repository|github|রিপো|প্রিভিউ)|(?:repo|repository|রিপো).*(?:clone|ক্লোন))/i.test(lower);
}

export function isExplicitFirebasePrompt(promptText: string): boolean {
  return /(?:firebase|firestore|firebaseConfig|ফায়ারবেস|ফায়ারবেস)/i.test(promptText || '');
}

export function shouldUseModularArchitecture(promptText: string): boolean {
  const lower = (promptText || '').toLowerCase();
  if (isGitHubClonePrompt(promptText) || /(server\/|src\/|package\.json|apiOrchestrator|GoogleAIStudioCoderView)/i.test(lower)) return false;
  const isNewAppCreation = /(build|create|make|design|develop|website|web\s*app|landing\s*page|dashboard|saas|store|shop|ecommerce|e-commerce|portfolio|crm|erp|lms|portal|platform|site|game|arcade|বানা|তৈরি|ওয়েবসাইট|ওয়েবসাইট|সাইট|ড্যাশবোর্ড|ই-কমার্স|পোর্টফোলিও|গেম|প্ল্যাটফর্ম|পোর্টাল)/i.test(lower);
  const isTargetedEditOrFix = /^(?:fix|debug|edit|update|modify|refactor|add\s+a?\s*feature|ঠিক|ফিক্স|এডিট|আপডেট|যুক্ত)/i.test(lower.trim()) && !/(website|landing|store|dashboard|new\s+app|নতুন\s*অ্যাপ|ওয়েবসাইট|ওয়েবসাইট)/i.test(lower);
  if (isTargetedEditOrFix) return false;
  return isNewAppCreation;
}

export async function isFreshGreenfieldWebsiteBuild(promptText: string, sessionId?: string): Promise<boolean> {
  if (!shouldUseModularArchitecture(promptText)) return false;
  const safeId = (sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');
  const wsSrcExists = await fs
    .access(path.resolve(process.cwd(), 'workspaces', safeId, 'src'))
    .then(() => true)
    .catch(() => false);
  return !wsSrcExists;
}

// Verified Scaffold & Pattern Library: deterministic architectural blueprints so models don't improvise broken or small file structures
export function getVerifiedScaffoldBlueprint(promptText: string, sessionId?: string): string | null {
  const lower = (promptText || '').toLowerCase();
  if (!lower.trim()) return null;

  const safeId = (sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');

  if (isGitHubClonePrompt(promptText)) {
    return `[GITHUB REPO CLONE & SANDBOX PREVIEW WORKFLOW]:
- The user wants to clone a GitHub repository and run/view it in Live Preview. Do NOT rewrite the project from scratch!
- Note: \`gh\` CLI is not installed in the container, so ALWAYS use \`github_clone(repo: "<owner/repo or URL>", sessionId: "${safeId}", autoStart: true)\` (or \`run_command\` with \`git clone\`, which also auto-translates \`gh repo clone\`).
- \`github_clone\` automatically clones into \`workspaces/${safeId}/\`, removes incompatible lockfiles, links/installs npm dependencies, configures Vite/Express for \`/w/${safeId}/\`, and boots the live preview server.
- After \`github_clone\`, inspect key files if needed, verify with \`verify_live_preview(targetUrl: "/w/${safeId}/")\`, and report the cloned files & live preview status.`;
  }

  const isBuild = shouldUseModularArchitecture(promptText) || /(build|create|make|design|develop|app|website|dashboard|saas|store|ecommerce|e-commerce|portfolio|landing|auth|login|api|বানা|তৈরি|ওয়েবসাইট|ওয়েবসাইট|সাইট|ড্যাশবোর্ড|ই-কমার্স)/i.test(lower);
  if (!isBuild) return null;

  const wantsFirebase = isExplicitFirebasePrompt(promptText);
  const needsExpressBackend = !wantsFirebase && /(full-?stack|express|postgres|sqlite|drizzle|rest\s*api|ফুল-স্ট্যাক|ব্যাকএন্ড\s*সার্ভার)/i.test(lower);
  const modular = shouldUseModularArchitecture(promptText);
  const firebaseStep = wantsFirebase
    ? `\n  3) Call \`set_up_firebase(sessionId: "${safeId}", platform: "web", blueprint: {...})\` with complete domain entities, collections, and access rules (\`owner\`, \`authenticated\`, \`public_read_auth_write\`, \`role_based\`) matching the user prompt & \`src/types.ts\` (follow [SAVED FIREBASE CONFIG DETECTED] or [FIREBASE SDK SETUP UI REQUIRED] below), then call \`deploy_firebase(sessionId: "${safeId}")\` to write/audit/deploy \`firestore.rules\`.`
    : `\n  3) [UI/UX ONLY — NO FIREBASE]: Do NOT load \`firebase-integration\`, do NOT call \`set_up_firebase\` or \`deploy_firebase\`, and do NOT install \`firebase\`. Starter workspaces already link \`react\`, \`react-dom\`, \`lucide-react\`, \`clsx\`, \`tailwind-merge\`, \`motion\`, \`express\`, \`cors\`, \`vite\`, \`@vitejs/plugin-react\`, \`@tailwindcss/vite\` — do NOT run \`npm install\` for already-installed packages.`;

  const previewRunInstr = needsExpressBackend
    ? `\`workspace_run(action: "start")\` -> live at \`/w/${safeId}/\`, then verify with \`verify_live_preview(targetUrl: "/w/${safeId}/")\``
    : `\`workspace_run(action: "build")\` -> builds & publishes lightweight static production preview to \`/projects/${safeId}/index.html\`, then verify with \`verify_live_preview(targetUrl: "/projects/${safeId}/index.html")\``;

  const modularLayout = modular
    ? `\n- FULL-SCALE SESSION-SCOPED MODULAR UI/UX ARCHITECTURE${wantsFirebase ? ' + FIREBASE BACKEND' : ''} (12–25+ FILES — PARALLEL BATCH WRITES):
  1) Call \`plan(steps: [...])\` + \`read_skill("frontend-design")\`${wantsFirebase ? ' + `read_skill("firebase-integration")`' : ''} first.
  2) Call \`workspace_init(sessionId: "${safeId}", template: "${needsExpressBackend ? 'fullstack-express' : 'react-vite'}")\`, replace ALL starter template text, and batch 2–4 parallel \`write_to_file\` calls per turn inside \`workspaces/${safeId}/\`:
     * \`src/types.ts\` (comprehensive domain TypeScript interfaces, filter/sort/modal/cart/analytics types)
     * \`src/data/seed.ts\` + \`src/data/analytics.ts\` (rich multi-category dataset: 15–30+ items, time-series metrics, testimonials, pricing plans, FAQ)${firebaseStep}
  4) Batch parallel \`write_to_file\` calls for:
     * \`src/utils/formatters.ts\` + \`src/hooks/useWorkspaceState.ts\` (${wantsFirebase ? 'real CRUD & auth state wired to `src/services/firebaseBackend.ts` + local fallback' : 'rich interactive React state + localStorage persistence'})
     * \`src/components/*.tsx\` (8–14+ focused UI/UX components: Navbar, MobileNavDrawer, HeroSection, StatsStrip, FilterSidebar, SearchCommandBar, CatalogOrGrid, ItemCard, InteractiveChartPanel, ComparisonTable, DetailModal, CartOrActionDrawer, TestimonialsSection, FaqAccordion, Footer)
     * \`src/pages/*.tsx\` (4–6+ complete interactive views: HomePage, ExplorePage, AnalyticsPage, SavedOrOrdersPage, SettingsOrProfilePage)
     * \`src/App.tsx\` (${wantsFirebase ? 'wrapped in `<FirebaseProvider>`, ' : ''}clean multi-page router, keyboard shortcuts, toast provider & modal orchestrator)${needsExpressBackend ? `\n     * \`server/routes.ts\` + \`server.ts\` (real Express REST CRUD API mounted at \`/w/${safeId}/api\` and \`/api\`)` : ''}
  5) Publish & verify preview via ${previewRunInstr}.`
    : '';

  if (/(saas|dashboard|admin|analytics|crm|erp|inventory|ড্যাশবোর্ড|অ্যাডমিন)/i.test(lower)) {
    return `[VERIFIED LARGE SCAFFOLD BLUEPRINT — SAAS / DASHBOARD UI/UX]:
- Use full-scale modular UI/UX architecture: Sidebar + Topbar + 4-6 Multi-Page Views + KPI Summary Strip + Interactive SVG Charts + Sortable/Filterable Data Table + Create/Edit Drawer${wantsFirebase ? ' + Firebase Backend (`firebaseBackend.ts` + `firestore.rules`)' : ' + Client State / localStorage'}.
- Every tab, filter, search box, sort toggle, and CRUD modal must mutate real state and persist cleanly.${modularLayout}`;
  }

  if (/(store|shop|ecommerce|e-commerce|product|cart|checkout|ই-কমার্স|স্টোর|দোকান)/i.test(lower)) {
    return `[VERIFIED LARGE SCAFFOLD BLUEPRINT — E-COMMERCE UI/UX]:
- Use full-scale modular storefront UI/UX architecture: Sticky Header (Search + Multi-Page Nav + Wishlist + Account + Live Cart Badge) -> Editorial Hero -> Featured Collections -> Filterable Product Grid (Quick View + Add to Cart) -> Slide-over Cart Drawer (Qty +/- / Coupon / Subtotal / Checkout Modal) -> Order Tracking, Reviews, FAQ & Footer${wantsFirebase ? ' backed by Firebase' : ''}.
- Persist cart/wishlist/orders state cleanly and verify every interactive button works without console errors.${modularLayout}`;
  }

  if (needsExpressBackend || wantsFirebase) {
    return `[VERIFIED LARGE SCAFFOLD BLUEPRINT — FULL-STACK${wantsFirebase ? ' + FIREBASE' : ''}]:
- Separate contracts cleanly: Plan -> Shared Types -> ${wantsFirebase ? 'Firebase Backend (`firebase-blueprint.json`, `firestore.rules`, `src/services/firebaseBackend.ts`) -> ' : ''}${needsExpressBackend ? 'Express API Routes (mounted before Vite/static fallback) -> ' : ''}Multi-Page React Views & Components.
- Validate request bodies, return structured JSON errors, and ensure interactive frontend controls work cleanly.${modularLayout}`;
  }

  return `[VERIFIED LARGE SCAFFOLD BLUEPRINT — MODULAR UI/UX WEBSITE]:
- Build a comprehensive multi-page, multi-section production UI/UX website with rich domain data, responsive mobile/desktop layout, and real interactive React state on every button, filter, tab, modal, and form (no unrequested Firebase/backend wiring).${modularLayout}`;
}

// Deterministic Task Checklist for multi-step large website builds
export function buildDeterministicTaskPlan(promptText: string): string | null {
  if (isGitHubClonePrompt(promptText)) return null;
  const lower = (promptText || '').toLowerCase();
  const isComplexBuild =
    shouldUseModularArchitecture(promptText) ||
    (promptText.length > 90 &&
      /(build|create|implement|fullstack|full-stack|website|dashboard|ecommerce|app|clone|refactor|বানা|তৈরি|ওয়েবসাইট|ওয়েবসাইট|সাইট|ড্যাশবোর্ড|ই-কমার্স)/i.test(lower));
  if (!isComplexBuild) return null;

  const wantsFirebase = isExplicitFirebasePrompt(promptText);
  const firebasePlanStep = wantsFirebase
    ? `\n3. [Firebase SDK & Backend] Check [SAVED FIREBASE CONFIG DETECTED] vs [FIREBASE SDK SETUP UI REQUIRED] and call \`set_up_firebase\` + \`deploy_firebase\`.`
    : `\n3. [Interactive State & UX Polish] Wire interactive filters, modals, drawers, and \`localStorage\` persistence (NO unrequested Firebase setup or redundant \`npm install\` of pre-linked packages).`;

  return `[MANDATORY HARNESS EXECUTION CHECKLIST]:
1. [Plan & Design Skill] Call \`plan(steps: [...])\` + \`read_skill("frontend-design")\`${wantsFirebase ? ' + `read_skill("firebase-integration")`' : ''} before writing app files.
2. [Scaffold, Types & Data] Call \`workspace_init(template: "react-vite")\` to create \`workspaces/<sessionId>/\`, then write rich \`src/types.ts\`, \`src/data/seed.ts\`, \`src/data/analytics.ts\`.${firebasePlanStep}
4. [Modular Components & Pages] Batch parallel \`write_to_file\` calls (2-4 files per turn) across \`src/hooks/useWorkspaceState.ts\`, \`src/components/*.tsx\`, \`src/pages/*.tsx\`, \`src/App.tsx\`${wantsFirebase ? ' (wrapped in `<FirebaseProvider>`)' : ''}.
5. [Build Static Preview & Verify] Call \`workspace_run(action: "build")\` to publish lightweight static preview to \`/projects/<sessionId>/index.html\` (or \`action: "start"\` if Express \`server.ts\` exists), then run \`verify_live_preview\`.`;
}

// Pre-Flight Context Injector: gives ANY model real dependency graph, installed packages, AST signatures, and scaffold rules
export async function buildHarnessPreFlightContext(
  promptText: string,
  options: { sessionId?: string; isConversational?: boolean } = {}
): Promise<string> {
  if (options.isConversational) return '';
  const blocks: string[] = [];
  const safeId = (options.sessionId || 'app').replace(/[^a-zA-Z0-9_-]/g, '_');

  try {
    // 1. Inject installed packages & scoped context (skip root codebase AST/graph on fresh greenfield website builds!)
    const isCodeTask = /(src\/|server\/|react|vite|express|component|endpoint|route|typescript|tsx|ts|bug|error|fix|refactor|feature|app|build|create|website|dashboard|firebase|firestore|কোড|ফিক্স|এরর|বানা|তৈরি|ওয়েবসাইট|ফায়ারবেস|ফায়ারবেস)/i.test(promptText);
    const wsSrcExists = options.sessionId
      ? await fs.access(path.resolve(process.cwd(), 'workspaces', safeId, 'src')).then(() => true).catch(() => false)
      : false;
    const isFreshGreenfield = shouldUseModularArchitecture(promptText) && !wsSrcExists;

    if (isFreshGreenfield) {
      blocks.push(
        `[GREENFIELD ZERO-READ FAST-PATH (workspaces/${safeId}/)]:\n` +
        `- Pre-linked starter packages (DO NOT npm install): react, react-dom, lucide-react, clsx, tailwind-merge, motion, firebase, express, cors, vite, @vitejs/plugin-react, @tailwindcss/vite.\n` +
        `- ZERO-READ RULE: This is a brand-new standalone website. Do NOT call list_dir, analyze_project, codebase_graph, grep_search, or view_file on Nexus root files OR starter boilerplate (package.json, vite.config.ts, tsconfig.json, src/main.tsx, src/index.css).\n` +
        `- Start immediately: plan -> read_skill("frontend-design") -> workspace_init(sessionId: "${safeId}", template: "react-vite") -> parallel write_to_file(Overwrite: true) calls -> workspace_run(action: "build").`
      );
    } else if (isCodeTask) {
      const wsPkgRel = wsSrcExists && options.sessionId ? `workspaces/${safeId}/package.json` : 'package.json';
      const deps = (await loadPackageDependencySet(wsPkgRel)) || (await loadPackageDependencySet('package.json'));
      if (deps && deps.size > 0) {
        const list = Array.from(deps).filter((d) => !d.startsWith('@types/')).sort().slice(0, 35);
        blocks.push(`[PRE-INSTALLED PACKAGES (DO NOT npm install these)]: ${list.join(', ')}`);
      }

      // 2. AST Context Ranker scoped to active session workspace when editing an existing workspace
      const astTargetDir = wsSrcExists && options.sessionId ? `workspaces/${safeId}` : '.';
      const astRank = await rankAstContext(promptText, astTargetDir, 5).catch(() => null);
      if (astRank && astRank.rankedFiles.length > 0) {
        blocks.push(astRank.formattedContext.slice(0, 1800));
      }

      // 3. Compact Dependency Graph summary when modifying codebase files
      if (/(src\/|server\/|component|endpoint|route|refactor|fix|bug|import|নেক্সাস|কোড)/i.test(promptText) || wsSrcExists) {
        const graphTarget = wsSrcExists && options.sessionId ? `workspaces/${safeId}/src` : 'src';
        const graph = await buildCodebaseGraph(graphTarget).catch(() => null);
        if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
          const summary = graph.nodes
            .slice(0, 12)
            .map((n) => `${n.file} [imports: ${n.imports.slice(0, 4).join(', ') || 'none'} | exports: ${n.exports.slice(0, 4).join(', ') || 'none'}]`)
            .join('; ');
          if (summary) {
            blocks.push(`[CODEBASE DEPENDENCY GRAPH (${graphTarget}/)]: ${summary}`);
          }
        }
      }

      // 3b. Contract-First Type & API Lock (keeps free models synchronized across files)
      const wsBaseRel = options.sessionId ? `workspaces/${safeId}` : '';
      const typeCandidates = [
        ...(wsBaseRel ? [`${wsBaseRel}/src/types.ts`, `${wsBaseRel}/src/types/index.ts`] : []),
        ...(!wsSrcExists ? ['src/types.ts'] : []),
      ];
      for (const tc of typeCandidates) {
        try {
          const rawTypes = await fs.readFile(path.resolve(process.cwd(), tc), 'utf-8');
          const sigs = rawTypes
            .match(/export\s+(?:interface|type|enum)\s+\w+[\s\S]*?(?:\n\}|;)/g)
            ?.slice(0, 10)
            .join('\n')
            .slice(0, 950);
          if (sigs) {
            blocks.push(`[LOCKED TYPE CONTRACTS (${tc}) — MATCH EXACT FIELD NAMES]:\n${sigs}`);
            break;
          }
        } catch {}
      }
    }

    // 4. Error Knowledge Base injection if prompt mentions an error or bug
    if (/(error|bug|fail|crash|cannot find|unexpected|এরর|বাগ|সমস্যা|ঠিক)/i.test(promptText)) {
      const kbHints = lookupErrorKnowledgeBase(promptText);
      if (kbHints.length > 0) {
        blocks.push(`[KNOWN ERROR FIX PLAYBOOK]:\n- ${kbHints.join('\n- ')}`);
      }
    }

    // 5. Explicit Firebase pre-flight: detect whether user already saved SDK credentials in Settings vs needs SDK input modal
    if (isExplicitFirebasePrompt(promptText)) {
      const profile = await loadFirebaseProfile().catch(() => null);
      let wsCfg: any = null;
      if (options.sessionId) {
        wsCfg = await fs
          .readFile(path.resolve(process.cwd(), 'workspaces', safeId, 'firebase-config.json'), 'utf-8')
          .then(JSON.parse)
          .catch(() => null);
      }
      const savedProjectId =
        (!isPlaceholderValue(wsCfg?.projectId) && !isPlaceholderValue(wsCfg?.apiKey) && wsCfg.projectId) ||
        (!isPlaceholderValue(profile?.webConfig?.projectId) && !isPlaceholderValue(profile?.webConfig?.apiKey) && profile?.webConfig?.projectId) ||
        '';

      if (savedProjectId) {
        blocks.push(
          `[SAVED FIREBASE CONFIG DETECTED IN SETTINGS]: User already configured Firebase project "${savedProjectId}" in Firebase Settings. Call \`set_up_firebase(sessionId: "${safeId}", platform: "web", skipInteractivePrompt: true, blueprint: {...})\` to seamlessly wire their saved credentials into \`src/lib/firebase.ts\`, \`FirebaseProvider.tsx\`, \`src/services/firebaseBackend.ts\`, and \`firestore.rules\`, then call \`deploy_firebase(sessionId: "${safeId}")\`.`
        );
      } else {
        blocks.push(
          `[FIREBASE SDK SETUP UI REQUIRED]: The user asked to set up Firebase and NO saved Firebase SDK credentials exist in Firebase Settings yet. Do NOT pass \`skipInteractivePrompt: true\` — call \`set_up_firebase(sessionId: "${safeId}", platform: "web", interactive: true, blueprint: {...})\` so the interactive Firebase SDK setup UI opens immediately for the user to enter their config.`
        );
      }
    }

    // 6. Verified Scaffold Blueprint + Mandatory Checklist
    const blueprint = getVerifiedScaffoldBlueprint(promptText, options.sessionId);
    if (blueprint) blocks.push(blueprint);

    const checklist = buildDeterministicTaskPlan(promptText);
    if (checklist) blocks.push(checklist);
  } catch {
    // Non-fatal pre-flight enrichment
  }

  return blocks.join('\n\n');
}

export interface CriticPoolCandidate {
  id: string;
  name: string;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

// Cross-Model Critic: audits mutated files using a DIFFERENT model/key from the pool to catch bugs the writer missed
export async function runCrossModelCritic(options: {
  mutatedFiles: string[];
  originalPrompt: string;
  criticKey?: CriticPoolCandidate | null;
  fallbackInvoker?: (sys: string, usr: string) => Promise<string>;
  getEndpoint?: (provider: string, baseUrl?: string) => string;
}): Promise<{ ran: boolean; passed: boolean; criticName: string; issues: string[] }> {
  const { mutatedFiles, originalPrompt, criticKey, fallbackInvoker, getEndpoint } = options;
  const targets = mutatedFiles
    .map((f) => f.replace(/^\/+/, ''))
    .filter((f) => /\.(ts|tsx|js|jsx|html|css)$/i.test(f))
    .slice(0, 4);

  if (targets.length === 0 || (!criticKey && !fallbackInvoker)) {
    return { ran: false, passed: true, criticName: 'none', issues: [] };
  }

  const fileSnippets: string[] = [];
  for (const rel of targets) {
    try {
      const raw = await fs.readFile(path.resolve(process.cwd(), rel), 'utf-8');
      const capped = raw.length > 4500 ? `${raw.slice(0, 2800)}\n/* ... middle omitted ... */\n${raw.slice(-1400)}` : raw;
      fileSnippets.push(`=== FILE: /${rel} (${raw.split('\n').length} lines) ===\n${capped}`);
    } catch {}
  }

  if (fileSnippets.length === 0) {
    return { ran: false, passed: true, criticName: 'none', issues: [] };
  }

  const sysPrompt = `You are a strict Senior Code Critic in a multi-agent engineering harness.
Review the modified files against the user's request. Look ONLY for REAL defects:
1. Missing core features explicitly requested by the user.
2. Broken imports, mismatched props/types, undefined variables, or dead interactive handlers.
3. Truncated markup/code or placeholder comments.
Do NOT invent stylistic nitpicks.
Reply in strict JSON ONLY: {"passed": true|false, "issues": ["specific actionable defect with file path and symbol", ...]}`;

  const userPrompt = `User Request:\n${originalPrompt.slice(0, 1200)}\n\nModified Files:\n${fileSnippets.join('\n\n')}`;

  let rawResponse = '';
  let criticName = criticKey ? `${criticKey.name} (${criticKey.provider})` : 'Fallback Critic';

  try {
    if (criticKey && (criticKey.provider === 'openrouter' || criticKey.provider === 'huggingface')) {
      const isHf = criticKey.provider === 'huggingface';
      const fallbackChain = isHf
        ? [
            ...(criticKey.model ? [criticKey.model] : []),
            'deepseek-ai/DeepSeek-V4-Flash:cheapest',
            'Qwen/Qwen3-32B:cheapest',
            'Qwen/Qwen3.5-9B:cheapest',
          ].filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx)
        : [
            'cohere/north-mini-code:free',
            'nvidia/nemotron-3.5-lightning:free',
            'recursive/flint-v1.0:free',
            'openrouter/free',
          ];
      const ep = isHf
        ? 'https://router.huggingface.co/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
      const reqHeaders: Record<string, string> = isHf
        ? {
            Authorization: `Bearer ${criticKey.apiKey}`,
            'Content-Type': 'application/json',
          }
        : {
            Authorization: `Bearer ${criticKey.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://nexus-ai.local',
            'X-Title': 'Nexus AI',
          };
      for (const candidateModel of fallbackChain) {
        try {
          const res = await fetch(ep, {
            method: 'POST',
            headers: reqHeaders,
            body: JSON.stringify({
              model: candidateModel,
              messages: [
                { role: 'system', content: sysPrompt },
                { role: 'user', content: userPrompt },
              ],
              stream: false,
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const j = await res.json().catch(() => null);
            const content = j?.choices?.[0]?.message?.content || '';
            if (content) {
              rawResponse = content;
              criticName = `${criticKey.name} (${criticKey.provider} · ${candidateModel})`;
              break;
            }
          } else if (res.status === 401 || res.status === 402 || res.status === 403) {
            break;
          }
        } catch {
          // Try next fallback model in chain
        }
      }
    } else if (criticKey && criticKey.provider !== 'gemini' && getEndpoint) {
      const ep = getEndpoint(criticKey.provider, criticKey.baseUrl);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${criticKey.apiKey}`,
        'Content-Type': 'application/json',
      };
      const res = await fetch(ep, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: criticKey.model,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        rawResponse = j?.choices?.[0]?.message?.content || '';
      }
    } else if (fallbackInvoker) {
      rawResponse = await fallbackInvoker(sysPrompt, userPrompt);
    }
  } catch {
    return { ran: false, passed: true, criticName, issues: [] };
  }

  if (!rawResponse) {
    return { ran: false, passed: true, criticName, issues: [] };
  }

  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 5)
        : [];
      const passed = typeof parsed.passed === 'boolean' ? parsed.passed : issues.length === 0;
      return { ran: true, passed: passed || issues.length === 0, criticName, issues };
    }
  } catch {
    // Unparseable critic output -> non-blocking
  }

  return { ran: true, passed: true, criticName, issues: [] };
}

// ============================================================================
// API CONTRACT CHECKER (Frontend fetch/axios <-> Express /api/* Routes)
// ============================================================================

export interface ApiContractReport {
  ok: boolean;
  targetDir: string;
  frontendCalls: Array<{ method: string; path: string; file: string; line: number }>;
  backendRoutes: Array<{ method: string; path: string; file: string; line: number }>;
  mismatches: string[];
  warnings: string[];
  summary: string;
}

function normalizeApiPath(rawPath: string): string {
  const noQuery = rawPath.split('?')[0].split('#')[0].trim();
  const withVars = noQuery
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\/:[a-zA-Z0-9_]+/g, '/:param')
    .replace(/\/[0-9]+(?=\/|$)/g, '/:param');
  return withVars.replace(/\/+$/, '') || '/';
}

function apiPathsMatch(frontPath: string, backPath: string): boolean {
  const fParts = normalizeApiPath(frontPath).split('/').filter(Boolean);
  const bParts = normalizeApiPath(backPath).split('/').filter(Boolean);
  if (fParts.length !== bParts.length) return false;
  return fParts.every((fp, i) => fp === bParts[i] || fp === ':param' || bParts[i] === ':param');
}

async function collectCodeFilesRecursive(dir: string, exts: Set<string>, out: string[] = []): Promise<string[]> {
  let entries: any[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (['node_modules', 'dist', '.git', 'build', 'workspaces', 'projects'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await collectCodeFilesRecursive(full, exts, out);
    } else if (exts.has(path.extname(ent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

export async function checkApiContracts(targetDir: string = '.'): Promise<ApiContractReport> {
  const cleanDir = (targetDir || '.').replace(/^\/+/, '');
  const rootAbs = path.resolve(process.cwd(), cleanDir === '.' ? '' : cleanDir);
  if (!rootAbs.startsWith(process.cwd())) {
    return {
      ok: false,
      targetDir: cleanDir,
      frontendCalls: [],
      backendRoutes: [],
      mismatches: ['Access denied outside workspace'],
      warnings: [],
      summary: 'Access denied',
    };
  }

  const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx']);
  const srcFiles = await collectCodeFilesRecursive(path.join(rootAbs, 'src'), codeExts);
  const serverFiles = [
    ...(await collectCodeFilesRecursive(path.join(rootAbs, 'server'), codeExts)),
  ];
  for (const rootSrv of ['server.ts', 'server.js', 'app.ts', 'app.js']) {
    const abs = path.join(rootAbs, rootSrv);
    if (await fs.access(abs).then(() => true).catch(() => false)) {
      serverFiles.push(abs);
    }
  }

  const frontendCalls: ApiContractReport['frontendCalls'] = [];
  const backendRoutes: ApiContractReport['backendRoutes'] = [];
  const warnings: string[] = [];

  for (const file of srcFiles) {
    const raw = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!raw) continue;
    const rel = path.relative(process.cwd(), file);
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fetchMatch = line.match(/fetch\s*\(\s*[`'"]((?:\/w\/[^/]+)?\/api\/[^`'"]*)[`'"]/);
      if (fetchMatch) {
        let apiPath = fetchMatch[1].replace(/^\/w\/[^/]+/, '');
        const windowCtx = lines.slice(i, Math.min(lines.length, i + 6)).join(' ');
        const methodMatch = windowCtx.match(/method\s*:\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i);
        frontendCalls.push({
          method: (methodMatch?.[1] || 'GET').toUpperCase(),
          path: normalizeApiPath(apiPath),
          file: rel,
          line: i + 1,
        });
      }
      const axiosMatch = line.match(/axios\.(get|post|put|patch|delete)\s*\(\s*[`'"]((?:\/w\/[^/]+)?\/api\/[^`'"]*)[`'"]/i);
      if (axiosMatch) {
        frontendCalls.push({
          method: axiosMatch[1].toUpperCase(),
          path: normalizeApiPath(axiosMatch[2].replace(/^\/w\/[^/]+/, '')),
          file: rel,
          line: i + 1,
        });
      }
    }
  }

  for (const file of serverFiles) {
    const raw = await fs.readFile(file, 'utf-8').catch(() => '');
    if (!raw) continue;
    const rel = path.relative(process.cwd(), file);
    const lines = raw.split('\n');
    const isSubRouter = /Router\s*\(/.test(raw) && !/app\.listen\s*\(/.test(raw);
    let fallbackLine = -1;
    let lastApiLine = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/express\.static|vite\.middlewares|app\.get\(\s*['"]\*['"]/.test(line) && fallbackLine === -1) {
        fallbackLine = i + 1;
      }
      const routeMatch = line.match(/\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"]([^'"]+)['"]/i);
      if (routeMatch) {
        const method = routeMatch[1].toUpperCase();
        let routePath = routeMatch[2];
        if (isSubRouter && !routePath.startsWith('/api')) {
          routePath = `/api${routePath.startsWith('/') ? '' : '/'}${routePath}`;
        }
        if (routePath.startsWith('/api')) {
          lastApiLine = i + 1;
          backendRoutes.push({
            method,
            path: normalizeApiPath(routePath),
            file: rel,
            line: i + 1,
          });
        }
      }
    }

    if (fallbackLine !== -1 && lastApiLine > fallbackLine) {
      warnings.push(`/${rel}: Express /api route at line ${lastApiLine} is registered AFTER static/SPA fallback at line ${fallbackLine} (will return HTML 404).`);
    }
  }

  const mismatches: string[] = [];
  if (backendRoutes.length > 0) {
    for (const fc of frontendCalls) {
      const pathMatches = backendRoutes.filter((br) => apiPathsMatch(fc.path, br.path));
      if (pathMatches.length === 0) {
        mismatches.push(
          `Missing backend route for frontend call ${fc.method} ${fc.path} (${fc.file}:${fc.line})`
        );
      } else if (!pathMatches.some((br) => br.method === 'ALL' || br.method === fc.method)) {
        mismatches.push(
          `HTTP method mismatch on ${fc.path}: frontend uses ${fc.method} (${fc.file}:${fc.line}), backend defines [${pathMatches.map((m) => m.method).join(', ')}]`
        );
      }
    }
  } else if (frontendCalls.length > 0 && serverFiles.length > 0) {
    warnings.push(`Frontend makes ${frontendCalls.length} /api/* call(s), but no Express /api/* route definitions were detected in server files.`);
  }

  const uniqueMismatches = Array.from(new Set(mismatches));
  return {
    ok: uniqueMismatches.length === 0 && warnings.length === 0,
    targetDir: cleanDir,
    frontendCalls: frontendCalls.slice(0, 40),
    backendRoutes: backendRoutes.slice(0, 40),
    mismatches: uniqueMismatches,
    warnings,
    summary:
      uniqueMismatches.length === 0 && warnings.length === 0
        ? `All ${frontendCalls.length} frontend /api/* call(s) match ${backendRoutes.length} backend route(s).`
        : `Found ${uniqueMismatches.length} API mismatch(es) and ${warnings.length} route ordering warning(s).`,
  };
}

// ============================================================================
// TARGETED ERROR CONTEXT (Exact ±20 Line Slice + Imports + KB Hints)
// ============================================================================

export interface TargetedErrorDiagnostic {
  file: string;
  line: number;
  column?: number;
  message: string;
  importsHeader: string;
  snippet: string;
}

export interface TargetedErrorContextResult {
  ok: boolean;
  errorCount: number;
  rawSummary: string;
  diagnostics: TargetedErrorDiagnostic[];
  kbHints: string[];
}

export async function extractTargetedErrorContext(
  errorOutput?: string,
  targetDir: string = '.'
): Promise<TargetedErrorContextResult> {
  const cleanDir = (targetDir || '.').replace(/^\/+/, '');
  const cwdAbs = path.resolve(process.cwd(), cleanDir === '.' ? '' : cleanDir);
  let rawText = (errorOutput || '').trim();

  if (!rawText) {
    try {
      await execPromise('npx tsc --noEmit', { cwd: cwdAbs, timeout: 25000 });
      return {
        ok: true,
        errorCount: 0,
        rawSummary: 'tsc --noEmit passed with 0 errors.',
        diagnostics: [],
        kbHints: [],
      };
    } catch (err: any) {
      rawText = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`.trim();
    }
  }

  const parsedEntries: Array<{ file: string; line: number; column?: number; message: string }> = [];
  const lines = rawText.split('\n');
  for (const l of lines) {
    // TypeScript format: src/App.tsx(42,15): error TS2304: Cannot find name 'X'.
    const tsMatch = l.match(/^([^\s(][^(]+?)\((\d+),(\d+)\):\s*error\s+(TS\d+:\s*.+)$/);
    if (tsMatch) {
      parsedEntries.push({
        file: tsMatch[1].trim(),
        line: Number(tsMatch[2]),
        column: Number(tsMatch[3]),
        message: tsMatch[4].trim(),
      });
      continue;
    }
    // Vite / esbuild / Rollup format: file:line:col: error: ... or /abs/path/src/App.tsx:42:15
    const colonMatch = l.match(/([a-zA-Z0-9_./-]+\.(?:tsx?|jsx?|css|html)):(\d+):(\d+)\s*(?:-\s*)?(?:error[:\s]*)?(.*)$/i);
    if (colonMatch) {
      parsedEntries.push({
        file: colonMatch[1].trim(),
        line: Number(colonMatch[2]),
        column: Number(colonMatch[3]),
        message: (colonMatch[4] || l).trim(),
      });
    }
  }

  const seenFiles = new Set<string>();
  const diagnostics: TargetedErrorDiagnostic[] = [];

  for (const entry of parsedEntries) {
    if (diagnostics.length >= 4) break;
    const relFromCwd = path.isAbsolute(entry.file)
      ? path.relative(cwdAbs, entry.file)
      : entry.file.replace(/^\/+/, '');
    const key = `${relFromCwd}:${entry.line}`;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);

    const abs = path.resolve(cwdAbs, relFromCwd);
    if (!abs.startsWith(process.cwd())) continue;
    const fileRaw = await fs.readFile(abs, 'utf-8').catch(() => '');
    if (!fileRaw) continue;

    const fileLines = fileRaw.split('\n');
    const start = Math.max(1, entry.line - 18);
    const end = Math.min(fileLines.length, entry.line + 18);
    const snippet = fileLines
      .slice(start - 1, end)
      .map((code, idx) => {
        const ln = start + idx;
        return `${ln === entry.line ? '>>' : '  '} ${ln}: ${code}`;
      })
      .join('\n');

    const importsHeader = fileLines
      .slice(0, 22)
      .filter((fl) => /^\s*import\b/.test(fl))
      .join('\n')
      .slice(0, 800);

    diagnostics.push({
      file: path.relative(process.cwd(), abs),
      line: entry.line,
      column: entry.column,
      message: entry.message,
      importsHeader,
      snippet,
    });
  }

  const kbHints = lookupErrorKnowledgeBase(rawText);
  return {
    ok: parsedEntries.length === 0 && !/error TS\d+|Syntax error|Build failed/i.test(rawText),
    errorCount: parsedEntries.length,
    rawSummary: rawText.slice(0, 1200),
    diagnostics,
    kbHints,
  };
}
