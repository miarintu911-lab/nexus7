import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export interface StockImageRequestItem {
  query: string;
  filename?: string;
  aspectRatio?: '1:1' | '16:9' | '4:3' | '3:4' | '9:16' | string;
}

export interface StockImageResultItem {
  query: string;
  imageUrl: string;
  localFile: string;
  source: 'openverse' | 'wikimedia-commons' | 'wikipedia' | 'pollinations' | 'local-svg-artwork';
  bytes: number;
  width: number;
  height: number;
  attribution?: string;
}

export interface BatchStockImagesResult {
  success: boolean;
  tokenCost: number;
  count: number;
  targetDir: string;
  images: StockImageResultItem[];
  modifiedFiles: string[];
  usageNote: string;
  error?: string;
}

const REQUEST_HEADERS = {
  'User-Agent': 'NexusAIStudio/1.0 (https://github.com/nexus-ai; media-prefetch)',
  Accept: 'application/json, image/*;q=0.9',
};

function sanitizeSlug(raw: string, fallbackPrefix = 'stock'): string {
  const cleaned = String(raw || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || `${fallbackPrefix}_${Date.now().toString(36)}`;
}

function getTargetDimensions(aspectRatio?: string): [number, number] {
  switch (aspectRatio) {
    case '1:1':
      return [720, 720];
    case '9:16':
      return [640, 1138];
    case '3:4':
      return [720, 960];
    case '4:3':
      return [960, 720];
    case '16:9':
    default:
      return [1120, 630];
  }
}

function detectImageExtension(buf: Buffer, contentType: string): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (buf.length < 16) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }
  const ctype = (contentType || '').toLowerCase();
  if (ctype.includes('image/jpeg') || ctype.includes('image/jpg')) return 'jpg';
  if (ctype.includes('image/png')) return 'png';
  if (ctype.includes('image/webp')) return 'webp';
  if (ctype.includes('image/gif')) return 'gif';
  return null;
}

async function downloadVerifiedImage(
  url: string,
  timeoutMs = 7000
): Promise<{ buffer: Buffer; ext: 'jpg' | 'png' | 'webp' | 'gif' } | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': REQUEST_HEADERS['User-Agent'],
        Accept: 'image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) {
      return null;
    }
    if (contentType.includes('svg')) return null;

    const clen = Number(res.headers.get('content-length') || 0);
    if (clen > 8 * 1024 * 1024) return null; // Skip overly huge raw originals

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1800 || buf.length > 8 * 1024 * 1024) return null;

    const ext = detectImageExtension(buf, contentType);
    if (!ext) return null;
    return { buffer: buf, ext };
  } catch {
    return null;
  }
}

interface CandidateUrl {
  url: string;
  source: 'openverse' | 'wikimedia-commons' | 'wikipedia';
  attribution?: string;
}

async function searchOpenverseCandidates(query: string, targetW: number, targetH: number): Promise<CandidateUrl[]> {
  try {
    const aspectParam = targetW === targetH ? '&aspect_ratio=square' : targetW > targetH ? '&aspect_ratio=wide' : '&aspect_ratio=tall';
    const apiUrl = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=6&mature=false${aspectParam}`;
    const res = await fetch(apiUrl, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(5500) });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => null);
    const results = Array.isArray(data?.results) ? data.results : [];
    const candidates: CandidateUrl[] = [];
    for (const item of results) {
      const candidate = item?.thumbnail || item?.url;
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) {
        candidates.push({
          url: candidate,
          source: 'openverse',
          attribution: item?.creator ? `${item.creator} (${item.license || 'CC'})` : 'Openverse CC',
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchWikimediaCandidates(query: string, targetW: number): Promise<CandidateUrl[]> {
  try {
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      query
    )}&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url|mime|size&iiurlwidth=${Math.min(Math.max(targetW, 640), 1200)}&format=json&origin=*`;
    const res = await fetch(apiUrl, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(5500) });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => null);
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    const candidates: CandidateUrl[] = [];
    for (const page of pages as any[]) {
      const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
      if (!info) continue;
      const mime = String(info.mime || '').toLowerCase();
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) continue;
      if (typeof info.width === 'number' && info.width < 280) continue;
      const chosen = info.thumburl || info.url;
      if (typeof chosen === 'string' && /^https?:\/\//i.test(chosen)) {
        candidates.push({
          url: chosen,
          source: 'wikimedia-commons',
          attribution: 'Wikimedia Commons',
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function searchWikipediaCandidates(query: string, targetW: number): Promise<CandidateUrl[]> {
  try {
    const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(
      query
    )}&gsrlimit=5&prop=pageimages&pithumbsize=${Math.min(Math.max(targetW, 640), 1200)}&format=json&origin=*`;
    const res = await fetch(apiUrl, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => null);
    const pages = data?.query?.pages ? Object.values(data.query.pages) : [];
    const candidates: CandidateUrl[] = [];
    for (const page of pages as any[]) {
      const thumb = page?.thumbnail?.source;
      if (typeof thumb === 'string' && /^https?:\/\//i.test(thumb) && !/\.svg(\?|$)/i.test(thumb)) {
        candidates.push({
          url: thumb,
          source: 'wikipedia',
          attribution: 'Wikipedia Commons',
        });
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

function buildFallbackSvgCard(query: string, w: number, h: number): string {
  const safeTitle = query.replace(/[<>&"']/g, '').trim().slice(0, 40) || 'Visual Asset';
  const lower = query.toLowerCase();
  const [bgA, bgB, accentA, accentB] = /(food|cafe|coffee|bakery|restaurant|dish|tea|dessert)/i.test(lower)
    ? ['#1c1917', '#292524', '#f59e0b', '#fbbf24']
    : /(health|bio|eco|nature|plant|green|organic|garden)/i.test(lower)
      ? ['#062019', '#0c352b', '#10b981', '#34d399']
      : /(fashion|luxury|watch|shoe|bag|apparel|beauty|jewelry)/i.test(lower)
        ? ['#18181b', '#27272a', '#e11d48', '#fb7185']
        : ['#0b1120', '#1e293b', '#38bdf8', '#818cf8'];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bgA}"/>
      <stop offset="100%" stop-color="${bgB}"/>
    </linearGradient>
    <radialGradient id="orb" cx="70%" cy="30%" r="55%">
      <stop offset="0%" stop-color="${accentA}" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="${accentA}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#orb)"/>
  <circle cx="${Math.round(w * 0.72)}" cy="${Math.round(h * 0.34)}" r="${Math.round(Math.min(w, h) * 0.18)}" fill="${accentB}" fill-opacity="0.14" stroke="${accentA}" stroke-opacity="0.4" stroke-width="2"/>
  <text x="${Math.round(w * 0.08)}" y="${Math.round(h * 0.54)}" fill="#f8fafc" font-family="system-ui, -apple-system, sans-serif" font-size="${Math.max(18, Math.round(w * 0.036))}" font-weight="700">${safeTitle}</text>
  <rect x="${Math.round(w * 0.08)}" y="${Math.round(h * 0.60)}" width="64" height="3" rx="1.5" fill="${accentA}"/>
</svg>`;
}

async function resolveStorageDestination(options: { sessionId?: string; targetDir?: string }): Promise<{
  absDir: string;
  relDir: string;
  urlPrefix: string;
}> {
  const cwd = process.cwd();
  if (options.targetDir && typeof options.targetDir === 'string') {
    const cleanRel = options.targetDir.replace(/^\/+/, '').replace(/\.\.(\/|\\|$)/g, '').trim();
    const absDir = path.resolve(cwd, cleanRel);
    if (absDir.startsWith(cwd)) {
      const wsPubMatch = cleanRel.match(/^workspaces\/[^/]+\/public\/(.*)$/);
      const rootPubMatch = cleanRel.match(/^public\/(.*)$/);
      const projMatch = cleanRel.match(/^projects\/[^/]+\/(.*)$/);
      const urlPrefix = wsPubMatch
        ? `./${wsPubMatch[1].replace(/\/+$/, '')}`
        : projMatch
          ? `./${projMatch[1].replace(/\/+$/, '')}`
          : rootPubMatch
            ? `/${rootPubMatch[1].replace(/\/+$/, '')}`
            : `./${cleanRel.replace(/\/+$/, '')}`;
      return { absDir, relDir: cleanRel, urlPrefix };
    }
  }

  if (options.sessionId && String(options.sessionId).trim()) {
    const safeId = String(options.sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default';
    const relDir = `workspaces/${safeId}/public/images`;
    return {
      absDir: path.resolve(cwd, relDir),
      relDir,
      urlPrefix: './images',
    };
  }

  const relDir = 'public/generated/stock';
  return {
    absDir: path.resolve(cwd, relDir),
    relDir,
    urlPrefix: '/generated/stock',
  };
}

export async function fetchBatchStockImages(
  rawItems: StockImageRequestItem[],
  options: { sessionId?: string; targetDir?: string } = {}
): Promise<BatchStockImagesResult> {
  const items = Array.isArray(rawItems)
    ? rawItems
        .filter((it) => it && typeof it.query === 'string' && it.query.trim().length > 0)
        .slice(0, 16)
    : [];

  if (items.length === 0) {
    return {
      success: false,
      tokenCost: 0,
      count: 0,
      targetDir: '',
      images: [],
      modifiedFiles: [],
      usageNote: 'Provide at least one item in items: [{ query, filename?, aspectRatio? }].',
      error: 'items array with at least one non-empty query is required',
    };
  }

  const dest = await resolveStorageDestination(options);
  await fs.mkdir(dest.absDir, { recursive: true });

  const usedFilenames = new Set<string>();
  const usedRemoteUrls = new Set<string>();

  const allocateBaseName = (item: StockImageRequestItem, index: number): string => {
    const base = sanitizeSlug(item.filename || item.query, `img_${index + 1}`);
    if (!usedFilenames.has(base)) {
      usedFilenames.add(base);
      return base;
    }
    let counter = 2;
    while (usedFilenames.has(`${base}_${counter}`)) {
      counter++;
    }
    const unique = `${base}_${counter}`;
    usedFilenames.add(unique);
    return unique;
  };

  // Pre-allocate deterministic filenames before concurrent downloads
  const prepared = items.map((item, idx) => ({
    item,
    baseName: allocateBaseName(item, idx),
  }));

  const results: StockImageResultItem[] = new Array(prepared.length);
  const CONCURRENCY = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < prepared.length) {
      const idx = cursor++;
      const { item, baseName } = prepared[idx];
      const query = item.query.trim();
      const [width, height] = getTargetDimensions(item.aspectRatio);

      // Search Openverse + Wikimedia Commons + Wikipedia concurrently for fast zero-token stock discovery
      const [openverseList, wikiMediaList, wikiPageList] = await Promise.all([
        searchOpenverseCandidates(query, width, height),
        searchWikimediaCandidates(query, width),
        searchWikipediaCandidates(query, width),
      ]);

      const mergedCandidates: CandidateUrl[] = [];
      const maxLen = Math.max(openverseList.length, wikiMediaList.length, wikiPageList.length);
      for (let i = 0; i < maxLen; i++) {
        if (openverseList[i]) mergedCandidates.push(openverseList[i]);
        if (wikiMediaList[i]) mergedCandidates.push(wikiMediaList[i]);
        if (wikiPageList[i]) mergedCandidates.push(wikiPageList[i]);
      }

      let savedResult: StockImageResultItem | null = null;

      for (const cand of mergedCandidates) {
        if (usedRemoteUrls.has(cand.url)) continue;
        const downloaded = await downloadVerifiedImage(cand.url, 6500);
        if (!downloaded) continue;

        usedRemoteUrls.add(cand.url);
        const fileName = `${baseName}.${downloaded.ext}`;
        const absFile = path.join(dest.absDir, fileName);
        await fs.writeFile(absFile, downloaded.buffer);

        savedResult = {
          query,
          imageUrl: `${dest.urlPrefix}/${fileName}`,
          localFile: `${dest.relDir}/${fileName}`,
          source: cand.source,
          bytes: downloaded.buffer.length,
          width,
          height,
          attribution: cand.attribution,
        };
        break;
      }

      // Zero-Gemini-token fallback 1: Pollinations.ai
      if (!savedResult) {
        const seed = parseInt(crypto.createHash('md5').update(`${query}_${idx}`).digest('hex').slice(0, 6), 16) % 99999;
        const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(
          `${query}, crisp editorial photography, high resolution`
        )}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
        const downloaded = await downloadVerifiedImage(pollUrl, 9000);
        if (downloaded) {
          const fileName = `${baseName}.${downloaded.ext}`;
          const absFile = path.join(dest.absDir, fileName);
          await fs.writeFile(absFile, downloaded.buffer);
          savedResult = {
            query,
            imageUrl: `${dest.urlPrefix}/${fileName}`,
            localFile: `${dest.relDir}/${fileName}`,
            source: 'pollinations',
            bytes: downloaded.buffer.length,
            width,
            height,
          };
        }
      }

      // Offline-resilient fallback 2: Local crisp SVG artwork
      if (!savedResult) {
        const svg = buildFallbackSvgCard(query, width, height);
        const fileName = `${baseName}.svg`;
        const absFile = path.join(dest.absDir, fileName);
        await fs.writeFile(absFile, svg, 'utf-8');
        savedResult = {
          query,
          imageUrl: `${dest.urlPrefix}/${fileName}`,
          localFile: `${dest.relDir}/${fileName}`,
          source: 'local-svg-artwork',
          bytes: Buffer.byteLength(svg, 'utf-8'),
          width,
          height,
        };
      }

      results[idx] = savedResult;
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prepared.length) }, () => worker()));

  return {
    success: true,
    tokenCost: 0,
    count: results.length,
    targetDir: dest.relDir,
    images: results,
    modifiedFiles: results.map((r) => r.localFile),
    usageNote:
      options.sessionId && !options.targetDir
        ? `Saved ${results.length} verified local image(s) to ${dest.relDir}/. Reference them in React/seed data directly via imageUrl (e.g. "${results[0]?.imageUrl}") — Vite automatically bundles public/images/ for both dev (/w/<id>/) and static build (/projects/<id>/).`
        : `Saved ${results.length} verified local image(s) to ${dest.relDir}/. Reference them directly via imageUrl.`,
  };
}
