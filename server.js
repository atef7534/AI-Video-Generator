'use strict';

require('dotenv').config();

const express = require('express');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MPT_API_URL = (process.env.MPT_API_URL || 'http://127.0.0.1:8080')
  .replace(/\/+$/, '');
const MPT_API_KEY = process.env.MPT_API_KEY || '';
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '';
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;

const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROMPT_LENGTH = 1200;

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function mptHeaders(extra = {}) {
  const headers = { ...extra };

  if (MPT_API_KEY) {
    headers['x-api-key'] = MPT_API_KEY;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('The upstream AI service did not respond in time.');
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error('MoneyPrinterTurbo returned an invalid response.');
    error.status = 502;
    throw error;
  }
}

function getApiErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback;

  return (
    payload.detail ||
    payload.message ||
    payload.error ||
    payload.msg ||
    fallback
  );
}

function getTaskId(payload) {
  if (!payload || typeof payload !== 'object') return '';

  return String(
    payload.task_id ||
    payload.taskId ||
    payload.data?.task_id ||
    payload.data?.taskId ||
    ''
  );
}

function getTaskObject(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return payload.data && typeof payload.data === 'object'
    ? { ...payload, ...payload.data }
    : payload;
}

function normalizeStatus(rawStatus) {
  const status = String(rawStatus ?? '').trim().toLowerCase();

  // MoneyPrinterTurbo v1.3.7 uses numeric task states:
  // -1 = failed, 1 = complete, 4 = processing.
  if (status === '-1') return 'ERROR';
  if (status === '1') return 'COMPLETE';
  if (status === '4') return 'PROCESSING';

  if (['queued', 'pending', 'waiting', 'scheduled'].includes(status)) {
    return 'QUEUED';
  }

  if (
    ['processing', 'running', 'in_progress', 'in progress', 'started'].includes(status)
  ) {
    return 'PROCESSING';
  }

  if (
    ['success', 'successful', 'completed', 'complete', 'finished', 'done'].includes(status)
  ) {
    return 'COMPLETE';
  }

  if (
    ['failed', 'failure', 'error', 'cancelled', 'canceled'].includes(status)
  ) {
    return 'ERROR';
  }

  return status ? status.toUpperCase() : 'PROCESSING';
}

function getProgress(task) {
  const possibleValues = [
    task.progress,
    task.percentage,
    task.percent,
    task.progress_percent,
    task.progressPercentage
  ];

  const value = possibleValues.find(
    (item) => typeof item === 'number' && Number.isFinite(item)
  );

  if (value === undefined) return null;

  return Math.max(0, Math.min(100, Math.round(value)));
}

function getTaskError(task) {
  return String(
    task.error ||
    task.error_message ||
    task.message ||
    task.failed_reason ||
    ''
  );
}

function findVideoReference(value, depth = 0) {
  if (!value || depth > 6) return '';

  if (typeof value === 'string') {
    const candidate = value.trim();

    if (
      /\.(mp4|m4v|mov)(?:$|[?#])/i.test(candidate) ||
      candidate.startsWith('/api/') ||
      candidate.startsWith('/static/') ||
      candidate.startsWith('/videos/') ||
      candidate.startsWith('/tasks/')
    ) {
      return candidate;
    }

    return '';
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoReference(item, depth + 1);
      if (found) return found;
    }
    return '';
  }

  if (typeof value === 'object') {
    const preferredKeys = [
      'video_url',
      'video_path',
      'file_url',
      'file_path',
      'download_url',
      'output_path',
      'url',
      'path',
      'videos',
      'video',
      'result',
      'data'
    ];

    for (const key of preferredKeys) {
      if (key in value) {
        const found = findVideoReference(value[key], depth + 1);
        if (found) return found;
      }
    }
  }

  return '';
}

function getSafeMptVideoUrl(videoReference) {
  if (typeof videoReference !== 'string' || !videoReference.trim()) {
    const error = new Error('The completed task did not include a video path.');
    error.status = 404;
    throw error;
  }

  let parsed;

  try {
    parsed = new URL(videoReference, `${MPT_API_URL}/`);
  } catch {
    const error = new Error('MoneyPrinterTurbo returned an invalid video path.');
    error.status = 502;
    throw error;
  }

  const base = new URL(`${MPT_API_URL}/`);

  if (parsed.origin !== base.origin) {
    const error = new Error('The returned video is outside the configured engine.');
    error.status = 502;
    throw error;
  }

  let decodedPath;

  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    const error = new Error('MoneyPrinterTurbo returned an invalid video path.');
    error.status = 502;
    throw error;
  }

  if (
    decodedPath.includes('\0') ||
    decodedPath.split('/').some((part) => part === '..') ||
    !/^\/(?:api\/|static\/|videos\/|tasks\/)/.test(decodedPath)
  ) {
    const error = new Error('The returned video path is not an allowed media route.');
    error.status = 502;
    throw error;
  }

  return parsed;
}

function sendSafeError(res, error, fallbackMessage) {
  const status = Number(error.status) || 502;
  console.error(`[promptforge] ${fallbackMessage} (HTTP ${status}): ${error.message}`);

  if (status === 401 || status === 403) {
    return res.status(status).json({
      error: error.message || 'The configured AI provider rejected the request.'
    });
  }

  if (status === 404) {
    return res.status(status).json({
      error: error.message || fallbackMessage
    });
  }

  if (status === 504) {
    return res.status(status).json({ error: error.message });
  }

  return res.status(status).json({
    error: status >= 500
      ? (error.message || fallbackMessage)
      : fallbackMessage
  });
}

app.get('/api/health', async (_req, res) => {
  // MoneyPrinterTurbo v1.3.7 exposes its health check at /ping.
  const healthPaths = ['/ping'];

  for (const healthPath of healthPaths) {
    try {
      const response = await fetchWithTimeout(
        `${MPT_API_URL}${healthPath}`,
        { headers: mptHeaders() },
        4_000
      );

      if (response.ok) {
        return res.json({ connected: true });
      }
    } catch {
      // Try the next supported health endpoint.
    }
  }

  return res.json({ connected: false });
});

app.post('/api/generate', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string'
    ? req.body.prompt.trim()
    : '';

  if (!prompt) {
    return res.status(400).json({ error: 'Write a brief before generating.' });
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({
      error: `Your brief must be ${MAX_PROMPT_LENGTH} characters or fewer.`
    });
  }

  const allowedAspects = new Set(['9:16', '16:9', '1:1']);
  const allowedLanguages = new Set(['', 'en', 'ar', 'es', 'fr']);

  const aspect = allowedAspects.has(req.body.aspect)
    ? req.body.aspect
    : '9:16';

  const language = allowedLanguages.has(req.body.language)
    ? req.body.language
    : '';

  const payload = {
    video_subject: prompt,
    video_script: '',
    video_aspect: aspect,
    video_fit_mode: 'cover',
    video_concat_mode: 'random',
    video_clip_duration: 5,
    video_clip_speed: 1,
    video_count: 1,
    video_source: 'pixabay',
    video_language: language,
    voice_name: 'en-AU-NatashaNeural',
    voice_volume: 1,
    voice_rate: 1,
    bgm_type: 'random',
    bgm_volume: 0.2,
    subtitle_enabled: Boolean(req.body.subtitleEnabled),
    subtitle_position: 'bottom',
    subtitle_display_mode: 'sentence',
    subtitle_animation: 'none'
  };

  try {
    const response = await fetchWithTimeout(
      `${MPT_API_URL}/api/v1/videos`,
      {
        method: 'POST',
        headers: mptHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload)
      },
      30_000
    );

    const body = await readJson(response);

    if (!response.ok) {
      const error = new Error(
        getApiErrorMessage(body, 'MoneyPrinterTurbo could not accept this generation.')
      );
      error.status = response.status;
      throw error;
    }

    const taskId = getTaskId(body);

    if (!taskId) {
      const error = new Error('MoneyPrinterTurbo did not return a task ID.');
      error.status = 502;
      throw error;
    }

    return res.status(202).json({ taskId });
  } catch (error) {
    return sendSafeError(
      res,
      error,
      'MoneyPrinterTurbo is unavailable or returned an invalid response.'
    );
  }
});

app.get('/api/tasks/:taskId', async (req, res) => {
  const taskId = req.params.taskId;

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
    return res.status(400).json({ error: 'Invalid task ID.' });
  }

  try {
    const response = await fetchWithTimeout(
      `${MPT_API_URL}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: mptHeaders() }
    );

    const body = await readJson(response);

    if (!response.ok) {
      const error = new Error(
        getApiErrorMessage(body, 'Could not read the generation task.')
      );
      error.status = response.status;
      throw error;
    }

    const task = getTaskObject(body);
    const status = normalizeStatus(task.status || task.state);
    const videoReference = findVideoReference(task);
    const progress = getProgress(task);

    return res.json({
      taskId,
      status,
      progress,
      error: getTaskError(task),
      videoAvailable: Boolean(videoReference)
    });
  } catch (error) {
    return sendSafeError(
      res,
      error,
      'Could not read the generation task from MoneyPrinterTurbo.'
    );
  }
});


app.post('/api/generate-image', async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!prompt) {
    return res.status(400).json({ error: 'Write a brief before generating an image.' });
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return res.status(400).json({
      error: \`Your brief must be \${MAX_PROMPT_LENGTH} characters or fewer.\`
    });
  }

  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    return res.status(503).json({
      error: 'Image generation is not configured. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to your .env file.'
    });
  }

  const allowedAspects = new Set(['9:16', '16:9', '1:1']);
  const allowedStyles = new Set(['photorealistic', 'cinematic', 'illustration', 'minimal', '3d']);
  const allowedLighting = new Set(['natural', 'golden-hour', 'soft', 'moody', 'dramatic']);
  const allowedDetails = new Set(['standard', 'high', 'ultra']);

  const isWallpaper = Boolean(req.body.wallpaper);
  const aspect = isWallpaper
    ? '16:9'
    : (allowedAspects.has(req.body.aspect) ? req.body.aspect : '9:16');
  const style = allowedStyles.has(req.body.style) ? req.body.style : 'photorealistic';
  const lighting = allowedLighting.has(req.body.lighting) ? req.body.lighting : 'natural';
  const detail = isWallpaper
    ? 'ultra'
    : (allowedDetails.has(req.body.detail) ? req.body.detail : 'standard');

  const stylePrompts = {
    photorealistic: 'photorealistic professional photography, realistic textures and natural imperfections',
    cinematic: 'cinematic photography, film-like composition, atmospheric depth and subtle color grading',
    illustration: 'high-quality digital illustration with clean shapes and expressive visual detail',
    minimal: 'minimalist visual style, clean composition, simple forms and generous negative space',
    '3d': 'high-quality 3D render with realistic materials, lighting and depth'
  };

  const lightingPrompts = {
    natural: 'natural daylight and realistic shadows',
    'golden-hour': 'warm golden-hour sunlight and soft long shadows',
    soft: 'soft bright diffused lighting with gentle shadows',
    moody: 'moody low-key lighting with subtle contrast',
    dramatic: 'dramatic directional lighting with strong but realistic contrast'
  };

  const detailPrompt = detail === 'ultra'
    ? 'ultra-high-detail desktop wallpaper, extremely crisp micro-textures, fine environmental detail, realistic material surfaces, precise edges, rich but natural tonal range, high dynamic range, physically plausible lighting, atmospheric depth, professional large-format photography, optimized for close inspection on a 4K display'
    : detail === 'high'
      ? 'highly detailed, crisp textures and fine environmental details'
      : 'balanced detail with a natural photographic feel';

  const wallpaperPrompt = isWallpaper
    ? 'desktop wallpaper composition, 16:9 landscape, intentional negative space where desktop icons can sit, no text, no typography, no logos, no watermark, no UI, no borders, no people unless explicitly requested, full-frame composition, visually balanced from edge to edge'
    : '';

  const imagePrompt = [
    prompt,
    stylePrompts[style],
    lightingPrompts[lighting],
    detailPrompt,
    wallpaperPrompt
  ].filter(Boolean).join('. ');

  // FLUX.1 Schnell currently accepts prompt and steps. The generated source
  // is normalized locally with Sharp to the dimensions used by PromptForge.
  const sizes = {
    '9:16': [768, 1360],
    '16:9': [1360, 768],
    '1:1': [1024, 1024]
  };

  const [width, height] = sizes[aspect];

  async function requestImage() {
    const imageUrl =
      \`https://api.cloudflare.com/client/v4/accounts/\${encodeURIComponent(CLOUDFLARE_ACCOUNT_ID)}/ai/run/\${encodeURIComponent(CLOUDFLARE_IMAGE_MODEL)}\`;

    const response = await fetchWithTimeout(
      imageUrl,
      {
        method: 'POST',
        headers: {
          Authorization: \`Bearer \${CLOUDFLARE_API_TOKEN}\`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          prompt: imagePrompt,
          steps: 4
        })
      },
      isWallpaper ? 180_000 : 120_000
    );

    const responseText = await response.text();
    let providerBody = {};

    try {
      providerBody = responseText ? JSON.parse(responseText) : {};
    } catch {
      providerBody = {};
    }

    if (!response.ok || providerBody.success === false) {
      const providerError = Array.isArray(providerBody.errors)
        ? providerBody.errors
            .map((item) => item?.message || item?.code || '')
            .filter(Boolean)
            .join('; ')
        : '';

      let readableMessage =
        providerError ||
        providerBody?.error?.message ||
        providerBody?.error ||
        providerBody?.message ||
        responseText.trim();

      if (typeof readableMessage !== 'string' || !readableMessage) {
        readableMessage = \`Cloudflare Workers AI image generation failed with HTTP \${response.status}.\`;
      }

      const error = new Error(readableMessage);
      error.status = response.status >= 500 ? 502 : response.status;
      throw error;
    }

    let imageBase64 = providerBody?.result?.image;

    if (!imageBase64 && typeof providerBody?.result === 'string') {
      imageBase64 = providerBody.result;
    }

    if (typeof imageBase64 !== 'string' || !imageBase64) {
      const error = new Error('Cloudflare Workers AI returned no generated image.');
      error.status = 502;
      throw error;
    }

    imageBase64 = imageBase64.replace(/^data:image\/[^;]+;base64,/, '');

    const input = Buffer.from(imageBase64, 'base64');

    if (!input.length) {
      const error = new Error('Cloudflare Workers AI returned an empty image.');
      error.status = 502;
      throw error;
    }

    if (input.length > MAX_IMAGE_BYTES) {
      const error = new Error('The generated image is too large to process safely.');
      error.status = 502;
      throw error;
    }

    return input;
  }

  try {
    const input = await requestImage();
    const sharp = require('sharp');

    const outputWidth = isWallpaper ? 3840 : width;
    const outputHeight = isWallpaper ? 2160 : height;

    const output = await sharp(input)
      .resize(outputWidth, outputHeight, {
        fit: 'cover',
        position: 'centre',
        kernel: sharp.kernel.lanczos3
      })
      .sharpen({
        sigma: isWallpaper ? 1.05 : 0.8,
        m1: 0.7,
        m2: 2
      })
      .jpeg({
        quality: isWallpaper ? 95 : 92,
        chromaSubsampling: '4:4:4',
        mozjpeg: true
      })
      .toBuffer();

    res.setHeader('content-type', 'image/jpeg');
    res.setHeader(
      'content-disposition',
      \`inline; filename="\${isWallpaper ? 'promptforge-4k-wallpaper.jpg' : 'promptforge-image.jpg'}"\`
    );
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('content-length', output.length);

    if (isWallpaper) {
      res.setHeader('x-promptforge-resolution', '3840x2160');
    }

    return res.end(output);
  } catch (error) {
    if (!res.headersSent) {
      return sendSafeError(res, error, 'Could not generate the image with Cloudflare Workers AI.');
    }
  }
});

app.get('/api/tasks/:taskId/video', async (req, res) => {
  const taskId = req.params.taskId;

  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) {
    return res.status(400).json({ error: 'Invalid task ID.' });
  }

  try {
    const taskResponse = await fetchWithTimeout(
      `${MPT_API_URL}/api/v1/tasks/${encodeURIComponent(taskId)}`,
      { headers: mptHeaders() }
    );
    const taskBody = await readJson(taskResponse);

    if (!taskResponse.ok) {
      const error = new Error(
        getApiErrorMessage(taskBody, 'Could not retrieve the completed task.')
      );
      error.status = taskResponse.status;
      throw error;
    }

    const task = getTaskObject(taskBody);
    const taskStatus = normalizeStatus(task.status || task.state);

    if (taskStatus !== 'COMPLETE') {
      const error = new Error(
        taskStatus === 'ERROR'
          ? (getTaskError(task) || 'The generation task failed.')
          : 'The video is not ready yet.'
      );
      error.status = taskStatus === 'ERROR' ? 409 : 409;
      throw error;
    }

    // MoneyPrinterTurbo v1.3.7 may finish without exposing the output path in
    // the task JSON. Fall back to its deterministic final MP4 location.
    const videoReference = findVideoReference(task) ||
      `/api/v1/download/tasks/${encodeURIComponent(taskId)}/final-1.mp4`;
    const videoUrl = getSafeMptVideoUrl(videoReference);

    const videoResponse = await fetchWithTimeout(
      videoUrl,
      { headers: mptHeaders() },
      60_000
    );

    if (!videoResponse.ok) {
      const error = new Error(
        videoResponse.status === 404
          ? 'The finished video file is missing from the engine.'
          : 'MoneyPrinterTurbo could not return the finished video.'
      );
      error.status = videoResponse.status;
      throw error;
    }

    const contentType = videoResponse.headers.get('content-type') || '';
    const contentLength = videoResponse.headers.get('content-length');

    if (!contentType.toLowerCase().includes('video/') &&
        !/\.mp4(?:$|[?#])/i.test(videoUrl.pathname)) {
      const error = new Error('MoneyPrinterTurbo returned a non-video file.');
      error.status = 502;
      throw error;
    }

    res.setHeader('content-type', contentType || 'video/mp4');
    res.setHeader(
      'content-disposition',
      `inline; filename="promptforge-${taskId}.mp4"`
    );
    res.setHeader('cache-control', 'private, no-store');

    if (contentLength) {
      res.setHeader('content-length', contentLength);
    }

    if (videoResponse.body) {
      const { Readable } = require('node:stream');
      return Readable.fromWeb(videoResponse.body).pipe(res);
    }

    return res.status(502).json({ error: 'The video response was empty.' });
  } catch (error) {
    if (!res.headersSent) {
      return sendSafeError(
        res,
        error,
        'Could not retrieve the generated video.'
      );
    }
  }
});

app.use(express.static(PUBLIC_DIR));

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PromptForge is ready at http://localhost:${PORT}`);
});