import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Octokit } from 'octokit';
import { sanitizeSessionId } from './sandboxManager.ts';

const execPromise = promisify(exec);

export type SessionProjectKind = 'react-vite' | 'fullstack-vite' | 'static-workspace' | 'static-pwa' | 'html-fallback' | 'none';

export interface SessionProjectInfo {
  exists: boolean;
  safeSessionId: string;
  source: 'workspace' | 'projects' | 'fallback' | 'none';
  kind: SessionProjectKind;
  rootDir: string;
  fileCount: number;
  files: string[];
  hasViteConfig: boolean;
  hasPackageJson: boolean;
  hasBackendServer: boolean;
  suggestedRepoName: string;
}

export interface DeployProgressEvent {
  step: 'resolve' | 'build' | 'repo' | 'push' | 'pages' | 'done' | 'error';
  status: 'running' | 'completed' | 'error';
  message: string;
  detail?: string;
}

export interface DeployGitHubPagesOptions {
  sessionId?: string;
  sessionTitle?: string;
  token?: string;
  repoName: string;
  description?: string;
  isPrivate?: boolean;
  ifExists?: 'error' | 'update';
  htmlFallback?: string;
  onProgress?: (event: DeployProgressEvent) => void;
}

export interface DeployGitHubPagesResult {
  success: boolean;
  repoUrl?: string;
  pagesUrl?: string;
  owner?: string;
  repoName?: string;
  branch?: string;
  pagesStatus?: string;
  projectKind?: SessionProjectKind;
  filesPublishedCount?: number;
  buildLogs?: string;
  warnings?: string[];
  error?: string;
}

const IGNORE_COPY_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.nexus_checkpoints',
  'nexus-project.zip',
]);

function redactToken(text: string, token?: string): string {
  let cleaned = String(text || '');
  if (token) {
    cleaned = cleaned.split(token).join('***');
  }
  cleaned = cleaned.replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
  return cleaned;
}

export function sanitizeRepoName(rawName: string, fallback = 'nexus-web-app'): string {
  const cleaned = String(rawName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/\.git$/i, '');
  return (cleaned || fallback).slice(0, 90);
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function listFilesRecursive(dir: string, baseDir = dir): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const results: string[] = [];
  for (const entry of entries) {
    if (IGNORE_COPY_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(full, baseDir)));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort((a, b) => a.localeCompare(b));
}

async function copyDirFiltered(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (IGNORE_COPY_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export async function inspectSessionProject(
  rawSessionId?: string,
  sessionTitle?: string,
  hasHtmlFallback = false
): Promise<SessionProjectInfo> {
  const safeSessionId = rawSessionId ? sanitizeSessionId(rawSessionId) : '';
  const baseSlug = sanitizeRepoName(
    sessionTitle || (safeSessionId ? safeSessionId.replace(/^session_/, 'nexus-app-') : 'nexus-web-app'),
    'nexus-web-app'
  );

  if (safeSessionId) {
    const wsDir = path.join(process.cwd(), 'workspaces', safeSessionId);
    if (await pathExists(wsDir)) {
      const files = await listFilesRecursive(wsDir);
      if (files.length > 0) {
        const hasViteConfig = files.includes('vite.config.ts') || files.includes('vite.config.js');
        const hasPackageJson = files.includes('package.json');
        const hasBackendServer = files.includes('server.ts') || files.includes('server.js');
        const kind: SessionProjectKind = hasViteConfig
          ? hasBackendServer
            ? 'fullstack-vite'
            : 'react-vite'
          : 'static-workspace';
        return {
          exists: true,
          safeSessionId,
          source: 'workspace',
          kind,
          rootDir: wsDir,
          fileCount: files.length,
          files,
          hasViteConfig,
          hasPackageJson,
          hasBackendServer,
          suggestedRepoName: baseSlug,
        };
      }
    }

    const projDir = path.join(process.cwd(), 'projects', safeSessionId);
    if (await pathExists(projDir)) {
      const files = await listFilesRecursive(projDir);
      const indexStat = await fs.stat(path.join(projDir, 'index.html')).catch(() => null);
      if (files.length > 0 && (!indexStat || indexStat.size > 20)) {
        return {
          exists: true,
          safeSessionId,
          source: 'projects',
          kind: 'static-pwa',
          rootDir: projDir,
          fileCount: files.length,
          files,
          hasViteConfig: false,
          hasPackageJson: false,
          hasBackendServer: false,
          suggestedRepoName: baseSlug,
        };
      }
    }
  }

  if (hasHtmlFallback) {
    return {
      exists: true,
      safeSessionId: safeSessionId || 'session_html',
      source: 'fallback',
      kind: 'html-fallback',
      rootDir: '',
      fileCount: 1,
      files: ['index.html'],
      hasViteConfig: false,
      hasPackageJson: false,
      hasBackendServer: false,
      suggestedRepoName: baseSlug,
    };
  }

  // Final check: global projects/index.html only when no sessionId was passed
  if (!safeSessionId) {
    const globalIndex = path.join(process.cwd(), 'projects', 'index.html');
    const st = await fs.stat(globalIndex).catch(() => null);
    if (st && st.size > 40) {
      return {
        exists: true,
        safeSessionId: 'global',
        source: 'projects',
        kind: 'static-pwa',
        rootDir: path.join(process.cwd(), 'projects'),
        fileCount: 1,
        files: ['index.html'],
        hasViteConfig: false,
        hasPackageJson: false,
        hasBackendServer: false,
        suggestedRepoName: baseSlug,
      };
    }
  }

  return {
    exists: false,
    safeSessionId,
    source: 'none',
    kind: 'none',
    rootDir: '',
    fileCount: 0,
    files: [],
    hasViteConfig: false,
    hasPackageJson: false,
    hasBackendServer: false,
    suggestedRepoName: baseSlug,
  };
}

/**
 * Strip Nexus internal preview bridge scripts and rewrite root-relative public/generated asset URLs
 * so the deployed bundle works cleanly under https://<user>.github.io/<repo>/
 */
function stripNexusPreviewBridge(html: string): string {
  return html
    .replace(/<!--\s*Nexus Runtime Error[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<script>\s*\(function\(\)\s*\{\s*if\s*\(\s*!?window\.__nexusErrorBridge[\s\S]*?<\/script>\s*/gi, '')
    .replace(/<base\s+href=["']\/(?:w\/[^"']*)?["']\s*\/?>/gi, '');
}

async function copyReferencedPublicAssets(
  scanDirs: string[],
  publicDestDir: string,
  basePath: string
): Promise<void> {
  const rootPublicDir = path.resolve(process.cwd(), 'public');
  const standardPwaAssets = ['icon.svg', 'pwa-192x192.png', 'pwa-512x512.png', 'apple-touch-icon.png', 'favicon.ico'];
  const generatedRefs = new Set<string>();
  const usedPwaAssets = new Set<string>();

  const textExts = new Set(['.html', '.htm', '.tsx', '.ts', '.jsx', '.js', '.css', '.webmanifest', '.json']);

  const walkAndRewrite = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORE_COPY_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkAndRewrite(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!textExts.has(ext)) continue;

      let content = await fs.readFile(full, 'utf-8').catch(() => '');
      if (!content) continue;
      let changed = false;

      if (ext === '.html' || ext === '.htm') {
        const stripped = stripNexusPreviewBridge(content);
        if (stripped !== content) {
          content = stripped;
          changed = true;
        }
      }

      // Detect /generated/<file> references
      const genMatches = content.match(/\/generated\/([a-zA-Z0-9_.-]+)/g);
      if (genMatches) {
        for (const m of genMatches) {
          generatedRefs.add(m.replace(/^\/generated\//, ''));
        }
        const normalizedPrefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
        const rewritten = content.replace(/(["'`(])\/generated\//g, `$1${normalizedPrefix}generated/`);
        if (rewritten !== content) {
          content = rewritten;
          changed = true;
        }
      }

      // Detect root-relative PWA / icon references
      const normalizedPrefix = basePath.endsWith('/') ? basePath : `${basePath}/`;
      for (const assetName of standardPwaAssets) {
        if (content.includes(`/${assetName}`)) {
          usedPwaAssets.add(assetName);
          const re = new RegExp(`(["'\`(])\\/${assetName.replace('.', '\\.')}`, 'g');
          const rewritten = content.replace(re, `$1${normalizedPrefix}${assetName}`);
          if (rewritten !== content) {
            content = rewritten;
            changed = true;
          }
        }
      }

      if (changed) {
        await fs.writeFile(full, content, 'utf-8');
      }
    }
  };

  for (const dir of scanDirs) {
    await walkAndRewrite(dir);
  }

  // Copy referenced /generated/* images into publicDestDir/generated/
  if (generatedRefs.size > 0) {
    const genDest = path.join(publicDestDir, 'generated');
    await fs.mkdir(genDest, { recursive: true });
    for (const fileName of generatedRefs) {
      const src = path.join(rootPublicDir, 'generated', fileName);
      if (await pathExists(src)) {
        await fs.copyFile(src, path.join(genDest, fileName)).catch(() => {});
      }
    }
  }

  // Copy referenced PWA icons
  if (usedPwaAssets.size > 0) {
    await fs.mkdir(publicDestDir, { recursive: true });
    for (const assetName of usedPwaAssets) {
      const src = path.join(rootPublicDir, assetName);
      if (await pathExists(src)) {
        await fs.copyFile(src, path.join(publicDestDir, assetName)).catch(() => {});
      }
    }
  }
}

function createGitHubActionsWorkflow(basePath: string): string {
  return `name: Deploy to GitHub Pages

on:
  push:
    branches: ["main"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Install dependencies
        run: npm install
      - name: Build with Vite
        run: npx vite build --base="${basePath}"
      - name: Add SPA 404 fallback
        run: cp dist/index.html dist/404.html && touch dist/.nojekyll
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: ./dist

  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

export async function deploySessionToGitHubPages(
  options: DeployGitHubPagesOptions
): Promise<DeployGitHubPagesResult> {
  const token = (options.token || process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    return {
      success: false,
      error: 'GitHub Personal Access Token (PAT) is required to create a repository and deploy to GitHub Pages.',
    };
  }

  const emit = (
    step: DeployProgressEvent['step'],
    status: DeployProgressEvent['status'],
    message: string,
    detail?: string
  ) => {
    options.onProgress?.({ step, status, message, detail });
  };

  const warnings: string[] = [];
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-ghpages-'));
  const sourceDir = path.join(tmpRoot, 'source');
  const buildOutDir = path.join(tmpRoot, 'dist-out');

  try {
    // 1. Authenticate GitHub User
    emit('resolve', 'running', 'Authenticating with GitHub & inspecting current session...');
    const octokit = new Octokit({ auth: token });
    const { data: ghUser } = await octokit.rest.users.getAuthenticated();
    const owner = ghUser.login;

    // 2. Inspect Session Project
    const projectInfo = await inspectSessionProject(
      options.sessionId,
      options.sessionTitle,
      Boolean(options.htmlFallback && options.htmlFallback.trim().length > 20)
    );

    if (!projectInfo.exists) {
      emit('resolve', 'error', 'No generated project found in this session.');
      return {
        success: false,
        error: 'এই সেশনে এখনো কোনো জেনারেটেড প্রজেক্ট বা ওয়েবসাইট পাওয়া যায়নি। আগে চ্যাটে একটি অ্যাপ বা ওয়েবসাইট তৈরি করুন।',
      };
    }

    const repoName = sanitizeRepoName(options.repoName || projectInfo.suggestedRepoName);
    const isUserSiteRepo = repoName.toLowerCase() === `${owner.toLowerCase()}.github.io`;
    const basePath = isUserSiteRepo ? '/' : `/${repoName}/`;
    const expectedPagesUrl = isUserSiteRepo
      ? `https://${owner}.github.io/`
      : `https://${owner}.github.io/${repoName}/`;

    emit(
      'resolve',
      'completed',
      `Resolved ${projectInfo.kind} project (${projectInfo.fileCount} files)`,
      `Target: ${owner}/${repoName} (base: ${basePath})`
    );

    // 3. Prepare Source & Build Production Bundle
    emit('build', 'running', 'Preparing source files & building production bundle for GitHub Pages...');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(buildOutDir, { recursive: true });

    let buildLogs = '';

    if (projectInfo.source === 'workspace' && projectInfo.hasViteConfig) {
      // Copy modular Vite project to isolated staging directory
      await copyDirFiltered(projectInfo.rootDir, sourceDir);

      // Update vite.config.ts base path for GitHub Pages portability
      const viteCfgPath = path.join(sourceDir, 'vite.config.ts');
      if (await pathExists(viteCfgPath)) {
        let viteCfg = await fs.readFile(viteCfgPath, 'utf-8');
        if (/base\s*:\s*['"`][^'"`]*['"`]/.test(viteCfg)) {
          viteCfg = viteCfg.replace(/base\s*:\s*['"`][^'"`]*['"`]/, `base: '${basePath}'`);
        } else {
          viteCfg = viteCfg.replace(/defineConfig\(\{/, `defineConfig({\n  base: '${basePath}',`);
        }
        await fs.writeFile(viteCfgPath, viteCfg, 'utf-8');
      }

      // Copy & rewrite any referenced /generated/* or /icon.svg assets into sourceDir/public
      await copyReferencedPublicAssets([sourceDir], path.join(sourceDir, 'public'), basePath);

      // Temporarily symlink root node_modules for fast Vite production build
      const rootNodeModules = path.resolve(process.cwd(), 'node_modules');
      const stagedNodeModules = path.join(sourceDir, 'node_modules');
      await fs.symlink(rootNodeModules, stagedNodeModules, 'dir');

      const viteBin = path.join(rootNodeModules, '.bin', 'vite');
      const hasLocalVite = await pathExists(viteBin);
      const viteCmd = hasLocalVite
        ? `"${viteBin}" build --base="${basePath}" --outDir="${buildOutDir}"`
        : `npx vite build --base="${basePath}" --outDir="${buildOutDir}"`;

      try {
        const { stdout, stderr } = await execPromise(viteCmd, {
          cwd: sourceDir,
          timeout: 120000,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            NODE_PATH: [process.env.NODE_PATH, rootNodeModules].filter(Boolean).join(':'),
          },
        });
        buildLogs = [stdout, stderr].filter(Boolean).join('\n').trim();
      } finally {
        // Remove temporary symlink before git commit
        await fs.unlink(stagedNodeModules).catch(() => {});
      }

      // Verify build output exists
      const builtIndex = path.join(buildOutDir, 'index.html');
      if (!(await pathExists(builtIndex))) {
        throw new Error('Vite production build completed but dist/index.html was not generated.');
      }

      // Strip Nexus bridge script if any crept into built HTML & create SPA 404 fallback + .nojekyll
      const builtHtml = stripNexusPreviewBridge(await fs.readFile(builtIndex, 'utf-8'));
      await fs.writeFile(builtIndex, builtHtml, 'utf-8');
      await fs.writeFile(path.join(buildOutDir, '404.html'), builtHtml, 'utf-8');
      await fs.writeFile(path.join(buildOutDir, '.nojekyll'), '', 'utf-8');

      // Add GitHub Actions workflow + .gitignore + README to main source branch
      await fs.mkdir(path.join(sourceDir, '.github', 'workflows'), { recursive: true });
      await fs.writeFile(
        path.join(sourceDir, '.github', 'workflows', 'deploy-pages.yml'),
        createGitHubActionsWorkflow(basePath),
        'utf-8'
      );
      await fs.writeFile(path.join(sourceDir, '.gitignore'), 'node_modules\ndist\n.env\n.DS_Store\n', 'utf-8');

      if (projectInfo.hasBackendServer) {
        warnings.push(
          'This session includes server files (server.ts). GitHub Pages hosts the static frontend build (gh-pages); backend API routes require a Node host.'
        );
      }
    } else {
      // Static workspace, static PWA folder, or HTML fallback
      if (projectInfo.source === 'fallback' && options.htmlFallback) {
        let html = options.htmlFallback.trim();
        if (!html.toLowerCase().includes('<!doctype html>')) {
          html = `<!DOCTYPE html>\n${html}`;
        }
        await fs.writeFile(path.join(sourceDir, 'index.html'), html, 'utf-8');
      } else {
        await copyDirFiltered(projectInfo.rootDir, sourceDir);
      }

      await copyReferencedPublicAssets([sourceDir], sourceDir, './');
      await copyDirFiltered(sourceDir, buildOutDir);
      await fs.writeFile(path.join(buildOutDir, '.nojekyll'), '', 'utf-8');

      const indexHtmlPath = path.join(buildOutDir, 'index.html');
      if (await pathExists(indexHtmlPath)) {
        const indexHtml = await fs.readFile(indexHtmlPath, 'utf-8');
        await fs.writeFile(path.join(buildOutDir, '404.html'), indexHtml, 'utf-8');
      }
      buildLogs = 'Static & PWA assets bundled cleanly with relative paths and .nojekyll.';
    }

    // Generate clean README.md on main branch if missing
    const readmePath = path.join(sourceDir, 'README.md');
    if (!(await pathExists(readmePath))) {
      const displayTitle = options.sessionTitle || repoName;
      await fs.writeFile(
        readmePath,
        `# ${displayTitle}\n\nBuilt and deployed to GitHub Pages with Nexus AI.\n\n- **Live Site:** ${expectedPagesUrl}\n- **Project Type:** ${projectInfo.kind}\n`,
        'utf-8'
      );
    }

    const builtFiles = await listFilesRecursive(buildOutDir);
    emit(
      'build',
      'completed',
      `Build ready (${builtFiles.length} output files)`,
      buildLogs.split('\n').slice(-4).join(' | ')
    );

    // 4. Create (or verify) GitHub Repository
    emit('repo', 'running', `Creating GitHub repository ${owner}/${repoName}...`);
    let repoUrl = `https://github.com/${owner}/${repoName}`;
    let repoExists = false;

    try {
      const { data: existingRepo } = await octokit.rest.repos.get({ owner, repo: repoName });
      repoExists = true;
      repoUrl = existingRepo.html_url;
    } catch (err: any) {
      if (err?.status !== 404) {
        throw err;
      }
    }

    if (repoExists) {
      if (options.ifExists === 'error') {
        emit('repo', 'error', `Repository ${owner}/${repoName} already exists.`);
        return {
          success: false,
          error: `Repository "${owner}/${repoName}" already exists. Choose a new repository name or enable "Update if repository exists".`,
        };
      }
      emit('repo', 'completed', `Using existing repository ${owner}/${repoName}`);
    } else {
      const { data: createdRepo } = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: Boolean(options.isPrivate),
        description: options.description || `${options.sessionTitle || 'Web App'} — Deployed via Nexus AI`,
        homepage: expectedPagesUrl,
        auto_init: false,
      });
      repoUrl = createdRepo.html_url;
      emit('repo', 'completed', `Created new repository ${owner}/${repoName}`);
    }

    // 5. Push main (source) and gh-pages (built output) from isolated temp repos
    emit('push', 'running', 'Pushing source (main) & built bundle (gh-pages) to GitHub...');
    const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`;
    const gitAuthorName = (ghUser.name || owner).replace(/["\r\n]/g, '');
    const gitAuthorEmail = (ghUser.email || `${owner}@users.noreply.github.com`).replace(/["\r\n]/g, '');

    const initCommitAndPush = async (dir: string, branch: string, msg: string) => {
      await execPromise(`git init -b ${branch}`, { cwd: dir });
      await execPromise(`git config user.name "${gitAuthorName}"`, { cwd: dir });
      await execPromise(`git config user.email "${gitAuthorEmail}"`, { cwd: dir });
      await execPromise(`git add -A`, { cwd: dir });
      await execPromise(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: dir });
      await execPromise(`git remote add origin "${remoteUrl}"`, { cwd: dir });
      await execPromise(`git push -u origin ${branch} --force`, { cwd: dir, timeout: 90000 });
    };

    await initCommitAndPush(sourceDir, 'main', 'feat: initial project source from Nexus AI');
    await initCommitAndPush(buildOutDir, 'gh-pages', 'deploy: production build for GitHub Pages');

    emit('push', 'completed', `Pushed main & gh-pages branches to ${owner}/${repoName}`);

    // 6. Enable & Configure GitHub Pages on gh-pages branch
    emit('pages', 'running', 'Enabling GitHub Pages deployment...');
    let finalPagesUrl = expectedPagesUrl;
    let pagesStatus = 'building';

    try {
      const pagesRes = await octokit.request('POST /repos/{owner}/{repo}/pages', {
        owner,
        repo: repoName,
        source: {
          branch: 'gh-pages',
          path: '/',
        },
      });
      finalPagesUrl = pagesRes.data?.html_url || expectedPagesUrl;
      pagesStatus = pagesRes.data?.status || 'building';
    } catch (pagesErr: any) {
      if (pagesErr?.status === 409) {
        try {
          await octokit.request('PUT /repos/{owner}/{repo}/pages', {
            owner,
            repo: repoName,
            source: {
              branch: 'gh-pages',
              path: '/',
            },
          });
          const infoRes = await octokit.request('GET /repos/{owner}/{repo}/pages', {
            owner,
            repo: repoName,
          });
          finalPagesUrl = infoRes.data?.html_url || expectedPagesUrl;
          pagesStatus = infoRes.data?.status || 'building';
        } catch (updateErr: any) {
          warnings.push(`GitHub Pages already configured; update note: ${updateErr?.message || 'check repo Settings -> Pages'}`);
        }
      } else if (pagesErr?.status === 422 && options.isPrivate) {
        warnings.push(
          'GitHub Free accounts only support GitHub Pages on public repositories. Make the repository public in GitHub Settings to publish Pages.'
        );
        pagesStatus = 'requires-public-repo';
      } else {
        warnings.push(
          `Code pushed to gh-pages, but automatic Pages activation returned (${pagesErr?.status || 'error'}): ${pagesErr?.message || 'Check Settings -> Pages'}`
        );
        pagesStatus = 'pending-manual-enable';
      }
    }

    emit('pages', 'completed', `GitHub Pages configured at ${finalPagesUrl}`);
    emit('done', 'completed', 'Deployment complete!', finalPagesUrl);

    return {
      success: true,
      repoUrl,
      pagesUrl: finalPagesUrl,
      owner,
      repoName,
      branch: 'gh-pages',
      pagesStatus,
      projectKind: projectInfo.kind,
      filesPublishedCount: builtFiles.length,
      buildLogs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  } catch (err: any) {
    const cleanMsg = redactToken(err?.message || 'Failed to deploy to GitHub Pages', token);
    emit('error', 'error', cleanMsg);
    return {
      success: false,
      error: cleanMsg,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function getGitHubPagesBuildStatus(params: {
  token?: string;
  owner: string;
  repo: string;
}): Promise<{
  configured: boolean;
  status?: string;
  htmlUrl?: string;
  buildStatus?: string;
  error?: string;
}> {
  const token = (params.token || process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    return { configured: false, error: 'Token required' };
  }
  const octokit = new Octokit({ auth: token });
  try {
    const { data: pages } = await octokit.request('GET /repos/{owner}/{repo}/pages', {
      owner: params.owner,
      repo: params.repo,
    });
    let buildStatus: string | undefined = pages.status || undefined;
    try {
      const { data: latest } = await octokit.request('GET /repos/{owner}/{repo}/pages/builds/latest', {
        owner: params.owner,
        repo: params.repo,
      });
      if (latest?.status) buildStatus = latest.status;
    } catch {}
    return {
      configured: true,
      status: pages.status || undefined,
      htmlUrl: pages.html_url || undefined,
      buildStatus,
    };
  } catch (err: any) {
    return {
      configured: false,
      error: redactToken(err?.message || 'Pages not enabled yet', token),
    };
  }
}
