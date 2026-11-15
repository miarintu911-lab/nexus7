import fs from 'fs/promises';
import path from 'path';
import vm from 'node:vm';
import { exec } from 'child_process';
import { promisify } from 'util';
import { JSDOM, VirtualConsole } from 'jsdom';
import { GoogleGenAI } from '@google/genai';
import {
  saveCheckpointToPersistence,
  loadCheckpointFromPersistence,
  listCheckpointsFromPersistence,
} from './persistenceStore.ts';

const execPromise = promisify(exec);

// ============================================================================
// 1. HEADLESS DOM & RUNTIME PREVIEW VERIFIER (JSDOM + Optional Playwright)
// ============================================================================

export interface PreviewVerificationResult {
  ok: boolean;
  engine: 'playwright' | 'jsdom';
  status?: number;
  url: string;
  title?: string;
  htmlBytes?: number;
  hasDocStructure?: boolean;
  hasClosedHtml?: boolean;
  hasPwaManifest?: boolean;
  hasServiceWorker?: boolean;
  googleFontsDetected?: boolean;
  scriptsChecked?: number;
  syntaxErrors: Array<{ scriptIndex: number; error: string }>;
  runtimeErrors: Array<{ source: string; message: string }>;
  consoleErrors: string[];
  domMetrics?: {
    renderedTextLength: number;
    interactiveElements: number;
    buttons: number;
    inputs: number;
    forms: number;
    canvases: number;
    imagesCount: number;
    emptyRootDetected: boolean;
  };
  interactionAudit?: {
    probedButtons: number;
    domMutationsObserved: number;
    clickErrors: string[];
    deadButtons: string[];
  };
  assetsCheckedCount: number;
  brokenAssets: Array<{ url: string; status: number | string }>;
  error?: string;
}

export async function verifyLivePreviewWithDom(
  rawTargetUrl?: string,
  checkAssets: boolean = true,
  sessionId?: string
): Promise<PreviewVerificationResult> {
  const port = Number(process.env.PORT) || 3000;
  const defaultPath = sessionId
    ? `/projects/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
    : '/projects/index.html';
  const rawTarget = String(rawTargetUrl || defaultPath).trim();
  const normalizedPath =
    rawTarget.startsWith('http://') || rawTarget.startsWith('https://')
      ? rawTarget
      : `http://127.0.0.1:${port}${rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`}`;

  const syntaxErrors: Array<{ scriptIndex: number; error: string }> = [];
  const runtimeErrors: Array<{ source: string; message: string }> = [];
  const consoleErrors: string[] = [];
  const brokenAssets: Array<{ url: string; status: number | string }> = [];
  let assetsCheckedCount = 0;

  try {
    const pageRes = await fetch(normalizedPath, { signal: AbortSignal.timeout(6000) });
    const html = await pageRes.text();
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const hasDocStructure = /<!doctype\s+html|<html|<body/i.test(html);
    const hasClosedHtml = /<\/html>\s*$/i.test(html.trim()) && /<\/body>/i.test(html);
    const hasPwaManifest = /manifest\.webmanifest|manifest\.json/i.test(html);
    const hasServiceWorker = /serviceWorker\.register/i.test(html);
    const googleFontsDetected = /fonts\.googleapis\.com/i.test(html);

    // 1. Static JS syntax verification (inline classic + module scripts)
    const scriptRegex = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let scriptsChecked = 0;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = scriptRegex.exec(html)) !== null) {
      const attrs = sMatch[1] || '';
      const code = (sMatch[2] || '').trim();
      if (!code || /\bsrc\s*=/i.test(attrs)) continue;
      const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
      const scriptType = typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript';
      if (['application/json', 'application/ld+json', 'importmap'].includes(scriptType)) {
        continue;
      }
      scriptsChecked++;
      if (scriptType === 'module') {
        try {
          const esbuild = await import('esbuild');
          await esbuild.transform(code, { loader: 'js', format: 'esm' });
        } catch (err: any) {
          syntaxErrors.push({ scriptIndex: scriptsChecked, error: err?.message || String(err) });
        }
      } else {
        try {
          new vm.Script(code, { filename: `inline-script-${scriptsChecked}.js` });
        } catch (err: any) {
          syntaxErrors.push({ scriptIndex: scriptsChecked, error: err?.message || String(err) });
        }
      }
    }

    // 2. Local asset, <img> integrity & PWA companion file check
    if (checkAssets) {
      const assetMatches = new Map<string, boolean>(); // url -> isImage
      const imgRegex = /<img[^>]*\bsrc\s*=\s*["']([^"']*)["']/gi;
      let iMatch: RegExpExecArray | null;
      while ((iMatch = imgRegex.exec(html)) !== null) {
        const src = (iMatch[1] || '').trim();
        if (!src) {
          brokenAssets.push({ url: '(empty <img src>)', status: 'empty' });
          continue;
        }
        if (/via\.placeholder\.com|placeholder\.com/i.test(src)) {
          brokenAssets.push({ url: src, status: 'banned-placeholder-host' });
          continue;
        }
        if (!src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:') && !src.startsWith('blob:')) {
          assetMatches.set(src, true);
        }
      }

      const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
      let aMatch: RegExpExecArray | null;
      while ((aMatch = attrRegex.exec(html)) !== null) {
        const ref = (aMatch[1] || '').trim();
        if (
          !ref ||
          ref.startsWith('http://') ||
          ref.startsWith('https://') ||
          ref.startsWith('data:') ||
          ref.startsWith('blob:') ||
          ref.startsWith('#') ||
          ref.startsWith('mailto:') ||
          ref.startsWith('javascript:')
        ) {
          continue;
        }
        if (!assetMatches.has(ref)) {
          assetMatches.set(ref, /\.(png|jpe?g|webp|gif|svg)$/i.test(ref));
        }
      }
      const baseUrlObj = new URL(normalizedPath);
      for (const [assetRef, isImg] of Array.from(assetMatches.entries()).slice(0, 18)) {
        try {
          const resolved = new URL(assetRef, baseUrlObj).toString();
          const aRes = await fetch(resolved, { method: 'GET', signal: AbortSignal.timeout(3000) });
          assetsCheckedCount++;
          const ctype = aRes.headers.get('content-type') || '';
          const isModuleScriptAsset = /\.(m?jsx?|tsx?)(?:[?#]|$)/i.test(assetRef);
          if (!aRes.ok) {
            const errBody = isModuleScriptAsset ? await aRes.text().catch(() => '') : '';
            brokenAssets.push({
              url: assetRef,
              status: errBody ? `${aRes.status}:${errBody.slice(0, 120)}` : aRes.status,
            });
          } else if (isImg && ctype && !ctype.includes('image/')) {
            brokenAssets.push({ url: assetRef, status: `invalid-image-mime:${ctype}` });
          } else if (isModuleScriptAsset && ctype.includes('text/html')) {
            brokenAssets.push({ url: assetRef, status: `invalid-script-mime:${ctype}` });
          } else if (isModuleScriptAsset) {
            const scriptBody = await aRes.text().catch(() => '');
            if (/\[vite\]\s*Internal Server Error|Failed to resolve import/i.test(scriptBody)) {
              runtimeErrors.push({
                source: assetRef,
                message: scriptBody.slice(0, 240),
              });
            }
          }
        } catch (err: any) {
          assetsCheckedCount++;
          brokenAssets.push({ url: assetRef, status: err?.message || 'fetch failed' });
        }
      }
    }

    // 3. Real Headless Execution + Synthetic Interactive Control Probe
    let usedEngine: 'playwright' | 'jsdom' = 'jsdom';
    let domMetrics: PreviewVerificationResult['domMetrics'];
    let interactionAudit: PreviewVerificationResult['interactionAudit'] = {
      probedButtons: 0,
      domMutationsObserved: 0,
      clickErrors: [],
      deadButtons: [],
    };

    try {
      const pwName = 'playwright';
      const pw: any = await import(/* @vite-ignore */ pwName).catch(() => null);
      if (pw?.chromium) {
        const browser = await pw.chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          page.on('pageerror', (err: any) => {
            runtimeErrors.push({ source: 'pageerror', message: err?.message || String(err) });
          });
          page.on('console', (msg: any) => {
            if (msg.type() === 'error') {
              consoleErrors.push(msg.text());
            }
          });
          await page.goto(normalizedPath, { waitUntil: 'domcontentloaded', timeout: 8000 });
          await page.waitForTimeout(450);
          domMetrics = await page.evaluate(() => {
            const rootEl = document.getElementById('root') || document.getElementById('app');
            const textLen = (document.body?.innerText || '').trim().length;
            const buttons = document.querySelectorAll('button').length;
            const inputs = document.querySelectorAll('input, textarea, select').length;
            const forms = document.querySelectorAll('form').length;
            const canvases = document.querySelectorAll('canvas').length;
            const imagesCount = document.querySelectorAll('img').length;
            return {
              renderedTextLength: textLen,
              interactiveElements: buttons + inputs + document.querySelectorAll('a[href]').length,
              buttons,
              inputs,
              forms,
              canvases,
              imagesCount,
              emptyRootDetected: Boolean(rootEl && rootEl.children.length === 0 && textLen < 20),
            };
          });
          // Probe up to 5 buttons in Playwright
          const btnCount = Math.min(5, domMetrics?.buttons || 0);
          for (let i = 0; i < btnCount; i++) {
            try {
              const beforeHtml = await page.evaluate(() => document.body?.innerHTML.length || 0);
              const btn = page.locator('button').nth(i);
              if (await btn.isVisible().catch(() => false)) {
                interactionAudit.probedButtons++;
                await btn.click({ timeout: 1000 }).catch(() => {});
                await page.waitForTimeout(80);
                const afterHtml = await page.evaluate(() => document.body?.innerHTML.length || 0);
                if (afterHtml !== beforeHtml) interactionAudit.domMutationsObserved++;
              }
            } catch (cErr: any) {
              interactionAudit.clickErrors.push(cErr?.message || 'Button click error');
            }
          }
          usedEngine = 'playwright';
        } finally {
          await browser.close().catch(() => {});
        }
      }
    } catch {
      // Fallback cleanly to JSDOM
    }

    if (!domMetrics) {
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('error', (...args: any[]) => {
        const msg = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
        if (msg && !msg.includes('Not implemented:')) {
          consoleErrors.push(msg.slice(0, 240));
        }
      });
      virtualConsole.on('jsdomError', (err: any) => {
        const msg = err?.message || String(err);
        if (!msg.includes('Could not load') && !msg.includes('Not implemented')) {
          runtimeErrors.push({ source: 'jsdom', message: msg.slice(0, 240) });
        }
      });

      const dom = new JSDOM(html, {
        url: normalizedPath,
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse(win) {
          const memStorage = new Map<string, string>();
          const storageMock = {
            getItem: (k: string) => memStorage.get(k) ?? null,
            setItem: (k: string, v: string) => memStorage.set(k, String(v)),
            removeItem: (k: string) => memStorage.delete(k),
            clear: () => memStorage.clear(),
            get length() { return memStorage.size; },
            key: (i: number) => Array.from(memStorage.keys())[i] ?? null,
          };
          Object.defineProperty(win, 'localStorage', { value: storageMock, configurable: true });
          Object.defineProperty(win, 'sessionStorage', { value: storageMock, configurable: true });
          if (!win.matchMedia) {
            (win as any).matchMedia = (q: string) => ({
              matches: false,
              media: q,
              onchange: null,
              addListener: () => {},
              removeListener: () => {},
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => false,
            });
          }
          if (!(win as any).ResizeObserver) {
            (win as any).ResizeObserver = class {
              observe() {}
              unobserve() {}
              disconnect() {}
            };
          }
          if (!(win as any).IntersectionObserver) {
            (win as any).IntersectionObserver = class {
              observe() {}
              unobserve() {}
              disconnect() {}
            };
          }
          if (!win.requestAnimationFrame) {
            (win as any).requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16);
            (win as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
          }
          if (html.includes('cdn.tailwindcss.com') && !(win as any).tailwind) {
            (win as any).tailwind = { config: {} };
          }
          win.addEventListener('error', (ev: any) => {
            runtimeErrors.push({
              source: ev?.filename || 'window.onerror',
              message: ev?.message || String(ev?.error || 'Script error'),
            });
          });
        },
      });

      await new Promise((r) => setTimeout(r, 120));
      const doc = dom.window.document;
      const rootEl = doc.getElementById('root') || doc.getElementById('app');
      const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
      const buttonEls = Array.from(doc.querySelectorAll('button, [role="tab"]')) as HTMLElement[];
      const buttons = doc.querySelectorAll('button').length;
      const inputs = doc.querySelectorAll('input, textarea, select').length;
      const forms = doc.querySelectorAll('form').length;
      const canvases = doc.querySelectorAll('canvas').length;
      const imagesCount = doc.querySelectorAll('img').length;
      const links = doc.querySelectorAll('a[href]').length;

      // Synthetic Interactive Control Probe: click up to 8 non-submit buttons and check for JS errors
      const beforeRuntimeCount = runtimeErrors.length;
      for (const btn of buttonEls.slice(0, 8)) {
        const typeAttr = (btn.getAttribute('type') || '').toLowerCase();
        if (typeAttr === 'submit') continue;
        interactionAudit.probedButtons++;
        const snapshotBefore = doc.body?.innerHTML || '';
        try {
          btn.click();
        } catch (err: any) {
          interactionAudit.clickErrors.push(`${(btn.textContent || 'button').trim().slice(0, 30)}: ${err?.message || err}`);
        }
        const snapshotAfter = doc.body?.innerHTML || '';
        if (snapshotAfter !== snapshotBefore) {
          interactionAudit.domMutationsObserved++;
        }
      }
      if (runtimeErrors.length > beforeRuntimeCount) {
        for (const re of runtimeErrors.slice(beforeRuntimeCount)) {
          interactionAudit.clickErrors.push(re.message);
        }
      }

      const hasExternalModuleEntry = /<script[^>]+type\s*=\s*["']module["'][^>]+src\s*=/i.test(html);
      domMetrics = {
        renderedTextLength: bodyText.length,
        interactiveElements: buttons + inputs + links,
        buttons,
        inputs,
        forms,
        canvases,
        imagesCount,
        // JSDOM does not execute external <script type="module" src="..."> bundles (e.g. Vite React SPAs)
        emptyRootDetected: !hasExternalModuleEntry && Boolean(rootEl && rootEl.children.length === 0 && bodyText.length < 20),
      };

      dom.window.close();
    }

    const ok =
      pageRes.ok &&
      hasDocStructure &&
      hasClosedHtml &&
      syntaxErrors.length === 0 &&
      runtimeErrors.length === 0 &&
      interactionAudit.clickErrors.length === 0 &&
      brokenAssets.length === 0 &&
      !domMetrics.emptyRootDetected;

    return {
      ok,
      engine: usedEngine,
      status: pageRes.status,
      url: rawTarget,
      title,
      htmlBytes: html.length,
      hasDocStructure,
      hasClosedHtml,
      hasPwaManifest,
      hasServiceWorker,
      googleFontsDetected,
      scriptsChecked,
      syntaxErrors,
      runtimeErrors: runtimeErrors.slice(0, 10),
      consoleErrors: consoleErrors.slice(0, 10),
      domMetrics,
      interactionAudit,
      assetsCheckedCount,
      brokenAssets,
    };
  } catch (err: any) {
    return {
      ok: false,
      engine: 'jsdom',
      url: rawTarget,
      syntaxErrors,
      runtimeErrors,
      consoleErrors,
      assetsCheckedCount,
      brokenAssets,
      error: err?.message || 'Failed to verify live preview URL',
    };
  }
}

// ============================================================================
// 2. FREE REAL-TIME WEB & DOCS SEARCH (Jina Search + npm + Gemini Grounding + DDG)
// ============================================================================

export async function freeWebSearch(
  query: string,
  options?: { geminiApiKey?: string; geminiModel?: string }
): Promise<{
  query: string;
  count: number;
  sources: string[];
  results: Array<{ title: string; snippet: string; url: string }>;
  groundedAnswer?: string;
}> {
  const cleanQuery = query.trim();
  const results: Array<{ title: string; snippet: string; url: string }> = [];
  const sources: string[] = [];
  let groundedAnswer: string | undefined;

  // 1. Optional Free Gemini Google Search Grounding (if Gemini key is available)
  if (options?.geminiApiKey) {
    try {
      const ai = new GoogleGenAI({
        apiKey: options.geminiApiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const gRes = await ai.models.generateContent({
        model: options.geminiModel || 'gemini-3.8-flash',
        contents: `Search the web and provide concise, accurate technical facts, API usage, or documentation links for: ${cleanQuery}`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });
      if (gRes.text) {
        groundedAnswer = gRes.text.slice(0, 4000);
        sources.push('googleSearchGrounding');
      }
      const chunks = (gRes as any).candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      for (const ch of chunks.slice(0, 5)) {
        if (ch?.web?.uri) {
          results.push({
            title: ch.web.title || cleanQuery,
            snippet: 'Grounded Google Search reference',
            url: ch.web.uri,
          });
        }
      }
    } catch {
      // Fallback seamlessly to zero-key public search below
    }
  }

  // 2. Zero-Key Free Web Search via Jina Search (s.jina.ai)
  if (results.length < 3) {
    try {
      const jinaSearchRes = await fetch(`https://s.jina.ai/?q=${encodeURIComponent(cleanQuery)}`, {
        headers: {
          Accept: 'application/json',
          'X-Respond-With': 'no-content',
        },
        signal: AbortSignal.timeout(7000),
      });
      if (jinaSearchRes.ok) {
        const text = await jinaSearchRes.text();
        try {
          const json = JSON.parse(text);
          const list = Array.isArray(json?.data) ? json.data : [];
          for (const item of list.slice(0, 5)) {
            if (item?.url && (item?.title || item?.description)) {
              results.push({
                title: String(item.title || cleanQuery).slice(0, 100),
                snippet: String(item.description || item.content || '').slice(0, 350),
                url: String(item.url),
              });
            }
          }
          if (list.length > 0) sources.push('jinaSearch');
        } catch {
          if (text.length > 60) {
            results.push({
              title: `Web Search: ${cleanQuery}`,
              snippet: text.slice(0, 1200),
              url: `https://www.google.com/search?q=${encodeURIComponent(cleanQuery)}`,
            });
            sources.push('jinaSearchMarkdown');
          }
        }
      }
    } catch {}
  }

  // 3. npm Registry Search when query relates to JS/TS packages
  if (/\b(npm|package|react|vite|tailwind|library|sdk|lucide|three|drizzle|zod|express)\b/i.test(cleanQuery)) {
    try {
      const npmRes = await fetch(
        `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(cleanQuery)}&size=3`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (npmRes.ok) {
        const npmJson = await npmRes.json();
        const objs = Array.isArray(npmJson?.objects) ? npmJson.objects : [];
        for (const obj of objs) {
          const pkg = obj?.package;
          if (pkg?.name) {
            results.push({
              title: `npm: ${pkg.name}@${pkg.version}`,
              snippet: pkg.description || 'npm package',
              url: pkg.links?.npm || `https://www.npmjs.com/package/${pkg.name}`,
            });
          }
        }
        if (objs.length > 0) sources.push('npmRegistry');
      }
    } catch {}
  }

  // 4. DuckDuckGo Instant Answer + Wikipedia fallback
  if (results.length < 3) {
    try {
      const ddgRes = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanQuery)}&format=json&no_html=1`,
        { signal: AbortSignal.timeout(4500) }
      );
      const ddgData = await ddgRes.json();
      if (ddgData.AbstractText) {
        results.push({
          title: ddgData.Heading || cleanQuery,
          snippet: ddgData.AbstractText,
          url: ddgData.AbstractURL,
        });
        sources.push('duckduckgo');
      }
    } catch {}

    try {
      const wikiRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=3&namespace=0&format=json`,
        { signal: AbortSignal.timeout(4500) }
      );
      const wikiData = await wikiRes.json();
      if (Array.isArray(wikiData) && Array.isArray(wikiData[1])) {
        const titles = wikiData[1];
        const descriptions = wikiData[2] || [];
        const links = wikiData[3] || [];
        for (let i = 0; i < titles.length; i++) {
          results.push({
            title: titles[i],
            snippet: descriptions[i] || `Reference for ${titles[i]}`,
            url: links[i],
          });
        }
        if (titles.length > 0) sources.push('wikipedia');
      }
    } catch {}
  }

  return {
    query: cleanQuery,
    count: results.length,
    sources,
    results: results.slice(0, 8),
    groundedAnswer,
  };
}

// ============================================================================
// 3. GIT CHECKPOINT & 1-CLICK SNAPSHOT ROLLBACK
// ============================================================================

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  gitCommit?: string;
}

const CHECKPOINTS_ROOT = path.resolve(process.cwd(), '.nexus_checkpoints');
const TRACKED_PREFIXES = ['src', 'server', 'projects', 'server.ts', 'package.json', 'index.html', 'vite.config.ts'];

async function collectSnapshotFiles(): Promise<string[]> {
  const cwd = process.cwd();
  const collected: string[] = [];

  const walk = async (relDir: string, depth = 0) => {
    if (depth > 4) return;
    const abs = path.join(cwd, relDir);
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', '.nexus_checkpoints', '.secrets.json'].includes(entry.name)) continue;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        await walk(rel, depth + 1);
      } else {
        collected.push(rel);
      }
    }
  };

  for (const target of TRACKED_PREFIXES) {
    const abs = path.join(cwd, target);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      await walk(target);
    } else if (stat.isFile()) {
      collected.push(target);
    }
  }

  return collected;
}

export async function createCheckpoint(label: string = 'Manual checkpoint'): Promise<WorkspaceCheckpoint> {
  const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const cpDir = path.join(CHECKPOINTS_ROOT, id);
  const filesDir = path.join(cpDir, 'files');
  await fs.mkdir(filesDir, { recursive: true });

  const files = await collectSnapshotFiles();
  for (const rel of files) {
    const srcAbs = path.join(process.cwd(), rel);
    const destAbs = path.join(filesDir, rel);
    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.copyFile(srcAbs, destAbs).catch(() => {});
  }

  let gitCommit: string | undefined;
  try {
    const hasGit = await fs.stat(path.join(process.cwd(), '.git')).then(() => true).catch(() => false);
    if (hasGit) {
      const safeLabel = label.replace(/"/g, "'").slice(0, 80);
      await execPromise(`git add -A && git commit -m "nexus-checkpoint: ${safeLabel}" --allow-empty`, {
        cwd: process.cwd(),
      }).catch(() => {});
      const { stdout } = await execPromise('git rev-parse --short HEAD', { cwd: process.cwd() });
      gitCommit = stdout.trim();
    }
  } catch {}

  const meta: WorkspaceCheckpoint = {
    id,
    label: label.trim() || 'Checkpoint',
    createdAt: Date.now(),
    fileCount: files.length,
    gitCommit,
  };
  await fs.writeFile(path.join(cpDir, 'meta.json'), JSON.stringify({ ...meta, files }, null, 2), 'utf-8');

  // Mirror snapshot text files (< 200KB each) to remote persistence if configured
  try {
    const fileMap: Record<string, string> = {};
    for (const rel of files.slice(0, 60)) {
      const content = await fs.readFile(path.join(process.cwd(), rel), 'utf-8').catch(() => '');
      if (content && content.length <= 200_000 && !content.includes('\u0000')) {
        fileMap[rel] = content;
      }
    }
    await saveCheckpointToPersistence({ ...meta, files: fileMap });
  } catch {}

  // Keep latest 15 checkpoints to avoid filling container disk
  const all = await listCheckpoints();
  if (all.length > 15) {
    for (const old of all.slice(15)) {
      await fs.rm(path.join(CHECKPOINTS_ROOT, old.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  return meta;
}

export async function listCheckpoints(): Promise<WorkspaceCheckpoint[]> {
  try {
    await fs.mkdir(CHECKPOINTS_ROOT, { recursive: true });
    const dirs = await fs.readdir(CHECKPOINTS_ROOT, { withFileTypes: true });
    const list: WorkspaceCheckpoint[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const raw = await fs.readFile(path.join(CHECKPOINTS_ROOT, d.name, 'meta.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        list.push({
          id: parsed.id,
          label: parsed.label,
          createdAt: parsed.createdAt,
          fileCount: parsed.fileCount || 0,
          gitCommit: parsed.gitCommit,
        });
      } catch {}
    }
    const merged = new Map<string, WorkspaceCheckpoint>();
    for (const item of list) merged.set(item.id, item);
    const remoteList = await listCheckpointsFromPersistence().catch(() => []);
    for (const r of remoteList) {
      if (!merged.has(r.id)) merged.set(r.id, r);
    }
    return Array.from(merged.values()).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return await listCheckpointsFromPersistence().catch(() => []);
  }
}

export async function rollbackToCheckpoint(checkpointId: string): Promise<{
  success: boolean;
  restoredCount: number;
  removedCount: number;
  checkpoint?: WorkspaceCheckpoint;
  error?: string;
}> {
  try {
    const cleanId = checkpointId.replace(/[^a-zA-Z0-9_-]/g, '');
    const cpDir = path.join(CHECKPOINTS_ROOT, cleanId);
    const metaRaw = await fs.readFile(path.join(cpDir, 'meta.json'), 'utf-8').catch(() => null);

    if (!metaRaw) {
      // Fallback: restore from remote Postgres/Turso/SQLite checkpoint snapshot after Render restart
      const remoteSnap = await loadCheckpointFromPersistence(cleanId);
      if (!remoteSnap) {
        return { success: false, restoredCount: 0, removedCount: 0, error: 'Checkpoint not found locally or in remote persistence.' };
      }
      let restoredCount = 0;
      for (const [rel, content] of Object.entries(remoteSnap.files || {})) {
        const destAbs = path.resolve(process.cwd(), rel);
        if (!destAbs.startsWith(process.cwd())) continue;
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.writeFile(destAbs, content, 'utf-8');
        restoredCount++;
      }
      return {
        success: true,
        restoredCount,
        removedCount: 0,
        checkpoint: {
          id: remoteSnap.id,
          label: remoteSnap.label,
          createdAt: remoteSnap.createdAt,
          fileCount: remoteSnap.fileCount,
          gitCommit: remoteSnap.gitCommit,
        },
      };
    }

    const meta = JSON.parse(metaRaw);
    const savedFiles = new Set<string>(Array.isArray(meta.files) ? meta.files : []);

    // Remove newly created files under tracked dirs that didn't exist in checkpoint
    const currentFiles = await collectSnapshotFiles();
    let removedCount = 0;
    for (const rel of currentFiles) {
      if (!savedFiles.has(rel)) {
        await fs.unlink(path.join(process.cwd(), rel)).catch(() => {});
        removedCount++;
      }
    }

    // Restore all saved files
    let restoredCount = 0;
    for (const rel of savedFiles) {
      const snapAbs = path.join(cpDir, 'files', rel);
      const destAbs = path.join(process.cwd(), rel);
      await fs.mkdir(path.dirname(destAbs), { recursive: true });
      await fs.copyFile(snapAbs, destAbs);
      restoredCount++;
    }

    return {
      success: true,
      restoredCount,
      removedCount,
      checkpoint: {
        id: meta.id,
        label: meta.label,
        createdAt: meta.createdAt,
        fileCount: meta.fileCount,
        gitCommit: meta.gitCommit,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      restoredCount: 0,
      removedCount: 0,
      error: err?.message || 'Checkpoint not found or rollback failed',
    };
  }
}

// ============================================================================
// 4. SYMBOL & IMPORT CODEBASE GRAPH (Zero-Cost Context Map for Free APIs)
// ============================================================================

export async function buildCodebaseGraph(targetDir: string = '.'): Promise<{
  root: string;
  fileCount: number;
  nodes: Array<{
    file: string;
    lines: number;
    imports: string[];
    exports: string[];
    routes?: string[];
  }>;
}> {
  const cwd = process.cwd();
  const startAbs = path.resolve(cwd, targetDir);
  const nodes: Array<{
    file: string;
    lines: number;
    imports: string[];
    exports: string[];
    routes?: string[];
  }> = [];

  const walk = async (dir: string, depth = 0) => {
    if (depth > 4 || nodes.length >= 60) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (['node_modules', '.git', 'dist', 'dev-dist', '.nexus_checkpoints', 'public'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(e.name)) {
        const rel = path.relative(cwd, full);
        const content = await fs.readFile(full, 'utf-8').catch(() => '');
        const lines = content.split('\n').length;

        const imports: string[] = [];
        const importRe = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(content)) !== null) {
          if (m[1]) imports.push(m[1]);
        }

        const exports: string[] = [];
        const exportRe = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g;
        while ((m = exportRe.exec(content)) !== null) {
          if (m[1]) exports.push(m[1]);
        }

        const routes: string[] = [];
        const routeRe = /\bapp\.(?:get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
        while ((m = routeRe.exec(content)) !== null) {
          if (m[1]) routes.push(m[1]);
        }

        nodes.push({
          file: rel,
          lines,
          imports: Array.from(new Set(imports)).slice(0, 15),
          exports: Array.from(new Set(exports)).slice(0, 15),
          ...(routes.length > 0 ? { routes: Array.from(new Set(routes)) } : {}),
        });
      }
    }
  };

  await walk(startAbs);
  return { root: targetDir, fileCount: nodes.length, nodes };
}

// ============================================================================
// 5. AUTOMATED TEST RUNNER (Node 22 Built-in node --test / Vitest)
// ============================================================================

export async function runAutomatedTests(testTarget?: string): Promise<{
  success: boolean;
  runner: string;
  output: string;
  error?: string;
}> {
  const cwd = process.cwd();
  try {
    // Check if vitest is installed
    const pkgRaw = await fs.readFile(path.join(cwd, 'package.json'), 'utf-8').catch(() => '{}');
    const pkg = JSON.parse(pkgRaw);
    const hasVitest = Boolean(pkg?.dependencies?.vitest || pkg?.devDependencies?.vitest);
    const hasTestScript = Boolean(pkg?.scripts?.test);

    if (hasVitest) {
      const targetArg = testTarget ? ` "${testTarget}"` : '';
      const { stdout, stderr } = await execPromise(`npx vitest run${targetArg}`, { cwd, timeout: 30000 });
      return { success: true, runner: 'vitest', output: (stdout + '\n' + stderr).trim() };
    }

    if (hasTestScript && !testTarget) {
      const { stdout, stderr } = await execPromise('npm test', { cwd, timeout: 30000 });
      return { success: true, runner: 'npm test', output: (stdout + '\n' + stderr).trim() };
    }

    // Find *.test.{ts,js,mjs} files
    const { stdout: foundTests } = await execPromise(
      `find "${testTarget || '.'}" -maxdepth 4 \\( -name "*.test.ts" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.js" \\) -not -path "*/node_modules/*" -not -path "*/dist/*"`,
      { cwd }
    ).catch(() => ({ stdout: '' }));

    const testFiles = foundTests.trim().split('\n').filter(Boolean);
    if (testFiles.length === 0) {
      // Run lightweight smoke validation of server + frontend TypeScript types as baseline test gate
      const { stdout: tscOut } = await execPromise('npx tsc --noEmit', { cwd, timeout: 25000 });
      return {
        success: true,
        runner: 'tsc-smoke-check (no *.test.* files found)',
        output: tscOut.trim() || 'TypeScript validation passed (0 errors). Add *.test.ts files to run unit tests with node --test.',
      };
    }

    const { stdout, stderr } = await execPromise(
      `npx tsx --test ${testFiles.map((f) => `"${f}"`).join(' ')}`,
      { cwd, timeout: 30000 }
    );
    return { success: true, runner: 'tsx --test', output: (stdout + '\n' + stderr).trim() };
  } catch (err: any) {
    return {
      success: false,
      runner: 'test-runner',
      output: ((err.stdout || '') + '\n' + (err.stderr || '')).trim(),
      error: err.message,
    };
  }
}

// ============================================================================
// 6. REAL BACKGROUND TIMER & CRON-LIKE SCHEDULER
// ============================================================================

export interface ScheduledJob {
  id: string;
  prompt: string;
  durationSeconds: number;
  recurring: boolean;
  status: 'scheduled' | 'fired' | 'cancelled';
  createdAt: number;
  firesAt: number;
  fireCount: number;
  lastFiredAt?: number;
}

const scheduledJobs = new Map<string, { job: ScheduledJob; timer: NodeJS.Timeout }>();
const scheduledEventLog: Array<{ id: string; prompt: string; firedAt: number }> = [];

export function scheduleRealTask(
  prompt: string,
  durationSeconds: number = 5,
  recurring: boolean = false,
  onFire?: (job: ScheduledJob) => void
): ScheduledJob {
  const safeSec = Math.max(1, Math.min(durationSeconds, 3600));
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const job: ScheduledJob = {
    id,
    prompt,
    durationSeconds: safeSec,
    recurring,
    status: 'scheduled',
    createdAt: now,
    firesAt: now + safeSec * 1000,
    fireCount: 0,
  };

  const fire = () => {
    job.fireCount++;
    job.lastFiredAt = Date.now();
    scheduledEventLog.unshift({ id: job.id, prompt: job.prompt, firedAt: job.lastFiredAt });
    if (scheduledEventLog.length > 50) scheduledEventLog.pop();
    if (!recurring) {
      job.status = 'fired';
      scheduledJobs.delete(id);
    } else {
      job.firesAt = Date.now() + safeSec * 1000;
    }
    onFire?.(job);
  };

  const timer = recurring
    ? setInterval(fire, safeSec * 1000)
    : setTimeout(fire, safeSec * 1000);
  if (typeof timer.unref === 'function') timer.unref();

  scheduledJobs.set(id, { job, timer });
  return job;
}

export function listScheduledTasks() {
  return {
    active: Array.from(scheduledJobs.values()).map((e) => e.job),
    recentFired: scheduledEventLog.slice(0, 15),
  };
}

export function cancelScheduledTask(id: string): boolean {
  const entry = scheduledJobs.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  clearInterval(entry.timer);
  entry.job.status = 'cancelled';
  scheduledJobs.delete(id);
  return true;
}

// ============================================================================
// 7. WHITESPACE-TOLERANT FUZZY FILE PATCHER (For Free LLM Edits)
// ============================================================================

export function fuzzyReplaceContent(
  fileContent: string,
  targetText: string,
  replacementText: string
): { found: boolean; newContent: string; matchMode: 'exact' | 'normalized' | 'none' } {
  if (fileContent.includes(targetText)) {
    return {
      found: true,
      newContent: fileContent.replace(targetText, replacementText),
      matchMode: 'exact',
    };
  }

  // Line-trimmed whitespace-tolerant matching
  const srcLines = fileContent.split(/\r?\n/);
  const targetLines = targetText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l, idx, arr) => !(l === '' && (idx === 0 || idx === arr.length - 1)));

  if (targetLines.length === 0) {
    return { found: false, newContent: fileContent, matchMode: 'none' };
  }

  for (let i = 0; i <= srcLines.length - targetLines.length; i++) {
    let matched = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (srcLines[i + j].trim() !== targetLines[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const before = srcLines.slice(0, i);
      const after = srcLines.slice(i + targetLines.length);
      const updated = [...before, replacementText, ...after].join('\n');
      return { found: true, newContent: updated, matchMode: 'normalized' };
    }
  }

  return { found: false, newContent: fileContent, matchMode: 'none' };
}
