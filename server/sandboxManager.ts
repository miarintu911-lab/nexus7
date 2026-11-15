import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { exec, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { transformSync } from 'esbuild';
import type { Request, Response } from 'express';
import { NEXUS_PREVIEW_BRIDGE_SCRIPT } from './websiteDeployer.ts';

const execPromise = promisify(exec);

export type WorkspaceTemplate = 'static' | 'react-vite' | 'fullstack-express';

export interface WorkspaceRuntime {
  sessionId: string;
  dir: string;
  port: number;
  pid?: number;
  command: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  proxyUrl: string;
  startedAt: number;
  logs: string[];
  process?: ChildProcess;
}

const WORKSPACES_ROOT = path.resolve(process.cwd(), 'workspaces');
const activeWorkspaces = new Map<string, WorkspaceRuntime>();
const inFlightStarts = new Map<string, Promise<Awaited<ReturnType<typeof startWorkspaceServerInternal>>>>();
const MAX_CONCURRENT_SUBSERVERS = 3; // Memory-safe for Render Free 512MB RAM

export function sanitizeSessionId(sessionId: string = 'default'): string {
  return String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
}

export function getWorkspaceDir(sessionId: string): string {
  return path.join(WORKSPACES_ROOT, sanitizeSessionId(sessionId));
}

async function allocateEphemeralPort(startPort = 4120, endPort = 4399): Promise<number> {
  const used = new Set(Array.from(activeWorkspaces.values()).map((w) => w.port));
  for (let p = startPort; p <= endPort; p++) {
    if (used.has(p)) continue;
    const available = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(p, '127.0.0.1');
    });
    if (available) return p;
  }
  throw new Error('No free ephemeral port available for sandbox sub-server.');
}

export async function initSessionWorkspace(
  sessionId: string = 'default',
  template: WorkspaceTemplate = 'fullstack-express',
  appTitle: string = 'Sandboxed Nexus App'
): Promise<{
  success: boolean;
  sessionId: string;
  workspacePath: string;
  proxyUrl: string;
  template: WorkspaceTemplate;
  createdFiles: string[];
  preLinkedPackages: string[];
  zeroReadContract: string;
}> {
  const safeId = sanitizeSessionId(sessionId);
  const wsDir = getWorkspaceDir(safeId);
  await fs.mkdir(wsDir, { recursive: true });
  const createdFiles: string[] = [];

  const rootPkgRaw = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf-8').catch(() => '{}');
  const rootPkg = JSON.parse(rootPkgRaw || '{}');
  const sharedDeps = {
    react: rootPkg.dependencies?.react || '^19.0.1',
    'react-dom': rootPkg.dependencies?.['react-dom'] || '^19.0.1',
    'lucide-react': rootPkg.dependencies?.['lucide-react'] || '^0.546.0',
    clsx: rootPkg.dependencies?.clsx || '^2.1.1',
    'tailwind-merge': rootPkg.dependencies?.['tailwind-merge'] || '^3.7.0',
    motion: rootPkg.dependencies?.motion || '^12.23.24',
    firebase: rootPkg.dependencies?.firebase || '^13.3.0',
    express: rootPkg.dependencies?.express || '^4.21.2',
    cors: rootPkg.dependencies?.cors || '^2.8.6',
    vite: rootPkg.dependencies?.vite || '^8.3.0',
    '@vitejs/plugin-react': rootPkg.dependencies?.['@vitejs/plugin-react'] || '^6.1.1',
    '@tailwindcss/vite': rootPkg.dependencies?.['@tailwindcss/vite'] || '^4.3.3',
  };

  // Symlink root node_modules into workspace so modular React/Vite/Express apps boot immediately without npm install
  if (template !== 'static') {
    const wsNodeModules = path.join(wsDir, 'node_modules');
    const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
    const hasNm = await fs.lstat(wsNodeModules).then(() => true).catch(() => false);
    if (!hasNm) {
      await fs.symlink(rootNodeModules, wsNodeModules, 'dir').catch(() => {});
    }
  }

  const modularTsConfig = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['vite/client'],
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ['src', 'server', 'server.ts'],
    },
    null,
    2
  );

  const modularViteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/w/${safeId}/',
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    allowedHosts: true,
    hmr: false,
    ws: false,
    watch: null,
  },
});
`;

  const baseFrontendFiles: Record<string, string> = {
    'tsconfig.json': modularTsConfig,
    'vite.config.ts': modularViteConfig,
    'src/vite-env.d.ts': `/// <reference types="vite/client" />\n`,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appTitle}</title>
  </head>
  <body class="bg-slate-950 text-slate-100 antialiased">
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
    'src/main.tsx': `import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
`,
    'src/index.css': `@import "tailwindcss";\n`,
    'src/types.ts': `export type ActiveTab = 'overview' | 'explore' | 'settings';

export interface WorkspaceItem {
  id: string;
  title: string;
  category: string;
  status: 'active' | 'draft';
  updatedAt: string;
}
`,
    'src/data/seed.ts': `import type { WorkspaceItem } from '../types.ts';

export const INITIAL_ITEMS: WorkspaceItem[] = [
  { id: '1', title: '${appTitle} Core Module', category: 'Architecture', status: 'active', updatedAt: 'Just now' },
  { id: '2', title: 'Modular Component Shell', category: 'UI', status: 'active', updatedAt: 'Just now' },
];
`,
    'src/components/Navbar.tsx': `import React from 'react';
import type { ActiveTab } from '../types.ts';

interface NavbarProps {
  title: string;
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
}

export function Navbar({ title, activeTab, onSelectTab }: NavbarProps) {
  const tabs: Array<{ id: ActiveTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'explore', label: 'Explore' },
    { id: 'settings', label: 'Settings' },
  ];
  return (
    <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur px-6 py-3 flex items-center justify-between">
      <span className="font-bold text-white tracking-tight">{title}</span>
      <nav className="flex items-center gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelectTab(t.id)}
            className={\`px-3 py-1.5 rounded-lg text-sm font-medium transition \${
              activeTab === t.id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800'
            }\`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
`,
    'src/pages/HomePage.tsx': `import React from 'react';
import type { WorkspaceItem } from '../types.ts';

interface HomePageProps {
  items: WorkspaceItem[];
  onAddItem: () => void;
}

export function HomePage({ items, onAddItem }: HomePageProps) {
  return (
    <section className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Modular Workspace Ready</h1>
          <p className="text-sm text-slate-400">Organized into types, data, components, pages, and routes.</p>
        </div>
        <button
          onClick={onAddItem}
          className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition"
        >
          Add Item
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((item) => (
          <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="font-semibold text-white">{item.title}</div>
            <div className="mt-1 text-xs text-slate-400">{item.category} · {item.status}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
`,
    'src/App.tsx': `import React, { useState } from 'react';
import type { ActiveTab, WorkspaceItem } from './types.ts';
import { INITIAL_ITEMS } from './data/seed.ts';
import { Navbar } from './components/Navbar.tsx';
import { HomePage } from './pages/HomePage.tsx';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const [items, setItems] = useState<WorkspaceItem[]>(INITIAL_ITEMS);

  const handleAddItem = () => {
    setItems((prev) => [
      {
        id: String(Date.now()),
        title: \`New Item #\${prev.length + 1}\`,
        category: activeTab,
        status: 'active',
        updatedAt: 'Now',
      },
      ...prev,
    ]);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Navbar title="${appTitle}" activeTab={activeTab} onSelectTab={setActiveTab} />
      <main>
        <HomePage items={items} onAddItem={handleAddItem} />
      </main>
    </div>
  );
}
`,
  };

  if (template === 'static') {
    const indexPath = path.join(wsDir, 'index.html');
    const exists = await fs.access(indexPath).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(
        indexPath,
        `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${appTitle}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6">
  <main class="max-w-lg w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">
    <h1 class="text-2xl font-bold text-white">${appTitle}</h1>
    <p class="mt-2 text-sm text-slate-400">Isolated workspace ready at workspaces/${safeId}/</p>
  </main>
</body>
</html>`,
        'utf-8'
      );
      createdFiles.push(`workspaces/${safeId}/index.html`);
    }
  } else if (template === 'react-vite') {
    const files: Record<string, string> = {
      'package.json': JSON.stringify(
        {
          name: `nexus-ws-${safeId}`,
          private: true,
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'vite build',
            lint: 'tsc --noEmit',
          },
          dependencies: {
            react: sharedDeps.react,
            'react-dom': sharedDeps['react-dom'],
            'lucide-react': sharedDeps['lucide-react'],
            clsx: sharedDeps.clsx,
            'tailwind-merge': sharedDeps['tailwind-merge'],
            motion: sharedDeps.motion,
            firebase: sharedDeps.firebase,
          },
          devDependencies: {
            vite: sharedDeps.vite,
            '@vitejs/plugin-react': sharedDeps['@vitejs/plugin-react'],
            '@tailwindcss/vite': sharedDeps['@tailwindcss/vite'],
          },
        },
        null,
        2
      ),
      ...baseFrontendFiles,
    };
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(wsDir, rel);
      const exists = await fs.access(target).then(() => true).catch(() => false);
      if (!exists) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        createdFiles.push(`workspaces/${safeId}/${rel}`);
      }
    }
  } else {
    const files: Record<string, string> = {
      'package.json': JSON.stringify(
        {
          name: `nexus-fullstack-${safeId}`,
          private: true,
          type: 'module',
          scripts: {
            dev: 'tsx server.ts',
            build: 'vite build',
            start: 'node server.ts',
            lint: 'tsc --noEmit',
          },
          dependencies: sharedDeps,
        },
        null,
        2
      ),
      'server/routes.ts': `import { Router } from 'express';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, workspace: '${safeId}', uptime: Math.round(process.uptime()) });
});
`,
      'server.ts': `import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4120;

app.use(express.json());
app.use('/w/${safeId}/api', apiRouter);
app.use('/api', apiRouter);

async function boot() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: __dirname,
      base: '/w/${safeId}/',
      server: { middlewareMode: true, allowedHosts: true, hmr: false, ws: false, watch: null },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use('/w/${safeId}', express.static(distDir));
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '127.0.0.1', () => {
    console.log('Fullstack modular sandbox listening on port', PORT);
  });
}

boot();
`,
      ...baseFrontendFiles,
    };
    for (const [rel, content] of Object.entries(files)) {
      const target = path.join(wsDir, rel);
      const exists = await fs.access(target).then(() => true).catch(() => false);
      if (!exists) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf-8');
        createdFiles.push(`workspaces/${safeId}/${rel}`);
      }
    }
  }

  return {
    success: true,
    sessionId: safeId,
    workspacePath: `workspaces/${safeId}`,
    proxyUrl: `/w/${safeId}/`,
    template,
    createdFiles,
    preLinkedPackages: ['react', 'react-dom', 'lucide-react', 'clsx', 'tailwind-merge', 'motion', 'express', 'cors'],
    zeroReadContract: `Starter config and entry files (package.json, vite.config.ts, tsconfig.json, index.html, src/main.tsx, src/index.css) are already configured with Tailwind v4 + React 19 + lucide-react + motion. Do NOT call view_file or list_dir on them. Immediately overwrite workspaces/${safeId}/src/types.ts, src/data/*, src/components/*.tsx, src/pages/*.tsx, and src/App.tsx using parallel write_to_file(Overwrite: true) calls.`,
  };
}

export function normalizeGitHubRepoSpec(rawInput: string): {
  owner: string;
  repo: string;
  cloneUrl: string;
  slug: string;
  branchFromUrl?: string;
} | null {
  let s = (rawInput || '').trim();
  s = s.replace(/^(?:gh\s+repo\s+clone|git\s+clone)\s+/i, '').trim();
  s = s.replace(/^["']|["']$/g, '').split(/\s+/)[0] || '';
  s = s.replace(/\/+$/, '');

  const sshMatch = s.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (sshMatch) {
    const [, owner, repo] = sshMatch;
    return { owner, repo, slug: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
  }

  const urlMatch = s.match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+)|\/.*)?$/i);
  if (urlMatch) {
    const [, owner, repo, branchFromUrl] = urlMatch;
    return {
      owner,
      repo,
      slug: `${owner}/${repo}`,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      ...(branchFromUrl ? { branchFromUrl } : {}),
    };
  }

  const cleanSlug = s.replace(/\.git$/i, '');
  const slugMatch = cleanSlug.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (slugMatch) {
    const [, owner, repo] = slugMatch;
    return { owner, repo, slug: `${owner}/${repo}`, cloneUrl: `https://github.com/${owner}/${repo}.git` };
  }

  return null;
}

async function hasRootPeerConflicts(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const tsVer = String(pkg.devDependencies?.typescript || pkg.dependencies?.typescript || '');
    const hasTs7 = /(?:^|[^\d])(?:6\.[1-9]|[7-9]\.|1\d\.)/.test(tsVer);
    const hasTsEslint = Boolean(pkg.dependencies?.['@typescript-eslint/typescript-estree'] || pkg.devDependencies?.['@typescript-eslint/typescript-estree']);
    return hasTs7 && hasTsEslint;
  } catch {
    return false;
  }
}

function spawnNpmInstallWithTimeout(
  cwd: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; timedOut: boolean; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
        npm_config_progress: 'false',
        CI: 'true',
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 600);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout = (stdout + d.toString()).slice(-12000); });
    child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-12000); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, code });
    });
  });
}

async function runNpmInstallFast(
  cwd: string,
  pkgArgs: string = '',
  options: { timeoutMs?: number; forceLegacyPeerDeps?: boolean } = {}
): Promise<{ stdout: string; legacyPeerDeps: boolean; ignoredScripts?: boolean }> {
  const timeout = options.timeoutMs ?? 55000;
  const cleanTokens = pkgArgs.trim() ? pkgArgs.trim().split(/\s+/).filter(Boolean) : [];
  const baseFlags = [
    'install',
    '--no-audit',
    '--no-fund',
    '--prefer-offline',
    '--ignore-scripts',
    '--fetch-timeout=15000',
    '--fetch-retries=1',
    '--progress=false',
  ];

  const runOnce = async (extraFlags: string[]) => {
    const args = [...baseFlags, ...extraFlags, ...cleanTokens];
    const res = await spawnNpmInstallWithTimeout(cwd, args, timeout);
    if (res.timedOut) {
      const err: any = new Error(`npm install timed out after ${Math.round(timeout / 1000)}s`);
      err.timedOut = true;
      err.stderr = res.stderr;
      throw err;
    }
    if (res.code !== 0) {
      const err: any = new Error((res.stderr || res.stdout || `npm install exited with code ${res.code}`).trim());
      err.stderr = res.stderr;
      throw err;
    }
    return res.stdout;
  };

  if (options.forceLegacyPeerDeps) {
    const stdout = await runOnce(['--legacy-peer-deps']);
    return { stdout, legacyPeerDeps: true, ignoredScripts: true };
  }

  try {
    const stdout = await runOnce([]);
    return { stdout, legacyPeerDeps: false, ignoredScripts: true };
  } catch (firstErr: any) {
    if (firstErr?.timedOut) {
      throw firstErr;
    }
    const stdout = await runOnce(['--legacy-peer-deps']);
    return { stdout, legacyPeerDeps: true, ignoredScripts: true };
  }
}

async function linkEntriesIntoNodeModules(srcNmDir: string, destNmDir: string, overwriteExisting: boolean): Promise<void> {
  const entries = await fs.readdir(srcNmDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.bin') continue;
    const srcPath = path.join(srcNmDir, ent.name);
    const destPath = path.join(destNmDir, ent.name);

    if (ent.name === '.bin' || ent.name.startsWith('@')) {
      const destStat = await fs.lstat(destPath).catch(() => null);
      if (destStat?.isSymbolicLink()) {
        await fs.unlink(destPath).catch(() => {});
      }
      await fs.mkdir(destPath, { recursive: true });
      const subEntries = await fs.readdir(srcPath, { withFileTypes: true }).catch(() => []);
      for (const sub of subEntries) {
        const subSrc = path.join(srcPath, sub.name);
        const subDest = path.join(destPath, sub.name);
        const exists = await fs.lstat(subDest).then(() => true).catch(() => false);
        if (exists) {
          if (!overwriteExisting) continue;
          await fs.rm(subDest, { recursive: true, force: true }).catch(() => {});
        }
        await fs.symlink(subSrc, subDest, 'dir').catch(() => {});
      }
      continue;
    }

    const exists = await fs.lstat(destPath).then(() => true).catch(() => false);
    if (exists) {
      if (!overwriteExisting) continue;
      await fs.rm(destPath, { recursive: true, force: true }).catch(() => {});
    }
    await fs.symlink(srcPath, destPath, 'dir').catch(() => {});
  }
}

export async function syncMergedWorkspaceNodeModules(wsDir: string): Promise<void> {
  const wsNodeModules = path.join(wsDir, 'node_modules');
  const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
  const extraNodeModules = path.join(wsDir, '.nexus_deps', 'node_modules');

  const nmStat = await fs.lstat(wsNodeModules).catch(() => null);
  if (nmStat?.isSymbolicLink()) {
    await fs.unlink(wsNodeModules).catch(() => {});
  }
  await fs.mkdir(wsNodeModules, { recursive: true });

  // Extra workspace-local packages override root packages when both exist
  const hasExtra = await fs.access(extraNodeModules).then(() => true).catch(() => false);
  if (hasExtra) {
    await linkEntriesIntoNodeModules(extraNodeModules, wsNodeModules, true);
  }
  await linkEntriesIntoNodeModules(rootNodeModules, wsNodeModules, false);
}

function parsePackageSpecifier(raw: string): { name: string; specifier: string } {
  const s = raw.trim();
  if (s.startsWith('@')) {
    const idx = s.indexOf('@', 1);
    return idx > 0 ? { name: s.slice(0, idx), specifier: s.slice(idx + 1) } : { name: s, specifier: '' };
  }
  const idx = s.indexOf('@');
  return idx > 0 ? { name: s.slice(0, idx), specifier: s.slice(idx + 1) } : { name: s, specifier: '' };
}

export async function installPackagesInTarget(options: {
  packages: string[];
  isDev?: boolean;
  sessionId?: string;
  targetDir?: string;
}): Promise<{
  success?: boolean;
  error?: string;
  stderr?: string;
  packages?: string[];
  target?: string;
  legacyPeerDeps?: boolean;
  message?: string;
  stdout?: string;
}> {
  const { packages, isDev = false, sessionId, targetDir } = options;
  if (!packages || packages.length === 0) {
    return { error: 'Valid PackageNames array is required' };
  }

  // Decide whether to install into active session workspace or root project
  let resolvedTarget = process.cwd();
  let isWorkspaceTarget = false;
  const cleanDir = (targetDir || '').trim().replace(/^[/\\]+/, '');
  if (cleanDir && cleanDir !== '.' && cleanDir !== 'root') {
    const abs = path.resolve(process.cwd(), cleanDir);
    if (abs.startsWith(process.cwd())) {
      resolvedTarget = abs;
      isWorkspaceTarget = abs.startsWith(WORKSPACES_ROOT + path.sep) || abs === WORKSPACES_ROOT;
    }
  } else if (!cleanDir && sessionId) {
    const safeId = sanitizeSessionId(sessionId);
    const candidateWs = getWorkspaceDir(safeId);
    const hasWsPkg = await fs.access(path.join(candidateWs, 'package.json')).then(() => true).catch(() => false);
    if (hasWsPkg) {
      resolvedTarget = candidateWs;
      isWorkspaceTarget = true;
    }
  }

  const flag = isDev ? '-D' : '';
  const pkgArgs = packages.join(' ');

  if (isWorkspaceTarget) {
    const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
    const satisfiedByRoot: Array<{ raw: string; name: string; version: string }> = [];
    const missingFromRoot: string[] = [];

    for (const rawPkg of packages) {
      const { name, specifier } = parsePackageSpecifier(rawPkg);
      if (!name) continue;
      let rootVer = '';
      try {
        const rootPkgJson = JSON.parse(
          await fs.readFile(path.join(rootNodeModules, name, 'package.json'), 'utf-8')
        );
        rootVer = String(rootPkgJson?.version || '').trim();
      } catch {}

      let matchesSpecifier = false;
      if (rootVer) {
        if (!specifier || specifier === '*' || specifier === 'latest') {
          matchesSpecifier = true;
        } else {
          const cleanSpec = specifier.replace(/^[\^~>=<=\s]+/, '');
          const specMajor = cleanSpec.split('.')[0];
          const rootMajor = rootVer.split('.')[0];
          if (specMajor && rootMajor && specMajor === rootMajor) {
            matchesSpecifier = true;
          }
        }
      }

      if (matchesSpecifier) {
        satisfiedByRoot.push({ raw: rawPkg, name, version: `^${rootVer}` });
      } else {
        missingFromRoot.push(rawPkg);
      }
    }

    const extraDir = path.join(resolvedTarget, '.nexus_deps');
    const extraPkgPath = path.join(extraDir, 'package.json');
    let resStdout = '';
    let legacyPeerDeps = true;

    try {
      if (missingFromRoot.length > 0) {
        await fs.mkdir(extraDir, { recursive: true });
        const hasExtraPkg = await fs.access(extraPkgPath).then(() => true).catch(() => false);
        if (!hasExtraPkg) {
          await fs.writeFile(
            extraPkgPath,
            JSON.stringify({ name: 'nexus-ws-extra-deps', private: true, dependencies: {} }, null, 2),
            'utf-8'
          );
        }

        const missingArgs = missingFromRoot.join(' ');
        const res = await runNpmInstallFast(extraDir, `${flag} ${missingArgs}`, {
          timeoutMs: 55000,
          forceLegacyPeerDeps: true,
        });
        resStdout = res.stdout;
        legacyPeerDeps = res.legacyPeerDeps;
      }

      await syncMergedWorkspaceNodeModules(resolvedTarget);

      // Record installed packages + exact versions in workspace package.json so pre-write guardrails & tsc see them
      const wsPkgPath = path.join(resolvedTarget, 'package.json');
      try {
        const wsPkg = JSON.parse(await fs.readFile(wsPkgPath, 'utf-8'));
        let installedExtra: Record<string, string> = {};
        try {
          const extraPkg = JSON.parse(await fs.readFile(extraPkgPath, 'utf-8'));
          installedExtra = { ...(extraPkg.dependencies || {}), ...(extraPkg.devDependencies || {}) };
        } catch {}
        const sectionKey = isDev ? 'devDependencies' : 'dependencies';
        wsPkg[sectionKey] = wsPkg[sectionKey] || {};
        for (const item of satisfiedByRoot) {
          wsPkg[sectionKey][item.name] = wsPkg[sectionKey][item.name] || item.version || '*';
        }
        for (const rawPkg of missingFromRoot) {
          const { name, specifier } = parsePackageSpecifier(rawPkg);
          wsPkg[sectionKey][name] = installedExtra[name] || specifier || '*';
        }
        await fs.writeFile(wsPkgPath, JSON.stringify(wsPkg, null, 2), 'utf-8');
      } catch {}

      const relTarget = path.relative(process.cwd(), resolvedTarget) || '.';
      const reusedNames = satisfiedByRoot.map((s) => s.name);
      const summaryParts: string[] = [];
      if (reusedNames.length > 0) summaryParts.push(`instant-linked root [${reusedNames.join(', ')}]`);
      if (missingFromRoot.length > 0) summaryParts.push(`installed [${missingFromRoot.join(', ')}]`);
      return {
        success: true,
        packages,
        target: relTarget,
        legacyPeerDeps,
        message: `Resolved dependencies in ${relTarget} (${summaryParts.join('; ') || 'ok'})`,
        stdout: resStdout.trim().slice(-1500),
      };
    } catch (err: any) {
      return {
        error: `npm install failed in ${path.relative(process.cwd(), resolvedTarget)}: ${err?.message || 'Unknown error'}`,
        stderr: String(err?.message || '').slice(-1500),
      };
    }
  }

  // Root /app/applet install (always skip audit/fund and bypass known root peer conflict)
  const forceLegacy = await hasRootPeerConflicts();
  try {
    const res = await runNpmInstallFast(resolvedTarget, `${flag} ${pkgArgs}`, {
      timeoutMs: 120000,
      forceLegacyPeerDeps: forceLegacy,
    });
    return {
      success: true,
      packages,
      target: '.',
      legacyPeerDeps: res.legacyPeerDeps,
      message: `Installed [${packages.join(', ')}] successfully${res.legacyPeerDeps ? ' (--legacy-peer-deps)' : ''}`,
      stdout: res.stdout.trim().slice(-1500),
    };
  } catch (err: any) {
    return {
      error: `npm install failed: ${err?.message || 'Unknown error'}`,
      stderr: String(err?.message || '').slice(-1500),
    };
  }
}

export async function installDependenciesForTarget(options: {
  sessionId?: string;
  targetDir?: string;
}): Promise<{
  success?: boolean;
  error?: string;
  stderr?: string;
  message?: string;
  stdout?: string;
}> {
  const { sessionId, targetDir } = options;
  const cleanDir = (targetDir || '').trim().replace(/^[/\\]+/, '');
  let wsTarget: string | null = null;

  if (cleanDir && cleanDir !== '.' && cleanDir !== 'root') {
    const abs = path.resolve(process.cwd(), cleanDir);
    if (abs.startsWith(WORKSPACES_ROOT + path.sep)) {
      wsTarget = abs;
    }
  } else if (!cleanDir && sessionId) {
    const candidate = getWorkspaceDir(sanitizeSessionId(sessionId));
    const hasWsPkg = await fs.access(path.join(candidate, 'package.json')).then(() => true).catch(() => false);
    if (hasWsPkg) wsTarget = candidate;
  }

  if (wsTarget) {
    const depRes = await ensureWorkspaceDependencies(wsTarget, true);
    if (depRes.mode === 'symlink' || depRes.mode === 'npm_install' || depRes.mode === 'skipped') {
      return { success: true, message: depRes.note };
    }
    return { success: true, message: depRes.note };
  }

  const forceLegacy = await hasRootPeerConflicts();
  try {
    const res = await runNpmInstallFast(process.cwd(), '', {
      timeoutMs: 120000,
      forceLegacyPeerDeps: forceLegacy,
    });
    return {
      success: true,
      message: `Installed all package.json dependencies via npm install${res.legacyPeerDeps ? ' (--legacy-peer-deps)' : ''}.`,
      stdout: res.stdout.trim().slice(-1500),
    };
  } catch (err: any) {
    return {
      error: `npm install failed: ${err?.message || 'Unknown error'}`,
      stderr: String(err?.message || '').slice(-1500),
    };
  }
}

async function ensureWorkspaceDependencies(
  wsDir: string,
  forceVerify: boolean = false
): Promise<{
  mode: 'symlink' | 'npm_install' | 'skipped' | 'partial';
  note: string;
}> {
  const wsPkgPath = path.join(wsDir, 'package.json');
  const wsNodeModules = path.join(wsDir, 'node_modules');
  const rootNodeModules = path.resolve(process.cwd(), 'node_modules');

  const hasPkg = await fs.access(wsPkgPath).then(() => true).catch(() => false);
  if (!hasPkg) return { mode: 'skipped', note: 'No package.json (static/non-Node project).' };

  try {
    const rawPkg = await fs.readFile(wsPkgPath, 'utf-8');
    const pkg = JSON.parse(rawPkg);
    const depsMap: Record<string, string> = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    const allDeps = Object.keys(depsMap);

    const nmStat = await fs.lstat(wsNodeModules).catch(() => null);
    if (nmStat && !forceVerify) {
      // Quick check: if all declared deps already resolve in wsDir/node_modules, skip
      let allPresent = true;
      for (const dep of allDeps) {
        const exists = await fs.access(path.join(wsNodeModules, dep)).then(() => true).catch(() => false);
        if (!exists) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        return { mode: 'skipped', note: 'node_modules already satisfies all dependencies.' };
      }
    }

    if (allDeps.length === 0) {
      if (!nmStat) await fs.symlink(rootNodeModules, wsNodeModules, 'dir').catch(() => {});
      return { mode: 'symlink', note: 'No external dependencies declared; linked shared node_modules.' };
    }

    const missingInRoot: string[] = [];
    for (const dep of allDeps) {
      const existsInRoot = await fs.access(path.join(rootNodeModules, dep)).then(() => true).catch(() => false);
      if (!existsInRoot) missingInRoot.push(dep);
    }

    if (missingInRoot.length === 0) {
      if (nmStat && !nmStat.isSymbolicLink()) {
        await syncMergedWorkspaceNodeModules(wsDir);
      } else if (!nmStat) {
        await fs.symlink(rootNodeModules, wsNodeModules, 'dir');
      }
      return { mode: 'symlink', note: `Instant-linked all ${allDeps.length} dependencies from root node_modules.` };
    }

    // Install ONLY the missing packages in isolated .nexus_deps and merge with root node_modules (fast & conflict-free)
    const missingSpecArgs = missingInRoot
      .map((name) => {
        const ver = String(depsMap[name] || '').trim();
        if (!ver || /^(?:workspace:|file:|link:|git\+|github:)/i.test(ver)) return name;
        return `${name}@${ver}`;
      });

    const extraDir = path.join(wsDir, '.nexus_deps');
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(
      path.join(extraDir, 'package.json'),
      JSON.stringify({ name: 'nexus-ws-extra-deps', private: true, dependencies: {} }, null, 2),
      'utf-8'
    );

    try {
      await runNpmInstallFast(extraDir, missingSpecArgs.join(' '), {
        timeoutMs: 120000,
        forceLegacyPeerDeps: true,
      });
      await syncMergedWorkspaceNodeModules(wsDir);
      return {
        mode: 'npm_install',
        note: `Installed ${missingInRoot.length} missing package(s) [${missingInRoot.slice(0, 8).join(', ')}${missingInRoot.length > 8 ? '...' : ''}] & linked ${allDeps.length - missingInRoot.length} shared packages.`,
      };
    } catch (batchErr: any) {
      // Fallback 1: remove lockfile/incompatible node_modules symlink and run full npm install in wsDir
      if (nmStat?.isSymbolicLink()) {
        await fs.unlink(wsNodeModules).catch(() => {});
      }
      await fs.unlink(path.join(wsDir, 'package-lock.json')).catch(() => {});
      try {
        await runNpmInstallFast(wsDir, '', {
          timeoutMs: 120000,
          forceLegacyPeerDeps: true,
        });
        return { mode: 'npm_install', note: `Installed all ${allDeps.length} dependencies directly in workspace.` };
      } catch {
        // Fallback 2: install missing packages individually so one broken package doesn't block the rest
        const installedOk: string[] = [];
        const failedPkgs: string[] = [];
        for (const name of missingInRoot.slice(0, 25)) {
          try {
            await runNpmInstallFast(extraDir, name, { timeoutMs: 30000, forceLegacyPeerDeps: true });
            installedOk.push(name);
          } catch {
            failedPkgs.push(name);
          }
        }
        await syncMergedWorkspaceNodeModules(wsDir).catch(async () => {
          if (!await fs.lstat(wsNodeModules).then(() => true).catch(() => false)) {
            await fs.symlink(rootNodeModules, wsNodeModules, 'dir').catch(() => {});
          }
        });
        return {
          mode: failedPkgs.length === 0 ? 'npm_install' : 'partial',
          note: failedPkgs.length === 0
            ? `Installed ${installedOk.length} missing packages individually & linked shared node_modules.`
            : `Installed [${installedOk.join(', ')}]; failed [${failedPkgs.join(', ')}]: ${(batchErr?.message || '').slice(0, 120)}`,
        };
      }
    }
  } catch (err: any) {
    if (!await fs.lstat(wsNodeModules).then(() => true).catch(() => false)) {
      await fs.symlink(rootNodeModules, wsNodeModules, 'dir').catch(() => {});
    }
    return { mode: 'partial', note: `Dependency check fallback: ${err?.message || 'symlinked root node_modules'}` };
  }
}

async function normalizeClonedWorkspaceForPreview(wsDir: string, safeId: string): Promise<string[]> {
  const notes: string[] = [];

  // 1. Remove non-npm lockfiles
  for (const lf of ['bun.lock', 'bun.lockb', 'yarn.lock', 'pnpm-lock.yaml']) {
    const lp = path.join(wsDir, lf);
    const exists = await fs.access(lp).then(() => true).catch(() => false);
    if (exists) {
      await fs.unlink(lp).catch(() => {});
      notes.push(`Removed ${lf}`);
    }
  }

  // 2. Normalize package.json (convert resolutions -> overrides, drop packageManager/preinstall/postinstall blockers)
  const pkgPath = path.join(wsDir, 'package.json');
  try {
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    let changed = false;
    if (pkg.packageManager) {
      delete pkg.packageManager;
      changed = true;
    }
    if (pkg.scripts?.preinstall) {
      delete pkg.scripts.preinstall;
      changed = true;
    }
    if (pkg.resolutions && !pkg.overrides) {
      pkg.overrides = pkg.resolutions;
      delete pkg.resolutions;
      changed = true;
    }
    if (changed) {
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');
      notes.push('Normalized package.json for npm');
    }
  } catch {}

  // 3. Patch vite.config.(ts|js|mjs) to serve cleanly under /w/<safeId>/ with HMR disabled
  for (const vFile of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const vp = path.join(wsDir, vFile);
    try {
      const orig = await fs.readFile(vp, 'utf-8');
      if (!orig.includes(`/w/${safeId}/`)) {
        let patched = orig;
        if (!/\bbase\s*:/.test(patched)) {
          if (/defineConfig\s*\(\s*\([^)]*\)\s*=>\s*\{\s*[\s\S]*?return\s*\{/.test(patched)) {
            patched = patched.replace(/return\s*\{/, `return {\n    base: '/w/${safeId}/',`);
          } else if (/defineConfig\s*\(\s*\{/.test(patched)) {
            patched = patched.replace(/defineConfig\s*\(\s*\{/, `defineConfig({\n  base: '/w/${safeId}/',`);
          } else if (/export\s+default\s*\{/.test(patched)) {
            patched = patched.replace(/export\s+default\s*\{/, `export default {\n  base: '/w/${safeId}/',`);
          }
        } else {
          patched = patched.replace(/base\s*:\s*[^,\n}]+/, `base: '/w/${safeId}/'`);
        }

        if (patched !== orig) {
          const loader = vFile.endsWith('.ts') ? 'ts' : 'js';
          transformSync(patched, { loader, logLevel: 'silent' });
          await fs.writeFile(vp, patched, 'utf-8');
          notes.push(`Configured ${vFile} base -> /w/${safeId}/`);
        }
      }
      break;
    } catch {}
  }

  // 4. Ensure cloned server.ts / server.js respects process.env.PORT (avoid hardcoded 3000 collision) and passes through /w/<safeId>/
  for (const sFile of ['server.ts', 'server.js']) {
    const sp = path.join(wsDir, sFile);
    try {
      const orig = await fs.readFile(sp, 'utf-8');
      let patched = orig;
      if (!/process\.env\.PORT/.test(patched)) {
        patched = patched
          .replace(/\b(const|let|var)\s+PORT\s*=\s*3000\b/g, '$1 PORT = Number(process.env.PORT) || 3000')
          .replace(/\.listen\(\s*3000\b/g, '.listen(Number(process.env.PORT) || 3000');
      }
      if (/app\.use\s*\(\s*['"]\/w\/:sessionId['"]\s*,\s*handleWorkspaceProxyRequest\s*\)/.test(patched)) {
        patched = patched.replace(
          /app\.use\s*\(\s*['"]\/w\/:sessionId['"]\s*,\s*handleWorkspaceProxyRequest\s*\)/g,
          `app.use('/w/:sessionId', (req, res, next) => req.params.sessionId === '${safeId}' ? next() : handleWorkspaceProxyRequest(req, res))`
        );
      }
      if (patched !== orig) {
        const loader = sFile.endsWith('.ts') ? 'ts' : 'js';
        transformSync(patched, { loader, logLevel: 'silent' });
        await fs.writeFile(sp, patched, 'utf-8');
        notes.push(`Patched ${sFile} for sandbox port & /w/${safeId}/ routing`);
      }
    } catch {}
  }

  return notes;
}

export async function cloneGitHubRepoToWorkspace(options: {
  repo: string;
  sessionId?: string;
  branch?: string;
  autoStart?: boolean;
}): Promise<{
  success: boolean;
  repo?: string;
  cloneUrl?: string;
  sessionId: string;
  workspacePath: string;
  proxyUrl: string;
  files?: string[];
  migrationNotes?: string[];
  dependencyStatus?: { mode: string; note: string };
  serverStatus?: any;
  error?: string;
}> {
  const safeId = sanitizeSessionId(options.sessionId || 'default');
  const wsDir = getWorkspaceDir(safeId);
  const proxyUrl = `/w/${safeId}/`;

  const parsed = normalizeGitHubRepoSpec(options.repo);
  if (!parsed) {
    return {
      success: false,
      sessionId: safeId,
      workspacePath: `workspaces/${safeId}`,
      proxyUrl,
      error: `Invalid GitHub repository format: "${options.repo}". Expected "owner/repo" or "https://github.com/owner/repo".`,
    };
  }

  await stopWorkspaceServer(safeId).catch(() => {});
  await fs.rm(wsDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.dirname(wsDir), { recursive: true });

  const effectiveBranch = options.branch || parsed.branchFromUrl;
  const branchFlag = effectiveBranch ? ` --branch "${effectiveBranch.replace(/[^A-Za-z0-9_./-]/g, '')}"` : '';
  const token = process.env.GITHUB_TOKEN?.trim();
  const authPrefix = token
    ? `-c http.https://github.com/.extraheader="AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}" `
    : '';
  const gitCmd = `git ${authPrefix}clone --depth 1${branchFlag} "${parsed.cloneUrl}" "${wsDir}"`;

  try {
    await execPromise(gitCmd, {
      cwd: process.cwd(),
      timeout: 120000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (cloneErr: any) {
    const cleanErr = String(cloneErr?.stderr || cloneErr?.message || 'Git clone failed').replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: ***');
    return {
      success: false,
      repo: parsed.slug,
      cloneUrl: parsed.cloneUrl,
      sessionId: safeId,
      workspacePath: `workspaces/${safeId}`,
      proxyUrl,
      error: cleanErr.slice(0, 1200),
    };
  }

  const migrationNotes = await normalizeClonedWorkspaceForPreview(wsDir, safeId);
  const dependencyStatus = await ensureWorkspaceDependencies(wsDir, true);

  const topEntries = await fs.readdir(wsDir, { withFileTypes: true }).catch(() => []);
  const files = topEntries
    .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .slice(0, 40);

  let serverStatus: any = undefined;
  if (options.autoStart !== false) {
    serverStatus = await startWorkspaceServer(safeId);
  }

  return {
    success: true,
    repo: parsed.slug,
    cloneUrl: parsed.cloneUrl,
    sessionId: safeId,
    workspacePath: `workspaces/${safeId}`,
    proxyUrl,
    files,
    migrationNotes,
    dependencyStatus,
    serverStatus,
  };
}

export async function startWorkspaceServer(
  sessionId: string = 'default',
  customCommand?: string
) {
  const safeId = sanitizeSessionId(sessionId);
  const existingFlight = inFlightStarts.get(safeId);
  if (existingFlight) {
    return existingFlight;
  }
  const promise = startWorkspaceServerInternal(safeId, customCommand).finally(() => {
    inFlightStarts.delete(safeId);
  });
  inFlightStarts.set(safeId, promise);
  return promise;
}

async function startWorkspaceServerInternal(
  safeId: string,
  customCommand?: string
): Promise<{
  success: boolean;
  sessionId: string;
  status: string;
  port?: number;
  proxyUrl: string;
  logs?: string[];
  error?: string;
}> {
  const wsDir = getWorkspaceDir(safeId);
  const proxyUrl = `/w/${safeId}/`;

  const exists = await fs.access(wsDir).then(() => true).catch(() => false);
  if (!exists) {
    return {
      success: false,
      sessionId: safeId,
      status: 'missing',
      proxyUrl,
      error: `Workspace workspaces/${safeId} does not exist yet. Call workspace_init first.`,
    };
  }

  // Reuse if already running
  const existing = activeWorkspaces.get(safeId);
  if (existing && existing.status === 'running' && existing.process && !existing.process.killed) {
    return {
      success: true,
      sessionId: safeId,
      status: 'running',
      port: existing.port,
      proxyUrl,
      logs: existing.logs.slice(-15),
    };
  }

  // Enforce memory-safe cap on Render Free by evicting oldest sub-server
  if (activeWorkspaces.size >= MAX_CONCURRENT_SUBSERVERS) {
    const oldest = Array.from(activeWorkspaces.values()).sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) {
      await stopWorkspaceServer(oldest.sessionId);
    }
  }

  const hasServerTs = await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false);
  const hasServerJs = await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false);
  const hasVite =
    (await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.js')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.mjs')).then(() => true).catch(() => false));

  if (hasServerTs || hasServerJs || hasVite) {
    await ensureWorkspaceDependencies(wsDir).catch(() => null);
  }

  const port = await allocateEphemeralPort();
  const rootBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');
  const tsxBin = path.join(rootBinDir, 'tsx');
  const viteBin = path.join(rootBinDir, 'vite');
  const hasLocalTsx = await fs.access(tsxBin).then(() => true).catch(() => false);
  const hasLocalVite = await fs.access(viteBin).then(() => true).catch(() => false);

  let cmd = customCommand?.trim();
  if (!cmd) {
    if (hasServerTs) cmd = hasLocalTsx ? `"${tsxBin}" server.ts` : `npx tsx server.ts`;
    else if (hasServerJs) cmd = `node server.js`;
    else if (hasVite) cmd = hasLocalVite ? `"${viteBin}" --port ${port} --host 127.0.0.1 --base /w/${safeId}/` : `npx vite --port ${port} --host 127.0.0.1 --base /w/${safeId}/`;
    else {
      // Static workspace: no background daemon needed, /w/:sessionId/ serves static files directly
      return {
        success: true,
        sessionId: safeId,
        status: 'static_ready',
        proxyUrl,
      };
    }
  }

  const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
  const child = spawn('bash', ['-c', cmd], {
    cwd: wsDir,
    env: {
      ...process.env,
      PORT: String(port),
      DISABLE_HMR: 'true',
      ENABLE_HMR: 'false',
      NODE_PATH: [process.env.NODE_PATH, rootNodeModules].filter(Boolean).join(':'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const runtime: WorkspaceRuntime = {
    sessionId: safeId,
    dir: wsDir,
    port,
    pid: child.pid,
    command: cmd,
    status: 'starting',
    proxyUrl,
    startedAt: Date.now(),
    logs: [],
    process: child,
  };
  activeWorkspaces.set(safeId, runtime);

  const pushLog = (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const l of lines) {
      runtime.logs.push(l.slice(0, 300));
      if (runtime.logs.length > 60) runtime.logs.shift();
    }
  };
  child.stdout?.on('data', pushLog);
  child.stderr?.on('data', pushLog);
  child.on('exit', (code) => {
    runtime.status = code === 0 ? 'stopped' : 'error';
  });

  // Poll 127.0.0.1:port up to 35s until listening (check both /w/<safeId>/ and / for cloned apps)
  let listening = false;
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (runtime.status === 'error' || runtime.status === 'stopped') break;
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/w/${safeId}/`, { signal: AbortSignal.timeout(900) });
      if (probe.status > 0 && probe.status !== 404) {
        listening = true;
        break;
      }
      const rootProbe = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(900) });
      if (rootProbe.status > 0) {
        listening = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  if (listening) {
    runtime.status = 'running';
    return {
      success: true,
      sessionId: safeId,
      status: 'running',
      port,
      proxyUrl,
      logs: runtime.logs.slice(-12),
    };
  }

  return {
    success: false,
    sessionId: safeId,
    status: runtime.status,
    port,
    proxyUrl,
    logs: runtime.logs.slice(-20),
    error: `Sub-server failed to bind port ${port} within 25s.`,
  };
}

export async function stopWorkspaceServer(sessionId: string): Promise<{ success: boolean; sessionId: string }> {
  const safeId = sanitizeSessionId(sessionId);
  const rt = activeWorkspaces.get(safeId);
  if (rt?.process && !rt.process.killed) {
    try {
      rt.process.kill('SIGTERM');
    } catch {}
  }
  activeWorkspaces.delete(safeId);
  return { success: true, sessionId: safeId };
}

async function copyDirectoryRecursive(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += await copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
      count++;
    }
  }
  return count;
}

export async function buildWorkspaceToStaticPreview(
  sessionId: string = 'default'
): Promise<{
  success: boolean;
  sessionId: string;
  status: string;
  previewUrl: string;
  proxyUrl: string;
  outputDir: string;
  builtFilesCount?: number;
  hasBackendServer?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}> {
  const safeId = sanitizeSessionId(sessionId);
  const wsDir = getWorkspaceDir(safeId);
  const projDir = path.resolve(process.cwd(), 'projects', safeId);
  const previewUrl = `/projects/${safeId}/index.html`;

  const exists = await fs.access(wsDir).then(() => true).catch(() => false);
  if (!exists) {
    return {
      success: false,
      sessionId: safeId,
      status: 'missing',
      previewUrl,
      proxyUrl: previewUrl,
      outputDir: `projects/${safeId}`,
      error: `Workspace workspaces/${safeId} does not exist yet. Call workspace_init first.`,
    };
  }

  const hasServerTs = await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false);
  const hasServerJs = await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false);
  const hasBackendServer = hasServerTs || hasServerJs;
  const hasVite =
    (await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.js')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.mjs')).then(() => true).catch(() => false));

  if (hasVite) {
    await ensureWorkspaceDependencies(wsDir).catch(() => null);
    const rootBinDir = path.resolve(process.cwd(), 'node_modules', '.bin');
    const viteBin = path.join(rootBinDir, 'vite');
    const hasLocalVite = await fs.access(viteBin).then(() => true).catch(() => false);
    const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
    const buildCmd = hasLocalVite
      ? `"${viteBin}" build --base="/projects/${safeId}/"`
      : `npx vite build --base="/projects/${safeId}/"`;

    try {
      const { stdout, stderr } = await execPromise(buildCmd, {
        cwd: wsDir,
        timeout: 90000,
        env: {
          ...process.env,
          CI: 'true',
          NODE_PATH: [process.env.NODE_PATH, rootNodeModules].filter(Boolean).join(':'),
        },
      });

      const distDir = path.join(wsDir, 'dist');
      const distIndex = path.join(distDir, 'index.html');
      const hasBuiltIndex = await fs.access(distIndex).then(() => true).catch(() => false);
      if (!hasBuiltIndex) {
        return {
          success: false,
          sessionId: safeId,
          status: 'build_error',
          previewUrl,
          proxyUrl: previewUrl,
          outputDir: `projects/${safeId}`,
          hasBackendServer,
          stdout: (stdout || '').slice(-1500),
          stderr: (stderr || '').slice(-1500),
          error: 'vite build finished but dist/index.html was not generated.',
        };
      }

      // Clean stale hashed assets before copying fresh production build into projects/<safeId>/
      await fs.rm(path.join(projDir, 'assets'), { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(projDir, { recursive: true });
      const builtFilesCount = await copyDirectoryRecursive(distDir, projDir);

      // Inject Nexus Runtime Error & Element Picker Bridge into built index.html
      const builtIndexPath = path.join(projDir, 'index.html');
      let builtHtml = await fs.readFile(builtIndexPath, 'utf-8');
      if (!builtHtml.includes('__nexusElementPicker')) {
        const headIdx = builtHtml.indexOf('</head>');
        builtHtml =
          headIdx !== -1
            ? builtHtml.slice(0, headIdx) + NEXUS_PREVIEW_BRIDGE_SCRIPT + builtHtml.slice(headIdx)
            : NEXUS_PREVIEW_BRIDGE_SCRIPT + builtHtml;
        await fs.writeFile(builtIndexPath, builtHtml, 'utf-8');
      }

      // Free RAM by stopping any running Vite dev sub-server for frontend-only / Firebase workspaces
      if (!hasBackendServer) {
        await stopWorkspaceServer(safeId).catch(() => {});
      }

      return {
        success: true,
        sessionId: safeId,
        status: 'built_static',
        previewUrl,
        proxyUrl: hasBackendServer ? `/w/${safeId}/` : previewUrl,
        outputDir: `projects/${safeId}`,
        builtFilesCount,
        hasBackendServer,
        stdout: (stdout || '').trim().slice(-1200),
      };
    } catch (err: any) {
      return {
        success: false,
        sessionId: safeId,
        status: 'build_error',
        previewUrl,
        proxyUrl: previewUrl,
        outputDir: `projects/${safeId}`,
        hasBackendServer,
        stdout: String(err?.stdout || '').slice(-1500),
        stderr: String(err?.stderr || '').slice(-1500),
        error: err?.message || 'vite build failed',
      };
    }
  }

  // Pure static workspace (no Vite): mirror files directly to projects/<safeId>/
  const staticIndex = path.join(wsDir, 'index.html');
  const hasStaticIndex = await fs.access(staticIndex).then(() => true).catch(() => false);
  if (hasStaticIndex) {
    await fs.mkdir(projDir, { recursive: true });
    const builtFilesCount = await copyDirectoryRecursive(wsDir, projDir);
    return {
      success: true,
      sessionId: safeId,
      status: 'built_static',
      previewUrl,
      proxyUrl: previewUrl,
      outputDir: `projects/${safeId}`,
      builtFilesCount,
      hasBackendServer,
    };
  }

  return {
    success: false,
    sessionId: safeId,
    status: 'missing_entry',
    previewUrl,
    proxyUrl: previewUrl,
    outputDir: `projects/${safeId}`,
    hasBackendServer,
    error: `No vite.config.* or index.html found in workspaces/${safeId}/`,
  };
}

export async function getWorkspaceStatus(sessionId?: string) {
  if (sessionId) {
    const safeId = sanitizeSessionId(sessionId);
    const rt = activeWorkspaces.get(safeId);
    const wsDir = getWorkspaceDir(safeId);
    const exists = await fs.access(wsDir).then(() => true).catch(() => false);
    const hasServer =
      (await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false)) ||
      (await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false));
    const hasStaticBuild = await fs
      .access(path.join(process.cwd(), 'projects', safeId, 'index.html'))
      .then(() => true)
      .catch(() => false);
    const preferStaticPreview = hasStaticBuild && !hasServer && rt?.status !== 'running';

    return {
      sessionId: safeId,
      exists,
      hasStaticBuild,
      hasBackendServer: hasServer,
      proxyUrl: preferStaticPreview ? `/projects/${safeId}/index.html` : `/w/${safeId}/`,
      running: rt?.status === 'running',
      port: rt?.port,
      status: rt?.status || (preferStaticPreview ? 'built_static' : exists ? 'idle' : 'missing'),
      logs: rt?.logs?.slice(-15) || [],
    };
  }

  const dirs = await fs.readdir(WORKSPACES_ROOT, { withFileTypes: true }).catch(() => []);
  return {
    workspaces: dirs
      .filter((d) => d.isDirectory())
      .map((d) => {
        const rt = activeWorkspaces.get(d.name);
        return {
          sessionId: d.name,
          proxyUrl: `/w/${d.name}/`,
          status: rt?.status || 'idle',
          port: rt?.port,
        };
      }),
  };
}

// Express middleware to reverse-proxy /w/:sessionId/* -> running sub-server OR static workspace folder
export async function handleWorkspaceProxyRequest(req: Request, res: Response) {
  const safeId = sanitizeSessionId(req.params.sessionId);
  const wsDir = getWorkspaceDir(safeId);
  let rt = activeWorkspaces.get(safeId);

  // Strip /w/:sessionId prefix cleanly
  const prefix = `/w/${req.params.sessionId}`;
  const rawRemaining = req.originalUrl.startsWith(prefix)
    ? req.originalUrl.slice(prefix.length) || '/'
    : req.url || '/';
  const targetSubPath = rawRemaining.startsWith('/') ? rawRemaining : `/${rawRemaining}`;

  // Ensure root /w/:sessionId has trailing slash so relative asset/module URLs resolve inside the sandbox
  const rawPathOnly = req.originalUrl.split('?')[0];
  if (req.method === 'GET' && targetSubPath === '/' && !rawPathOnly.endsWith('/')) {
    const querySuffix = req.originalUrl.includes('?') ? `?${req.originalUrl.split('?')[1]}` : '';
    return res.redirect(302, `${rawPathOnly}/${querySuffix}`);
  }

  const hasVite =
    (await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.js')).then(() => true).catch(() => false)) ||
    (await fs.access(path.join(wsDir, 'vite.config.mjs')).then(() => true).catch(() => false));
  const hasServerTs = await fs.access(path.join(wsDir, 'server.ts')).then(() => true).catch(() => false);
  const hasServerJs = await fs.access(path.join(wsDir, 'server.js')).then(() => true).catch(() => false);
  const hasDistIndex = await fs.access(path.join(wsDir, 'dist', 'index.html')).then(() => true).catch(() => false);

  // Auto-boot workspace sub-server on demand if it is stopped/cold and needs Vite or Express API
  if ((!rt || rt.status !== 'running') && (hasVite || hasServerTs || hasServerJs)) {
    const needsLiveServer = !hasDistIndex || targetSubPath.startsWith('/api') || targetSubPath.startsWith('/src/') || targetSubPath.startsWith('/@vite');
    if (needsLiveServer) {
      await startWorkspaceServer(safeId).catch(() => null);
      rt = activeWorkspaces.get(safeId);
    }
  }

  if (rt && rt.status === 'running') {
    try {
      const viteCfgRaw = hasVite
        ? await Promise.any([
            fs.readFile(path.join(wsDir, 'vite.config.ts'), 'utf-8'),
            fs.readFile(path.join(wsDir, 'vite.config.js'), 'utf-8'),
            fs.readFile(path.join(wsDir, 'vite.config.mjs'), 'utf-8'),
          ]).catch(() => '')
        : '';
      const hasWorkspaceBase = viteCfgRaw.includes(`/w/${safeId}`) || rt.command.includes(`/w/${safeId}`);
      const isApiCall = targetSubPath.startsWith('/api');
      const upstreamPath = isApiCall
        ? targetSubPath
        : hasVite
          ? (hasWorkspaceBase ? req.originalUrl : targetSubPath)
          : targetSubPath;
      const targetUrl = `http://127.0.0.1:${rt.port}${upstreamPath}`;
      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (k === 'host' || k === 'connection' || k === 'content-length') continue;
        if (typeof v === 'string') fwdHeaders[k] = v;
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase());
      const bodyPayload =
        hasBody && req.body !== undefined
          ? typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body)
          : undefined;
      if (bodyPayload && !fwdHeaders['content-type']) {
        fwdHeaders['content-type'] = 'application/json';
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers: fwdHeaders,
        body: bodyPayload,
        signal: AbortSignal.timeout(12000),
      });

      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type') || '';
      upstream.headers.forEach((val, key) => {
        if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
          res.setHeader(key, val);
        }
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (targetSubPath.startsWith('/@vite/client') || req.originalUrl.includes('/@vite/client')) {
        let safeCode = buf
          .toString('utf-8')
          .replace(/\bws\.send\(/g, 'ws?.send(')
          .replace(/await wsTransport\.connect\(handlers\);/g, 'return;');
        if (!hasWorkspaceBase) {
          safeCode = safeCode.replace(/(["'])\/(?=@vite\/|@react-refresh|@fs\/|src\/|node_modules\/)/g, `$1/w/${safeId}/`);
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(safeCode);
        return;
      }
      if (!hasWorkspaceBase && (contentType.includes('javascript') || contentType.includes('ecmascript'))) {
        const rewrittenJs = buf
          .toString('utf-8')
          .replace(/(["'])\/(?=@vite\/|@react-refresh|@fs\/|@id\/|src\/|node_modules\/)/g, `$1/w/${safeId}/`);
        res.send(rewrittenJs);
        return;
      }
      if (contentType.includes('text/html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        let html = buf.toString('utf-8');
        if (!hasWorkspaceBase) {
          html = html.replace(
            /((?:src|href)=["'])\/(?!w\/|generated\/|\/)([^"']+["'])/gi,
            `$1/w/${safeId}/$2`
          );
          if (!html.includes('<base ')) {
            html = html.replace(/<head([^>]*)>/i, `<head$1><base href="/w/${safeId}/">`);
          }
        }
        const apiProxyShim = `<script>(function(){if(window.__nexusApiPrefixShim)return;window.__nexusApiPrefixShim=true;var origFetch=window.fetch;if(typeof origFetch==='function'){window.fetch=function(input,init){try{if(typeof input==='string'&&input.startsWith('/api/')){input='/w/${safeId}'+input;}else if(input instanceof Request&&input.url){var u=new URL(input.url,window.location.origin);if(u.origin===window.location.origin&&u.pathname.startsWith('/api/')){input=new Request('/w/${safeId}'+u.pathname+u.search,input);}}}catch(e){}return origFetch.call(this,input,init);};}})();</script>`;
        if (!html.includes('__nexusApiPrefixShim')) {
          const idx = html.indexOf('</head>');
          html = idx !== -1
            ? html.slice(0, idx) + apiProxyShim + html.slice(idx)
            : apiProxyShim + html;
        }
        if (!html.includes('__nexusElementPicker')) {
          const idx = html.indexOf('</head>');
          html = idx !== -1
            ? html.slice(0, idx) + NEXUS_PREVIEW_BRIDGE_SCRIPT + html.slice(idx)
            : NEXUS_PREVIEW_BRIDGE_SCRIPT + html;
        }
        res.send(html);
        return;
      }
      res.send(buf);
      return;
    } catch (err: any) {
      // If upstream failed transiently and dist/index.html exists, allow falling through to static dist/
      if (!hasDistIndex || targetSubPath.startsWith('/api')) {
        res.status(502).json({ error: `Sandbox proxy upstream error: ${err?.message}` });
        return;
      }
    }
  }

  // Fallback static serving from dist/ -> public/ -> workspace root (never serve raw unbuilt Vite entry index.html)
  const cleanFile = targetSubPath.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const candidates = [
    path.join(wsDir, 'dist', cleanFile),
    path.join(wsDir, 'public', cleanFile),
    ...(hasVite ? [] : [path.join(wsDir, cleanFile)]),
    path.join(wsDir, 'dist', 'index.html'),
    path.join(wsDir, 'public', 'index.html'),
    ...(hasVite ? [] : [path.join(wsDir, 'index.html')]),
  ];
  for (const cand of candidates) {
    if (!cand.startsWith(wsDir)) continue;
    try {
      const st = await fs.stat(cand);
      if (st.isFile() && st.size > 0) {
        if (cand.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          let html = await fs.readFile(cand, 'utf-8');
          if (!html.includes('<base ')) {
            html = html.replace(/<head([^>]*)>/i, `<head$1><base href="/w/${safeId}/">`);
          }
          if (!html.includes('__nexusElementPicker')) {
            const idx = html.indexOf('</head>');
            html = idx !== -1
              ? html.slice(0, idx) + NEXUS_PREVIEW_BRIDGE_SCRIPT + html.slice(idx)
              : NEXUS_PREVIEW_BRIDGE_SCRIPT + html;
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(html);
          return;
        }
        res.sendFile(cand);
        return;
      }
    } catch {}
  }

  if (hasVite) {
    const errLogs = (rt?.logs || []).slice(-8).join('\n').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const isErr = rt?.status === 'error';
    res.status(isErr ? 500 : 503).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-3">
    <h2 class="text-base font-bold text-white">${isErr ? 'Workspace Build / Server Error' : 'Workspace Preview Starting...'}</h2>
    <p class="text-xs text-slate-400">${isErr ? 'স্যান্ডবক্স সার্ভারটি চালু হতে গিয়ে নিচের সমস্যায় পড়েছে:' : 'স্যান্ডবক্স সার্ভারটি চালু হচ্ছে — স্বয়ংক্রিয়ভাবে রিলোড হবে।'}</p>
    ${errLogs ? `<pre class="text-left text-[11px] text-rose-300 bg-slate-950 border border-rose-500/30 rounded-xl p-3 overflow-x-auto max-h-40">${errLogs}</pre>` : ''}
    <button onclick="location.reload()" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer">Reload Preview</button>
  </div>
  ${isErr ? '' : '<script>setTimeout(function(){ location.reload(); }, 2500);</script>'}
</body>
</html>`);
    return;
  }

  res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-6 font-sans">
  <div class="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-3">
    <h2 class="text-base font-bold text-white">Preview Not Generated Yet</h2>
    <p class="text-xs text-slate-400">এই ওয়ার্কস্পেসে (${safeId}) এখনো কোনো প্রিভিউ ফাইল বা সার্ভার তৈরি হয়নি। চ্যাটে যেকোনো অ্যাপ বা ওয়েবসাইট বানাতে বলুন।</p>
    <button onclick="location.reload()" class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer">Check Again</button>
  </div>
</body>
</html>`);
}
