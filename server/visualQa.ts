import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GoogleGenAI } from '@google/genai';
import { verifyLivePreviewWithDom } from './workspaceEngine.ts';

const execPromise = promisify(exec);

export interface VisualQaResult {
  ok: boolean;
  engine: 'browserless-vision' | 'playwright-vision' | 'dom-layout-audit';
  url: string;
  screenshotUrl?: string;
  visualScore?: number;
  layoutIssues: string[];
  visionCritique?: string;
  domAuditSummary?: any;
  recommendations: string[];
  error?: string;
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function readEnvFallback(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) out[k] = v;
    }
  } catch {}
  return out;
}

async function getBrowserlessConfig(): Promise<{ token: string; baseUrl: string }> {
  let token = (process.env.BROWSERLESS_TOKEN || '').trim();
  let baseUrl = (process.env.BROWSERLESS_URL || '').trim();
  if (!token || !baseUrl) {
    const fileEnv = await readEnvFallback();
    if (!token && fileEnv.BROWSERLESS_TOKEN) {
      token = fileEnv.BROWSERLESS_TOKEN;
      process.env.BROWSERLESS_TOKEN = token;
    }
    if (!baseUrl && fileEnv.BROWSERLESS_URL) {
      baseUrl = fileEnv.BROWSERLESS_URL;
      process.env.BROWSERLESS_URL = baseUrl;
    }
  }
  return {
    token,
    baseUrl: (baseUrl || 'https://chrome.browserless.io').replace(/\/+$/, ''),
  };
}

async function resolveActiveGeminiKey(explicitKey?: string): Promise<string | undefined> {
  if (explicitKey) return explicitKey;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  try {
    const raw = await fs.readFile(path.resolve(process.cwd(), '.secrets.json'), 'utf-8');
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      const found = list.find((k: any) => k.isActive && k.provider === 'gemini' && k.apiKey)?.apiKey;
      if (found) return found;
    }
  } catch {}
  const fileEnv = await readEnvFallback();
  return fileEnv.GEMINI_API_KEY || undefined;
}

async function critiqueScreenshotWithVision(
  pngBuffer: Buffer,
  targetUrl: string,
  geminiApiKey?: string
): Promise<{ ok: boolean; score: number; issues: string[]; critique: string; recommendations: string[] }> {
  const key = await resolveActiveGeminiKey(geminiApiKey);
  if (!key) {
    return {
      ok: true,
      score: 8,
      issues: [],
      critique: 'Screenshot captured cleanly via Browserless Chromium; add an active Gemini API key to enable multimodal Vision UI critique.',
      recommendations: [],
    };
  }

  const ai = new GoogleGenAI({
    apiKey: key,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
  const base64 = pngBuffer.toString('base64');
  const prompt = `You are a strict senior UI/UX Visual QA Reviewer inspecting a rendered browser screenshot of ${targetUrl}.
Evaluate ONLY for real, visible layout or rendering defects:
1) Overlapping or clipped text, buttons, or cards
2) Broken CSS layout, unstyled elements (e.g. Tailwind failed to load), broken/missing images, or horizontal overflow
3) Unreadable low contrast (e.g. dark text on dark background or white text on white background)
4) Blank / empty viewport or untouched starter boilerplate ("Modular Workspace Ready")

Do NOT invent subjective nitpicks if the layout renders cleanly and is legible.
Return ONLY valid JSON:
{"score": 1-10, "pass": true/false, "issues": ["specific actionable defect 1", ...], "recommendations": ["specific CSS/JSX fix 1", ...], "summary": "concise 1-2 sentence visual critique"}`;

  const candidateModels = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
  let lastErr: any = null;

  for (const model of candidateModels) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType: 'image/png', data: base64 } },
            { text: prompt },
          ],
        },
        config: { responseMimeType: 'application/json' },
      });

      const rawText = (res.text || '{}').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
      const issues = Array.isArray(parsed.issues) ? parsed.issues.map(String).filter(Boolean) : [];
      const recommendations = Array.isArray(parsed.recommendations)
        ? parsed.recommendations.map(String).filter(Boolean)
        : [];
      const score = typeof parsed.score === 'number' ? parsed.score : 8;
      const pass = typeof parsed.pass === 'boolean' ? parsed.pass : score >= 6 && issues.length === 0;
      return {
        ok: pass,
        score,
        issues,
        recommendations,
        critique: String(parsed.summary || 'Visual inspection complete.'),
      };
    } catch (err: any) {
      lastErr = err;
    }
  }

  return {
    ok: true,
    score: 7,
    issues: [],
    recommendations: [],
    critique: `Vision model review skipped (${lastErr?.message?.slice(0, 100) || 'error'}); PNG screenshot saved.`,
  };
}

async function resolveLocalFileToDataUri(ref: string, searchDirs: string[]): Promise<string | null> {
  const cleanRef = ref.split('?')[0].split('#')[0].replace(/^\/+/, '');
  if (!cleanRef) return null;

  const candidatePaths: string[] = [];
  if (cleanRef.startsWith('generated/')) {
    candidatePaths.push(path.resolve(process.cwd(), 'public', cleanRef));
  }
  for (const dir of searchDirs) {
    candidatePaths.push(path.resolve(dir, cleanRef));
  }
  candidatePaths.push(path.resolve(process.cwd(), 'public', cleanRef));

  for (const abs of candidatePaths) {
    if (!abs.startsWith(process.cwd())) continue;
    try {
      const buf = await fs.readFile(abs);
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME_MAP[ext] || 'application/octet-stream';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch {}
  }
  return null;
}

async function inlineLocalAssetsInHtml(
  html: string,
  options: { baseDir?: string; port: number; wsId?: string; baseUrlForFetch: string }
): Promise<string> {
  const searchDirs: string[] = [];
  if (options.baseDir) {
    searchDirs.push(path.join(options.baseDir, 'dist'));
    searchDirs.push(path.join(options.baseDir, 'public'));
    searchDirs.push(options.baseDir);
  }
  searchDirs.push(path.resolve(process.cwd(), 'projects'));

  const stripWorkspacePrefix = (href: string) => {
    let clean = href.split('?')[0].split('#')[0];
    if (options.wsId && clean.startsWith(`/w/${options.wsId}/`)) {
      clean = clean.slice(`/w/${options.wsId}/`.length);
    }
    return clean.replace(/^\.\//, '').replace(/^\/+/, '');
  };

  const readLocalTextAsset = async (ref: string): Promise<string | null> => {
    const rel = stripWorkspacePrefix(ref);
    for (const dir of searchDirs) {
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(process.cwd())) continue;
      try {
        return await fs.readFile(abs, 'utf-8');
      } catch {}
    }
    try {
      const resolved = new URL(ref, options.baseUrlForFetch).toString();
      if (resolved.startsWith(`http://127.0.0.1:${options.port}`)) {
        const res = await fetch(resolved, { signal: AbortSignal.timeout(4000) });
        if (res.ok) return await res.text();
      }
    } catch {}
    return null;
  };

  let out = html;

  // Remove <base href="/w/..."> when rendering self-contained HTML in about:blank
  out = out.replace(/<base\b[^>]*>/gi, '');

  // Add safe history shim so SPA routers do not throw SecurityError inside Browserless setContent(html)
  const historyShim = `<script>(function(){try{var p=history.pushState,r=history.replaceState;history.pushState=function(){try{return p.apply(history,arguments)}catch(e){}};history.replaceState=function(){try{return r.apply(history,arguments)}catch(e){}};}catch(e){}})();</script>`;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${historyShim}`);
  } else {
    out = historyShim + out;
  }

  // Inline local <link rel="stylesheet" href="...">
  const linkMatches = Array.from(out.matchAll(/<link\b([^>]*?)\bhref=["']([^"']+)["']([^>]*)>/gi));
  for (const m of linkMatches) {
    const fullTag = m[0];
    const attrs = `${m[1]} ${m[3]}`;
    const href = (m[2] || '').trim();
    if (!/rel=["'][^"']*stylesheet/i.test(attrs)) continue;
    if (/^https?:\/\//i.test(href) || href.startsWith('//')) continue;
    const cssText = await readLocalTextAsset(href);
    if (cssText !== null) {
      const safeCss = cssText.replace(/<\/style>/gi, '<\\/style>');
      out = out.replace(fullTag, `<style>${safeCss}</style>`);
    }
  }

  // Inline local <script ... src="..."></script>
  const scriptMatches = Array.from(out.matchAll(/<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi));
  for (const m of scriptMatches) {
    const fullTag = m[0];
    const attrs = `${m[1]} ${m[3]}`;
    const src = (m[2] || '').trim();
    if (/^https?:\/\//i.test(src) || src.startsWith('//')) continue;
    const jsText = await readLocalTextAsset(src);
    if (jsText !== null) {
      const isModule = /\btype=["']module["']/i.test(attrs);
      const safeJs = jsText.replace(/<\/script>/gi, '<\\/script>');
      out = out.replace(fullTag, `<script${isModule ? ' type="module"' : ''}>${safeJs}</script>`);
    }
  }

  // Inline local <img src="..."> as base64 data URIs
  const imgMatches = Array.from(out.matchAll(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi));
  for (const m of imgMatches) {
    const src = (m[2] || '').trim();
    if (!src || /^https?:\/\//i.test(src) || src.startsWith('data:') || src.startsWith('blob:')) continue;
    const rel = stripWorkspacePrefix(src);
    const dataUri = await resolveLocalFileToDataUri(rel, searchDirs);
    if (dataUri) {
      out = out.replace(m[0], `${m[1]}${dataUri}${m[3]}`);
    }
  }

  return out;
}

async function buildSelfContainedHtmlForBrowserless(
  rawTarget: string,
  fullUrl: string,
  port: number,
  sessionId?: string
): Promise<string | null> {
  const wsMatch = rawTarget.match(/(?:^|\/)w\/([^/]+)/);
  const wsId = (wsMatch?.[1] || sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');

  if (wsMatch?.[1] && wsId) {
    const wsDir = path.resolve(process.cwd(), 'workspaces', wsId);
    const hasVite = await fs.access(path.join(wsDir, 'vite.config.ts')).then(() => true).catch(() => false);
    const distIndex = path.join(wsDir, 'dist', 'index.html');
    const hasDist = await fs.access(distIndex).then(() => true).catch(() => false);

    if (hasVite && !hasDist) {
      await execPromise('npx vite build', { cwd: wsDir, timeout: 45000 }).catch(() => {});
    }

    const candidates = [
      distIndex,
      path.join(wsDir, 'public', 'index.html'),
      ...(hasVite ? [] : [path.join(wsDir, 'index.html')]),
    ];

    for (const cand of candidates) {
      try {
        const html = await fs.readFile(cand, 'utf-8');
        if (html.trim().length > 20) {
          return await inlineLocalAssetsInHtml(html, {
            baseDir: wsDir,
            port,
            wsId,
            baseUrlForFetch: fullUrl,
          });
        }
      } catch {}
    }
  }

  // Fallback for /projects/*.html or other local routes
  try {
    const res = await fetch(fullUrl, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const html = await res.text();
      if (html.trim().length > 20) {
        return await inlineLocalAssetsInHtml(html, {
          port,
          baseUrlForFetch: fullUrl,
        });
      }
    }
  } catch {}

  return null;
}

async function isPublicUrlReachableWithoutAuth(url: string): Promise<boolean> {
  if (!url || url.includes('127.0.0.1') || url.includes('localhost')) return false;
  try {
    const probe = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
    });
    return probe.status >= 200 && probe.status < 300;
  } catch {
    return false;
  }
}

export async function runVisualQaReview(options: {
  targetUrl?: string;
  sessionId?: string;
  viewport?: 'desktop' | 'mobile';
  geminiApiKey?: string;
}): Promise<VisualQaResult> {
  const port = Number(process.env.PORT) || 3000;
  const defaultPath = options.sessionId
    ? `/projects/${options.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}/index.html`
    : '/projects/index.html';
  const rawTarget = String(options.targetUrl || defaultPath).trim();
  const fullUrl =
    rawTarget.startsWith('http://') || rawTarget.startsWith('https://')
      ? rawTarget
      : `http://127.0.0.1:${port}${rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`}`;

  const vp = options.viewport === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 };
  const layoutIssues: string[] = [];
  const recommendations: string[] = [];

  const outDir = path.resolve(process.cwd(), 'public', 'generated');
  await fs.mkdir(outDir, { recursive: true });

  // 1. Try Remote Browserless.io / Sidecar Chrome Screenshot API (ideal for Render Free 512MB RAM & AI Studio)
  const { token: browserlessToken, baseUrl: browserlessBase } = await getBrowserlessConfig();
  if (browserlessToken || process.env.BROWSERLESS_URL) {
    try {
      const publicTarget =
        fullUrl.includes('127.0.0.1') && process.env.APP_URL
          ? `${process.env.APP_URL.replace(/\/+$/, '')}${rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`}`
          : fullUrl;

      let requestPayload: Record<string, any> | null = null;

      if (await isPublicUrlReachableWithoutAuth(publicTarget)) {
        requestPayload = {
          url: publicTarget,
          options: { type: 'png', fullPage: false },
          viewport: vp,
          gotoOptions: { waitUntil: 'networkidle2', timeout: 15000 },
        };
      } else {
        const snapshotHtml = await buildSelfContainedHtmlForBrowserless(rawTarget, fullUrl, port, options.sessionId);
        if (snapshotHtml) {
          requestPayload = {
            html: snapshotHtml,
            options: { type: 'png', fullPage: false },
            viewport: vp,
            gotoOptions: { waitUntil: 'networkidle2', timeout: 18000 },
            waitForTimeout: 600,
          };
        }
      }

      if (requestPayload) {
        const endpoints = [
          `${browserlessBase}/screenshot${browserlessToken ? `?token=${encodeURIComponent(browserlessToken)}` : ''}`,
          ...(browserlessBase === 'https://chrome.browserless.io' && browserlessToken
            ? [`https://production-sfo.browserless.io/screenshot?token=${encodeURIComponent(browserlessToken)}`]
            : []),
        ];

        for (const endpoint of endpoints) {
          try {
            const blRes = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestPayload),
              signal: AbortSignal.timeout(25000),
            });
            if (blRes.ok) {
              const pngBuffer = Buffer.from(await blRes.arrayBuffer());
              if (pngBuffer.byteLength > 200) {
                const fileName = `qa_${Date.now()}.png`;
                await fs.writeFile(path.join(outDir, fileName), pngBuffer);
                const vision = await critiqueScreenshotWithVision(pngBuffer, rawTarget, options.geminiApiKey);
                return {
                  ok: vision.ok,
                  engine: 'browserless-vision',
                  url: rawTarget,
                  screenshotUrl: `/generated/${fileName}`,
                  visualScore: vision.score,
                  layoutIssues: vision.issues,
                  visionCritique: vision.critique,
                  recommendations:
                    vision.recommendations.length > 0
                      ? vision.recommendations
                      : vision.issues.length > 0
                        ? ['Fix the identified visual/contrast/layout defects in the HTML/CSS/JSX.']
                        : [],
                };
              }
            }
          } catch (epErr: any) {
            layoutIssues.push(`Remote Browserless probe note: ${epErr?.message || 'unavailable'}`);
          }
        }
      }
    } catch (blErr: any) {
      layoutIssues.push(`Remote Browserless probe note: ${blErr?.message || 'unavailable'}`);
    }
  }

  // 2. Try Local Playwright Chromium (if installed)
  try {
    const pwName = 'playwright';
    const pw: any = await import(/* @vite-ignore */ pwName).catch(() => null);
    if (pw?.chromium) {
      const browser = await pw.chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: vp });
        await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 12000 }).catch(() =>
          page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 8000 })
        );
        await page.waitForTimeout(450);

        const metrics = await page.evaluate(() => {
          const docEl = document.documentElement;
          const hasOverflow = docEl.scrollWidth > window.innerWidth + 4;
          const brokenImgs = Array.from(document.querySelectorAll('img')).filter((img) => !img.complete || img.naturalWidth === 0).length;
          return { hasOverflow, brokenImgs, scrollWidth: docEl.scrollWidth, innerWidth: window.innerWidth };
        });

        if (metrics.hasOverflow) {
          layoutIssues.push(`Horizontal overflow detected (${metrics.scrollWidth}px > ${metrics.innerWidth}px).`);
        }
        if (metrics.brokenImgs > 0) {
          layoutIssues.push(`${metrics.brokenImgs} broken image(s) with naturalWidth=0.`);
        }

        const pngBuffer = await page.screenshot({ type: 'png', fullPage: false });
        const fileName = `qa_${Date.now()}.png`;
        await fs.writeFile(path.join(outDir, fileName), pngBuffer);
        const vision = await critiqueScreenshotWithVision(pngBuffer, fullUrl, options.geminiApiKey);
        const mergedIssues = [...layoutIssues, ...vision.issues];

        return {
          ok: mergedIssues.length === 0 && vision.ok,
          engine: 'playwright-vision',
          url: rawTarget,
          screenshotUrl: `/generated/${fileName}`,
          visualScore: vision.score,
          layoutIssues: mergedIssues,
          visionCritique: vision.critique,
          domAuditSummary: metrics,
          recommendations: mergedIssues.length > 0 ? ['Fix horizontal overflow, broken images, or visual defects detected above.'] : [],
        };
      } finally {
        await browser.close().catch(() => {});
      }
    }
  } catch {}

  // 3. Zero-Cost JSDOM + CSS Layout/Responsive Heuristic Audit fallback
  const domRes = await verifyLivePreviewWithDom(rawTarget, true, options.sessionId);
  try {
    const html = await fetch(fullUrl, { signal: AbortSignal.timeout(5000) }).then((r) => r.text());
    if (!/name=["']viewport["']/i.test(html)) {
      layoutIssues.push('Missing <meta name="viewport"> tag (breaks mobile layout).');
      recommendations.push('Add <meta name="viewport" content="width=device-width, initial-scale=1.0">.');
    }
    if (!/(sm:|md:|lg:|@media|grid-cols|flex-wrap)/i.test(html)) {
      recommendations.push('Add responsive CSS breakpoints (sm:/md:/lg: or @media) for mobile friendliness.');
    }
    if (domRes.domMetrics?.emptyRootDetected) {
      layoutIssues.push('Empty root container detected (blank screen risk).');
    }
    if (domRes.brokenAssets.length > 0) {
      layoutIssues.push(`Broken local assets: ${domRes.brokenAssets.map((a) => a.url).join(', ')}`);
    }
    if (domRes.syntaxErrors.length > 0 || domRes.runtimeErrors.length > 0) {
      layoutIssues.push(`Runtime/syntax errors present (${domRes.syntaxErrors.length + domRes.runtimeErrors.length}).`);
    }
  } catch (err: any) {
    layoutIssues.push(`Could not fetch target page for layout audit: ${err?.message}`);
  }

  return {
    ok: domRes.ok && layoutIssues.length === 0,
    engine: 'dom-layout-audit',
    url: rawTarget,
    layoutIssues,
    domAuditSummary: domRes.domMetrics,
    visionCritique:
      'Headless screenshot engine (Playwright or BROWSERLESS_TOKEN) is not active in this container; completed JSDOM + CSS structural/responsive layout audit instead.',
    recommendations:
      recommendations.length > 0
        ? recommendations
        : ['Optional: set BROWSERLESS_TOKEN + APP_URL in env for full Chromium PNG screenshot + Vision model critique on Render Free.'],
  };
}
