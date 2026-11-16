import { GoogleGenAI } from '@google/genai';
import { Client, handle_file } from '@gradio/client';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fetchBatchStockImages } from './mediaFetcher.ts';

const execFilePromise = promisify(execFile);

export interface VideoSceneInput {
  visualPrompt: string;
  narrationText?: string;
  overlayText?: string;
  durationSec?: number;
}

export type VideoEnginePreference = 'auto' | 'ltx-video' | 'wan2.1' | 'ffmpeg-studio';

export interface GenerateVideoOptions {
  prompt: string;
  scenes?: VideoSceneInput[];
  aspectRatio?: '16:9' | '9:16' | '1:1';
  audioMood?: 'cinematic' | 'upbeat' | 'ambient' | 'none';
  voiceLanguage?: 'auto' | 'bn' | 'en' | 'none';
  videoEngine?: VideoEnginePreference;
  videoName?: string;
  geminiApiKey?: string;
  huggingfaceApiKey?: string;
  pollinationsApiKey?: string;
  preferDiffusionApi?: boolean;
}

export interface GenerateVideoResult {
  success: boolean;
  videoUrl?: string;
  durationSec?: number;
  resolution?: string;
  aspectRatio?: string;
  hasAudio?: boolean;
  scenesCount?: number;
  provider?: string;
  description?: string;
  error?: string;
}

const FONT_BENGALI = '/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf';
const FONT_LATIN = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf';

function sanitizeFileSlug(raw?: string): string {
  return (raw || `vid_${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function getDimensions(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === '9:16') return { width: 720, height: 1280 };
  if (aspectRatio === '1:1') return { width: 720, height: 720 };
  return { width: 1280, height: 720 };
}

function getZeroGpuDims(aspectRatio: string): { width: number; height: number; wanWidth: number; wanHeight: number } {
  if (aspectRatio === '9:16') return { width: 512, height: 704, wanWidth: 512, wanHeight: 896 };
  if (aspectRatio === '1:1') return { width: 512, height: 512, wanWidth: 512, wanHeight: 512 };
  return { width: 704, height: 512, wanWidth: 896, wanHeight: 512 };
}

function wrapTextForOverlay(text: string, maxCharsPerLine: number): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
    } else if ((current + ' ' + w).length <= maxCharsPerLine) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
      if (lines.length >= 2) break;
    }
  }
  if (current && lines.length < 3) lines.push(current);
  return lines.slice(0, 3).join('\n');
}

function splitTextForTts(text: string, maxLen: number = 175): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < 4) {
    if (rest.length <= maxLen) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf('।', maxLen);
    if (cut < 40) cut = rest.lastIndexOf('.', maxLen);
    if (cut < 40) cut = rest.lastIndexOf(',', maxLen);
    if (cut < 40) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < 20) cut = maxLen;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return chunks.filter(Boolean);
}

function buildFallbackScenesFromPrompt(prompt: string): VideoSceneInput[] {
  const cleanPrompt = (prompt || 'Modern story showcase').replace(/\s+/g, ' ').trim();
  const isBengali = /[\u0980-\u09FF]/.test(cleanPrompt);
  const shortTitle = cleanPrompt.slice(0, 48);

  if (isBengali) {
    return [
      {
        visualPrompt: `Cinematic wide establishing shot representing: ${cleanPrompt}, ultra detailed, golden lighting, 8k`,
        overlayText: shortTitle,
        narrationText: `${shortTitle} — চমৎকার দৃশ্যপট দিয়ে শুরু হচ্ছে আজকের ভিডিও।`,
        durationSec: 4,
      },
      {
        visualPrompt: `Dynamic close-up smooth motion shot of: ${cleanPrompt}, crisp depth of field, atmospheric lighting, realistic`,
        overlayText: 'গতি ও জীবন্ত দৃশ্য',
        narrationText: 'প্রতিটি মুহূর্তে থাকছে প্রাণবন্ত ভিজ্যুয়াল এবং স্পষ্ট বর্ণনা।',
        durationSec: 4,
      },
      {
        visualPrompt: `Epic dramatic finale wide landscape shot of: ${cleanPrompt}, glowing horizon, photorealistic`,
        overlayText: 'Nexus AI ভিডিও স্টুডিও',
        narrationText: 'ধন্যবাদ সাথে থাকার জন্য।',
        durationSec: 3.5,
      },
    ];
  }

  return [
    {
      visualPrompt: `Cinematic wide establishing shot: ${cleanPrompt}, dramatic natural lighting, 8k film shot`,
      overlayText: shortTitle,
      narrationText: `Welcome to this visual showcase of ${shortTitle}.`,
      durationSec: 4,
    },
    {
      visualPrompt: `Dynamic close-up smooth motion shot: ${cleanPrompt}, shallow depth of field, golden hour`,
      overlayText: 'Action & Atmosphere',
      narrationText: 'Experience vivid scenes crafted with synchronized motion and narration.',
      durationSec: 4,
    },
    {
      visualPrompt: `Epic dramatic finale shot: ${cleanPrompt}, atmospheric sunrise light, photorealistic`,
      overlayText: 'Created with Nexus Video AI',
      narrationText: 'Thank you for watching.',
      durationSec: 3.5,
    },
  ];
}

async function fetchTtsWavForScene(
  narrationText: string,
  langPref: 'auto' | 'bn' | 'en' | 'none',
  tmpDir: string,
  sceneIdx: number
): Promise<string | null> {
  if (langPref === 'none' || !narrationText.trim()) return null;

  const isBengali = /[\u0980-\u09FF]/.test(narrationText);
  const tl = langPref === 'auto' ? (isBengali ? 'bn' : 'en') : langPref;
  const parts = splitTextForTts(narrationText);
  const wavOut = path.join(tmpDir, `tts_${sceneIdx}.wav`);

  try {
    const mp3Buffers: Buffer[] = [];
    for (const chunk of parts) {
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(chunk)}`;
      const res = await fetch(ttsUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(7000),
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 512) {
          mp3Buffers.push(buf);
        }
      }
    }

    if (mp3Buffers.length > 0) {
      const rawMp3 = path.join(tmpDir, `tts_raw_${sceneIdx}.mp3`);
      await fs.writeFile(rawMp3, Buffer.concat(mp3Buffers));
      await execFilePromise('ffmpeg', [
        '-y',
        '-i', rawMp3,
        '-ar', '44100',
        '-ac', '2',
        '-c:a', 'pcm_s16le',
        wavOut,
      ], { timeout: 15000 });
      return wavOut;
    }
  } catch (ttsErr: any) {
    console.warn(`[VideoGenerator] Cloud TTS fallback for scene ${sceneIdx}:`, ttsErr?.message || ttsErr);
  }

  if (!isBengali) {
    try {
      const safeAscii = narrationText.replace(/[^a-zA-Z0-9 .,!?-]/g, ' ').trim().slice(0, 140);
      if (safeAscii) {
        await execFilePromise('ffmpeg', [
          '-y',
          '-f', 'lavfi',
          '-i', `flite=text='${safeAscii.replace(/'/g, '')}'`,
          '-ar', '44100',
          '-ac', '2',
          '-c:a', 'pcm_s16le',
          wavOut,
        ], { timeout: 15000 });
        return wavOut;
      }
    } catch {}
  }

  return null;
}

async function probeMediaDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFilePromise('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ], { timeout: 8000 });
    const val = parseFloat((stdout || '').trim());
    return Number.isFinite(val) && val > 0 ? val : 0;
  } catch {
    return 0;
  }
}

async function acquireSceneImage(
  visualPrompt: string,
  aspectRatio: string,
  width: number,
  height: number,
  tmpDir: string,
  sceneIdx: number,
  geminiApiKey?: string
): Promise<{ path: string; source: string }> {
  const outImg = path.join(tmpDir, `scene_img_${sceneIdx}.jpg`);

  if (geminiApiKey && sceneIdx < 2) {
    try {
      const imgClient = new GoogleGenAI({
        apiKey: geminiApiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const res = await imgClient.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: visualPrompt,
      });
      const parts = res.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.inlineData?.data) {
          const ext = (p.inlineData.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
          const gemPath = path.join(tmpDir, `scene_img_${sceneIdx}.${ext}`);
          await fs.writeFile(gemPath, Buffer.from(p.inlineData.data, 'base64'));
          return { path: gemPath, source: 'gemini-2.5-flash-image' };
        }
      }
    } catch (err: any) {
      console.warn(`[VideoGenerator] Gemini image skipped for scene ${sceneIdx}:`, err?.message || err);
    }
  }

  if (sceneIdx > 0) {
    await new Promise((r) => setTimeout(r, sceneIdx * 550));
  }
  const seed = Math.abs(
    Array.from(`${visualPrompt}_${sceneIdx}`).reduce<number>((acc, ch) => ((acc << 5) - acc + ch.charCodeAt(0)) | 0, 0)
  ) % 99999;
  const pollUrls = [
    `https://image.pollinations.ai/prompt/${encodeURIComponent(visualPrompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true`,
    `https://gen.pollinations.ai/image/${encodeURIComponent(visualPrompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true`,
  ];
  for (const url of pollUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(16000) });
      const ctype = res.headers.get('content-type') || '';
      if (res.ok && ctype.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 3072) {
          await fs.writeFile(outImg, buf);
          return { path: outImg, source: 'pollinations-image' };
        }
      }
    } catch {}
  }

  try {
    const stockRes = await fetchBatchStockImages(
      [{ query: visualPrompt.slice(0, 60), filename: `vid_sc_${sceneIdx}`, aspectRatio: aspectRatio as any }],
      { targetDir: tmpDir }
    );
    const firstStock = stockRes?.images?.[0];
    const saved = firstStock?.localFile ? path.resolve(tmpDir, firstStock.localFile) : undefined;
    if (saved) {
      return { path: saved, source: firstStock.source || 'stock' };
    }
  } catch {}

  const palette = ['#0f172a', '#1e1b4b', '#064e3b', '#31102f'][sceneIdx % 4];
  await execFilePromise('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${palette}:s=${width}x${height}:d=1`,
    '-frames:v', '1',
    outImg,
  ], { timeout: 8000 });
  return { path: outImg, source: 'ffmpeg-backdrop' };
}

function getGradioClientOptions(hfToken?: string): { token?: `hf_${string}` } | undefined {
  const cleaned = (hfToken || '').trim();
  if (cleaned.startsWith('hf_')) {
    return { token: cleaned as `hf_${string}` };
  }
  return undefined;
}

function extractGradioVideoUrl(data: unknown): string | null {
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!item) continue;
    if (typeof item === 'string' && /^https?:\/\/.*\.mp4/i.test(item)) {
      return item;
    }
    if (typeof item === 'object') {
      const obj = item as any;
      if (typeof obj?.video?.url === 'string') return obj.video.url;
      if (typeof obj?.url === 'string' && !obj.url.endsWith('.png') && !obj.url.endsWith('.jpg')) {
        return obj.url;
      }
    }
  }
  return null;
}

async function downloadGradioMp4(videoUrl: string, outMp4Path: string, hfToken?: string): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (hfToken?.trim().startsWith('hf_')) {
    headers['Authorization'] = `Bearer ${hfToken.trim()}`;
  }
  const res = await fetch(videoUrl, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 12000) return false;
  await fs.writeFile(outMp4Path, buf);
  return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function tryLtxVideoZeroGpuClip(
  visualPrompt: string,
  aspectRatio: string,
  durationSec: number,
  outMp4Path: string,
  hfToken?: string
): Promise<{ ok: boolean; space?: string; error?: string }> {
  const dims = getZeroGpuDims(aspectRatio);
  const clipDur = Math.max(2, Math.min(4, Math.round(durationSec)));
  const clientOpts = getGradioClientOptions(hfToken);
  const ltxSpaces = ['Lightricks/ltx-video-distilled', 'DeepRat/LTX-Video-ZeroGPU-Optimized'];

  for (const spaceId of ltxSpaces) {
    try {
      const client = await withTimeout(Client.connect(spaceId, clientOpts), 18000, `Connect ${spaceId}`);
      const payload: Record<string, unknown> = {
        prompt: visualPrompt.slice(0, 420),
        negative_prompt: 'worst quality, inconsistent motion, blurry, jittery, distorted, watermark, text',
        height_ui: dims.height,
        width_ui: dims.width,
        mode: 'text-to-video',
        duration_ui: clipDur,
        ui_frames_to_use: 9,
        seed_ui: Math.floor(Math.random() * 1000000),
        randomize_seed: true,
        ui_guidance_scale: 1,
        improve_texture_flag: true,
      };
      if (spaceId === 'DeepRat/LTX-Video-ZeroGPU-Optimized') {
        payload.slow_motion_flag = false;
      }

      const result = await withTimeout(client.predict('/text_to_video', payload), 65000, `Predict ${spaceId}`);
      const videoUrl = extractGradioVideoUrl(result?.data);
      if (videoUrl && (await downloadGradioMp4(videoUrl, outMp4Path, hfToken))) {
        return { ok: true, space: spaceId };
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`[VideoGenerator] ZeroGPU LTX (${spaceId}) skipped:`, msg);
      if (/quota|ZeroGPU/i.test(msg)) {
        return { ok: false, error: msg };
      }
    }
  }
  return { ok: false };
}

async function tryWan21ZeroGpuClip(
  visualPrompt: string,
  aspectRatio: string,
  durationSec: number,
  initImgPath: string,
  outMp4Path: string,
  hfToken?: string
): Promise<{ ok: boolean; space?: string; error?: string }> {
  const dims = getZeroGpuDims(aspectRatio);
  const clientOpts = getGradioClientOptions(hfToken);
  const imgBuf = await fs.readFile(initImgPath).catch(() => null);
  if (!imgBuf) return { ok: false, error: 'Missing input image for Wan2.1' };

  // 1. Primary: multimodalart/wan2-1-fast (Wan 2.1 14B + CausVid LoRA, 4 steps on ZeroGPU A10G)
  try {
    const client = await withTimeout(
      Client.connect('multimodalart/wan2-1-fast', clientOpts),
      18000,
      'Connect multimodalart/wan2-1-fast'
    );
    const clipDur = Math.max(1.5, Math.min(3.2, Number(durationSec) || 2.5));
    const result = await withTimeout(
      client.predict('/generate_video', {
        input_image: handle_file(imgBuf),
        prompt: `${visualPrompt.slice(0, 380)}, smooth cinematic motion, natural movement`,
        height: dims.wanHeight,
        width: dims.wanWidth,
        negative_prompt: 'Bright tones, overexposed, static, blurred details, subtitles, watermark, text, distorted',
        duration_seconds: clipDur,
        guidance_scale: 1,
        steps: 4,
        seed: Math.floor(Math.random() * 1000000),
        randomize_seed: true,
      }),
      75000,
      'Predict multimodalart/wan2-1-fast'
    );
    const videoUrl = extractGradioVideoUrl(result?.data);
    if (videoUrl && (await downloadGradioMp4(videoUrl, outMp4Path, hfToken))) {
      return { ok: true, space: 'multimodalart/wan2-1-fast' };
    }
  } catch (err: any) {
    console.warn(`[VideoGenerator] ZeroGPU Wan2.1 (wan2-1-fast) skipped:`, err?.message || err);
  }

  // 2. Fallback: prashant-AI-ML/Wan-2.2-pro-Superb (ZeroGPU A10G with safe_mode: true)
  try {
    const client = await withTimeout(
      Client.connect('prashant-AI-ML/Wan-2.2-pro-Superb', clientOpts),
      18000,
      'Connect Wan-2.2-pro-Superb'
    );
    const clipDur = Math.max(2, Math.min(4, Number(durationSec) || 3));
    const result = await withTimeout(
      client.predict('/generate_video', {
        input_image: handle_file(imgBuf),
        prompt: `${visualPrompt.slice(0, 380)}, smooth cinematic motion`,
        steps: 4,
        negative_prompt: 'static, blurry, distorted, watermark, text',
        duration_seconds: clipDur,
        guidance_scale: 1,
        guidance_scale_2: 1,
        seed: Math.floor(Math.random() * 1000000),
        randomize_seed: true,
        quality: 6,
        safe_mode: true,
      }),
      75000,
      'Predict Wan-2.2-pro-Superb'
    );
    const videoUrl = extractGradioVideoUrl(result?.data);
    if (videoUrl && (await downloadGradioMp4(videoUrl, outMp4Path, hfToken))) {
      return { ok: true, space: 'prashant-AI-ML/Wan-2.2-pro-Superb' };
    }
  } catch (err: any) {
    console.warn(`[VideoGenerator] ZeroGPU Wan2.2 fallback skipped:`, err?.message || err);
  }

  return { ok: false };
}

function getMoodAudioExpr(mood: string, sceneIdx: number): string {
  const baseFreqs = mood === 'upbeat'
    ? [329.63, 392.0, 493.88, 659.25]
    : mood === 'ambient'
      ? [220.0, 277.18, 329.63, 440.0]
      : [196.0, 246.94, 293.66, 392.0];
  const root = baseFreqs[sceneIdx % 2 === 0 ? 0 : 1];
  const fifth = baseFreqs[2];
  const octave = baseFreqs[3];
  const pulse = mood === 'upbeat' ? '(0.75+0.25*sin(2*PI*2*t))' : '(0.85+0.15*sin(2*PI*0.35*t))';
  return `0.065*${pulse}*(sin(2*PI*${root}*t)+0.55*sin(2*PI*${fifth}*t)+0.3*sin(2*PI*${octave}*t))`;
}

async function tryHuggingFaceOrPollinationsDiffusionVideo(
  options: GenerateVideoOptions,
  outMp4Path: string
): Promise<{ ok: boolean; provider?: string }> {
  const { prompt, aspectRatio = '16:9', huggingfaceApiKey, pollinationsApiKey } = options;

  if (pollinationsApiKey) {
    try {
      const url = `https://gen.pollinations.ai/video/${encodeURIComponent(prompt)}?duration=4&aspectRatio=${encodeURIComponent(aspectRatio)}&key=${encodeURIComponent(pollinationsApiKey)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && (ct.includes('video') || ct.includes('octet-stream'))) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 15000) {
          await fs.writeFile(outMp4Path, buf);
          return { ok: true, provider: 'pollinations-video-api' };
        }
      }
    } catch {}
  }

  if (huggingfaceApiKey && options.preferDiffusionApi) {
    const hfModels = ['Lightricks/LTX-Video', 'Wan-AI/Wan2.1-T2V-1.3B'];
    for (const model of hfModels) {
      try {
        const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${huggingfaceApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: prompt }),
          signal: AbortSignal.timeout(45000),
        });
        const ct = res.headers.get('content-type') || '';
        if (res.ok && (ct.includes('video') || ct.includes('octet-stream'))) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 15000) {
            await fs.writeFile(outMp4Path, buf);
            return { ok: true, provider: `huggingface:${model}` };
          }
        }
      } catch {}
    }
  }

  return { ok: false };
}

export async function generateAiVideoWithAudio(
  options: GenerateVideoOptions
): Promise<GenerateVideoResult> {
  const aspectRatio = options.aspectRatio || '16:9';
  const { width, height } = getDimensions(aspectRatio);
  const audioMood = options.audioMood || 'cinematic';
  const voiceLanguage = options.voiceLanguage || 'auto';
  const videoEngine: VideoEnginePreference = options.videoEngine || 'auto';

  const outDir = path.resolve(process.cwd(), 'public', 'generated');
  await fs.mkdir(outDir, { recursive: true });

  const fileSlug = sanitizeFileSlug(options.videoName || `vid_${Date.now()}`);
  const finalFileName = fileSlug.endsWith('.mp4') ? fileSlug : `${fileSlug}.mp4`;
  const finalMp4Path = path.join(outDir, finalFileName);

  const diffusionTry = await tryHuggingFaceOrPollinationsDiffusionVideo(options, finalMp4Path);
  if (diffusionTry.ok) {
    const dur = await probeMediaDuration(finalMp4Path);
    return {
      success: true,
      videoUrl: `/generated/${finalFileName}`,
      durationSec: Math.round((dur || 4) * 10) / 10,
      resolution: `${width}x${height}`,
      aspectRatio,
      hasAudio: false,
      scenesCount: 1,
      provider: diffusionTry.provider,
      description: `Generated AI diffusion video saved to /generated/${finalFileName}`,
    };
  }

  const rawScenes = Array.isArray(options.scenes) && options.scenes.length > 0
    ? options.scenes.slice(0, 4)
    : buildFallbackScenesFromPrompt(options.prompt);

  const tmpDir = path.join('/tmp', `nexus_vid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    // Prepare TTS narration audio concurrently across all scenes first
    const ttsWavs = await Promise.all(
      rawScenes.map((scene, idx) =>
        fetchTtsWavForScene(
          scene.narrationText || scene.overlayText || '',
          voiceLanguage,
          tmpDir,
          idx
        )
      )
    );

    const preparedScenes: Array<{
      idx: number;
      aiVideoPath?: string;
      imgPath?: string;
      visualSource: string;
      ttsWav: string | null;
      overlayText: string;
      durationSec: number;
    }> = [];

    let zeroGpuQuotaHit = false;

    for (let idx = 0; idx < rawScenes.length; idx++) {
      const scene = rawScenes[idx];
      const ttsWav = ttsWavs[idx];
      const ttsDur = ttsWav ? await probeMediaDuration(ttsWav) : 0;
      const durationSec = Math.min(10, Math.max(Number(scene.durationSec) || 3.5, ttsDur > 0 ? ttsDur + 0.65 : 3.5));

      let aiVideoPath: string | undefined;
      let imgPath: string | undefined;
      let visualSource = '';

      const allowZeroGpu = videoEngine !== 'ffmpeg-studio' && !zeroGpuQuotaHit && idx < 3;

      if (allowZeroGpu) {
        const zeroMp4 = path.join(tmpDir, `zerogpu_${idx}.mp4`);

        if (videoEngine === 'wan2.1') {
          // Wan 2.1 prefers an input starting image -> animates via Wan2.1 ZeroGPU
          const imgRes = await acquireSceneImage(
            scene.visualPrompt || options.prompt,
            aspectRatio,
            width,
            height,
            tmpDir,
            idx,
            options.geminiApiKey
          );
          imgPath = imgRes.path;
          visualSource = imgRes.source;

          const wanRes = await tryWan21ZeroGpuClip(
            scene.visualPrompt || options.prompt,
            aspectRatio,
            durationSec,
            imgRes.path,
            zeroMp4,
            options.huggingfaceApiKey
          );
          if (wanRes.ok) {
            aiVideoPath = zeroMp4;
            visualSource = `zerogpu:${wanRes.space}`;
          } else {
            // Fallback to LTX-Video ZeroGPU if Wan2.1 Space is busy/offline
            const ltxRes = await tryLtxVideoZeroGpuClip(
              scene.visualPrompt || options.prompt,
              aspectRatio,
              durationSec,
              zeroMp4,
              options.huggingfaceApiKey
            );
            if (ltxRes.ok) {
              aiVideoPath = zeroMp4;
              visualSource = `zerogpu:${ltxRes.space}`;
            } else if (/quota|ZeroGPU/i.test(ltxRes.error || '')) {
              zeroGpuQuotaHit = true;
            }
          }
        } else {
          // 'auto' or 'ltx-video': try fast LTX-Video ZeroGPU first, then Wan2.1 ZeroGPU fallback
          const ltxRes = await tryLtxVideoZeroGpuClip(
            scene.visualPrompt || options.prompt,
            aspectRatio,
            durationSec,
            zeroMp4,
            options.huggingfaceApiKey
          );
          if (ltxRes.ok) {
            aiVideoPath = zeroMp4;
            visualSource = `zerogpu:${ltxRes.space}`;
          } else {
            if (/quota|ZeroGPU/i.test(ltxRes.error || '')) {
              zeroGpuQuotaHit = true;
            }
            const imgRes = await acquireSceneImage(
              scene.visualPrompt || options.prompt,
              aspectRatio,
              width,
              height,
              tmpDir,
              idx,
              options.geminiApiKey
            );
            imgPath = imgRes.path;
            visualSource = imgRes.source;

            if (!zeroGpuQuotaHit) {
              const wanRes = await tryWan21ZeroGpuClip(
                scene.visualPrompt || options.prompt,
                aspectRatio,
                durationSec,
                imgRes.path,
                zeroMp4,
                options.huggingfaceApiKey
              );
              if (wanRes.ok) {
                aiVideoPath = zeroMp4;
                visualSource = `zerogpu:${wanRes.space}`;
              }
            }
          }
        }
      }

      if (!aiVideoPath && !imgPath) {
        const imgRes = await acquireSceneImage(
          scene.visualPrompt || options.prompt,
          aspectRatio,
          width,
          height,
          tmpDir,
          idx,
          options.geminiApiKey
        );
        imgPath = imgRes.path;
        visualSource = imgRes.source;
      }

      preparedScenes.push({
        idx,
        aiVideoPath,
        imgPath,
        visualSource,
        ttsWav,
        overlayText: (scene.overlayText || '').trim(),
        durationSec: Math.round(durationSec * 10) / 10,
      });
    }

    // Compose every scene clip (ZeroGPU moving AI video OR Ken Burns image) + TTS voiceover + music + text caption
    const sceneMp4Paths: string[] = [];
    for (const sc of preparedScenes) {
      const clipPath = path.join(tmpDir, `clip_${sc.idx}.mp4`);
      const fps = 25;
      const frames = Math.max(50, Math.round(sc.durationSec * fps));

      const vfParts: string[] = sc.aiVideoPath
        ? [
            `scale=${width}:${height}:force_original_aspect_ratio=increase`,
            `crop=${width}:${height}`,
            `fps=${fps}`,
            `format=yuv420p`,
          ]
        : (() => {
            const zoomExpr =
              sc.idx % 3 === 0
                ? `min(zoom+0.0012,1.18)`
                : sc.idx % 3 === 1
                  ? `1.14`
                  : `max(1.02,1.18-0.0012*on)`;
            const xExpr =
              sc.idx % 3 === 1
                ? `(iw-iw/zoom)*on/${frames}`
                : `iw/2-(iw/zoom/2)`;
            const yExpr = `ih/2-(ih/zoom/2)`;
            return [
              `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase`,
              `crop=${width * 2}:${height * 2}`,
              `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=${frames}:s=${width}x${height}:fps=${fps}`,
              `format=yuv420p`,
            ];
          })();

      if (sc.overlayText) {
        const wrapped = wrapTextForOverlay(sc.overlayText, aspectRatio === '9:16' ? 24 : 40);
        const textFile = path.join(tmpDir, `txt_${sc.idx}.txt`);
        await fs.writeFile(textFile, wrapped, 'utf-8');
        const hasBn = /[\u0980-\u09FF]/.test(wrapped);
        const fontFile = hasBn ? FONT_BENGALI : FONT_LATIN;
        const fontSize = aspectRatio === '9:16' ? 34 : 38;
        vfParts.push(
          `drawbox=x=0:y=ih*0.77:w=iw:h=ih*0.23:color=black@0.56:t=fill`,
          `drawtext=fontfile='${fontFile}':textfile='${textFile}':fontsize=${fontSize}:fontcolor=white:borderw=2:bordercolor=black@0.75:x=(w-text_w)/2:y=h*0.885-(text_h/2)`
        );
      }

      const vfFilter = vfParts.join(',');
      const musicExpr = getMoodAudioExpr(audioMood, sc.idx);

      const ffArgs: string[] = sc.aiVideoPath
        ? ['-y', '-stream_loop', '-1', '-i', sc.aiVideoPath]
        : ['-y', '-loop', '1', '-i', sc.imgPath!];

      let filterComplex = `[0:v]${vfFilter}[v]`;
      if (sc.ttsWav && audioMood !== 'none') {
        ffArgs.push('-i', sc.ttsWav);
        ffArgs.push('-f', 'lavfi', '-t', String(sc.durationSec), '-i', `aevalsrc=${musicExpr}:s=44100:c=stereo`);
        filterComplex += `;[1:a]apad=whole_dur=${sc.durationSec},volume=1.35[vo];[2:a]afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0.2, sc.durationSec - 0.35)}:d=0.35[bgm];[vo][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]`;
      } else if (sc.ttsWav) {
        ffArgs.push('-i', sc.ttsWav);
        filterComplex += `;[1:a]apad=whole_dur=${sc.durationSec},volume=1.35[a]`;
      } else if (audioMood !== 'none') {
        ffArgs.push('-f', 'lavfi', '-t', String(sc.durationSec), '-i', `aevalsrc=${musicExpr}:s=44100:c=stereo`);
        filterComplex += `;[1:a]afade=t=in:st=0:d=0.3,afade=t=out:st=${Math.max(0.2, sc.durationSec - 0.35)}:d=0.35,volume=1.6[a]`;
      } else {
        ffArgs.push('-f', 'lavfi', '-t', String(sc.durationSec), '-i', 'anullsrc=r=44100:cl=stereo');
        filterComplex += `;[1:a]anull[a]`;
      }

      ffArgs.push(
        '-filter_complex', filterComplex,
        '-map', '[v]',
        '-map', '[a]',
        '-t', String(sc.durationSec),
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ar', '44100',
        '-ac', '2',
        clipPath
      );

      await execFilePromise('ffmpeg', ffArgs, { timeout: 35000 });
      sceneMp4Paths.push(clipPath);
    }

    const concatListPath = path.join(tmpDir, 'concat.txt');
    await fs.writeFile(
      concatListPath,
      sceneMp4Paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf-8'
    );

    await execFilePromise('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      finalMp4Path,
    ], { timeout: 25000 });

    const totalDur = await probeMediaDuration(finalMp4Path);
    const sources = Array.from(new Set(preparedScenes.map((s) => s.visualSource))).join('+');
    const hasSpokenAudio = preparedScenes.some((s) => Boolean(s.ttsWav));
    const usedZeroGpu = preparedScenes.some((s) => s.visualSource.startsWith('zerogpu:'));

    return {
      success: true,
      videoUrl: `/generated/${finalFileName}`,
      durationSec: Math.round((totalDur || preparedScenes.reduce((s, x) => s + x.durationSec, 0)) * 10) / 10,
      resolution: `${width}x${height}`,
      aspectRatio,
      hasAudio: hasSpokenAudio || audioMood !== 'none',
      scenesCount: preparedScenes.length,
      provider: `${sources}${hasSpokenAudio ? '+tts' : ''}+ffmpeg`,
      description: `Generated playable MP4 video (${usedZeroGpu ? 'HuggingFace ZeroGPU AI motion + ' : 'Ken Burns motion + '}${hasSpokenAudio ? 'voiceover narration, ' : ''}${audioMood !== 'none' ? 'background music, ' : ''}on-screen text) at /generated/${finalFileName}`,
    };
  } catch (err: any) {
    console.error('[VideoGenerator] Failed:', err);
    return {
      success: false,
      error: err?.message || 'Video rendering failed',
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
