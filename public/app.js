'use strict';

const MAX_PROMPT_LENGTH = 1200;
const POLL_INTERVAL_MS = 2_500;
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

const THEME_COLORS = { dark: '#08090b', light: '#f4f5f1' };

const elements = {
  root: document.documentElement,
  themeToggle: document.getElementById('themeToggle'),
  connection: document.getElementById('connection'),
  connectionText: document.getElementById('connectionText'),
  promptForm: document.getElementById('promptForm'),
  prompt: document.getElementById('prompt'),
  creationType: document.querySelectorAll('input[name="creationType"]'),
  charCount: document.getElementById('charCount'),
  clearPrompt: document.getElementById('clearPrompt'),
  generateButton: document.getElementById('generateButton'),
  language: document.getElementById('language'),
  subtitles: document.getElementById('subtitles'),
  subtitleState: document.getElementById('subtitleState'),
  renderPanel: document.getElementById('renderPanel'),
  renderEyebrow: document.getElementById('renderEyebrow'),
  renderTitle: document.getElementById('renderTitle'),
  statusTag: document.getElementById('statusTag'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  renderMessage: document.getElementById('renderMessage'),
  errorMessage: document.getElementById('errorMessage'),
  errorDetail: document.getElementById('errorDetail'),
  result: document.getElementById('result'),
  videoPlayer: document.getElementById('videoPlayer'),
  videoFrame: document.getElementById('videoFrame'),
  downloadButton: document.getElementById('downloadButton'),
  taskIdLabel: document.getElementById('taskIdLabel'),
  copyTask: document.getElementById('copyTask'),
  imageResult: document.getElementById('imageResult'),
  resultEyebrow: document.getElementById('resultEyebrow'),
  resultTitle: document.getElementById('resultTitle'),
  downloadLabel: document.getElementById('downloadLabel'),
  imageStyle: document.getElementById('imageStyle'),
  imageLighting: document.getElementById('imageLighting'),
  imageDetail: document.querySelectorAll('input[name="imageDetail"]'),
  wallpaperModel: document.getElementById('wallpaperModel'),
  formNote: document.getElementById('formNote')
};

let activeTaskId = '';
let pollTimeoutId = null;

/* ---------- theme ---------- */

function getPreferredTheme() {
  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem('promptforge-theme');
  } catch {
    /* storage unavailable, fall through to system preference */
  }

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function applyTheme(theme) {
  elements.root.dataset.theme = theme;
  try {
    localStorage.setItem('promptforge-theme', theme);
  } catch {
    /* ignore */
  }

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  elements.themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', THEME_COLORS[theme]);
}

function initTheme() {
  applyTheme(getPreferredTheme());

  elements.themeToggle.addEventListener('click', () => {
    const nextTheme = elements.root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });
}

/* ---------- engine connection ---------- */

function setConnection(state) {
  elements.connection.dataset.state = state;

  const labels = {
    checking: 'Checking engine…',
    connected: 'Engine connected',
    offline: 'Engine offline'
  };

  elements.connectionText.textContent = labels[state];
}

async function checkConnection() {
  setConnection('checking');

  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const data = await response.json();
    setConnection(data.connected ? 'connected' : 'offline');
  } catch {
    setConnection('offline');
  }
}

/* ---------- prompt ---------- */

function updateCharacterCount() {
  elements.charCount.textContent = `${elements.prompt.value.length} / ${MAX_PROMPT_LENGTH}`;
}

function addPromptStarter(starter) {
  const current = elements.prompt.value.trim();
  elements.prompt.value = current
    ? `${current}${current.endsWith('.') ? ' ' : '. '}${starter} `
    : `${starter} `;

  elements.prompt.focus();
  elements.prompt.setSelectionRange(
    elements.prompt.value.length,
    elements.prompt.value.length
  );
  updateCharacterCount();
}

function selectedAspect() {
  return document.querySelector('input[name="aspect"]:checked')?.value || '9:16';
}

function selectedCreationType() {
  return document.querySelector('input[name="creationType"]:checked')?.value || 'video';
}

function selectedImageDetail() {
  return document.querySelector('input[name="imageDetail"]:checked')?.value || 'standard';
}

function isImageType(type = selectedCreationType()) {
  return type === 'image' || type === 'wallpaper';
}

/* ---------- mode-aware controls ---------- */

const MODE_COPY = {
  video: {
    button: 'Generate video',
    note: 'One brief, one finished video.<br /><span>Narration and subtitles are added for you.</span>'
  },
  image: {
    button: 'Generate image',
    note: 'One brief, one finished image.<br /><span>Pick a format, style and lighting.</span>'
  },
  wallpaper: {
    button: 'Generate 4K wallpaper',
    note: 'Desktop-ready output.<br /><span>Native 16:9 composition, delivered at 3840 × 2160.</span>'
  }
};

function setHidden(selector, hidden) {
  document.querySelectorAll(selector).forEach((node) => {
    node.hidden = hidden;
  });
}

function updateCreationUI() {
  const type = selectedCreationType();
  const isWallpaper = type === 'wallpaper';
  const isImage = isImageType(type);
  const copy = MODE_COPY[type] || MODE_COPY.video;

  elements.generateButton.querySelector('span:nth-child(2)').textContent = copy.button;
  elements.formNote.innerHTML = copy.note;

  // Video-only
  setHidden('.language-group', isImage);
  setHidden('.subtitles-group', isImage);

  // Image + wallpaper
  setHidden('.image-style-group', !isImage);
  setHidden('.image-lighting-group', !isImage);

  // Image only (wallpaper is always "ultra" detail and always 16:9,
  // so those controls would be redundant there)
  setHidden('.option-group--format', isWallpaper);
  setHidden('.image-detail-group', type !== 'image');

  // Wallpaper only
  setHidden('.wallpaper-option', !isWallpaper);

  // If a row would end with a single orphan control on tablet, let it span the row.
  const visible = [
    ...document.querySelectorAll('.options > .option-group:not(.option-group--mode):not([hidden])')
  ];
  visible.forEach((node) => node.classList.remove('is-wide'));
  if (visible.length % 2 === 1) visible[visible.length - 1].classList.add('is-wide');
}

/* ---------- requests ---------- */

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  });

  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    let message = 'The request could not be completed.';

    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => ({}));
      message = data.error || message;
    }

    throw new Error(message);
  }

  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response;
}

/* ---------- render panel ---------- */

function statusMessage(status, progress) {
  if (status === 'QUEUED') return 'Sending your brief to the engine…';

  if (progress !== null && progress < 15) return 'Writing the story…';
  if (progress !== null && progress < 40) return 'Finding visual material…';
  if (progress !== null && progress < 58) return 'Generating narration…';
  if (progress !== null && progress < 74) return 'Adding subtitles…';
  if (progress !== null && progress < 94) return 'Rendering your film…';

  return 'Almost there…';
}

function setProgress(progress) {
  if (progress === null || progress === undefined) {
    elements.progressFill.classList.add('is-indeterminate');
    elements.progressFill.style.width = '';
    elements.progressLabel.textContent = 'In progress';
    return;
  }

  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = `${progress}%`;
  elements.progressLabel.textContent = `${progress}%`;
}

function setStatus(status, progress) {
  elements.statusTag.textContent = status;
  elements.statusTag.dataset.state = status;
  elements.renderMessage.textContent = statusMessage(status, progress);
  setProgress(progress);
}

function showError(message) {
  clearTimeout(pollTimeoutId);
  elements.statusTag.textContent = 'ERROR';
  elements.statusTag.dataset.state = 'ERROR';
  elements.renderTitle.textContent = 'The render hit a pause.';
  elements.renderEyebrow.textContent = 'Generation stopped';
  elements.renderMessage.textContent = 'The engine could not finish this render.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '0%';
  elements.progressLabel.textContent = '';
  elements.errorDetail.textContent = message;
  elements.errorMessage.hidden = false;
  elements.generateButton.disabled = false;
}

function showImageComplete() {
  const isWallpaper = selectedCreationType() === 'wallpaper';

  elements.statusTag.textContent = 'COMPLETE';
  elements.statusTag.dataset.state = 'COMPLETE';
  elements.renderTitle.textContent = isWallpaper
    ? 'Your 4K wallpaper is ready.'
    : 'Your image is ready.';
  elements.renderEyebrow.textContent = isWallpaper ? '4K wallpaper complete' : 'Image complete';
  elements.renderMessage.textContent = isWallpaper
    ? '3840 × 2160 desktop wallpaper ready to download.'
    : 'Your image is ready.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '100%';
  elements.progressLabel.textContent = '100%';
  elements.result.hidden = false;
  elements.videoPlayer.hidden = true;
  elements.imageResult.hidden = false;
  elements.copyTask.hidden = true; // there is no task ID for images
  elements.resultEyebrow.textContent = isWallpaper ? 'Your 4K wallpaper' : 'Your image';
  elements.resultTitle.textContent = isWallpaper ? 'Ready for your desktop.' : 'Ready to view.';
  elements.downloadLabel.textContent = isWallpaper ? '4K JPG' : 'Image';
  elements.downloadButton.href = elements.imageResult.src;
  elements.downloadButton.setAttribute(
    'download',
    isWallpaper ? 'promptforge-4k-wallpaper.jpg' : 'promptforge-image.jpg'
  );
  elements.taskIdLabel.textContent = isWallpaper
    ? 'Wallpaper · 3840 × 2160'
    : 'Generated image';
  elements.generateButton.disabled = false;
}

function showComplete(taskId) {
  elements.videoPlayer.hidden = false;
  elements.imageResult.hidden = true;
  elements.copyTask.hidden = false;
  elements.resultEyebrow.textContent = 'Your video';
  elements.resultTitle.textContent = 'Ready to play.';
  elements.downloadLabel.textContent = 'MP4';
  elements.statusTag.textContent = 'COMPLETE';
  elements.statusTag.dataset.state = 'COMPLETE';
  elements.renderTitle.textContent = 'Your film is ready.';
  elements.renderEyebrow.textContent = 'Generation complete';
  elements.renderMessage.textContent = 'Your film is ready.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '100%';
  elements.progressLabel.textContent = '100%';
  elements.taskIdLabel.textContent = `Task ${taskId}`;
  elements.result.hidden = false;
  elements.generateButton.disabled = false;

  const videoUrl = `/api/tasks/${encodeURIComponent(taskId)}/video`;
  elements.videoPlayer.src = videoUrl;
  elements.downloadButton.href = videoUrl;
  elements.downloadButton.setAttribute('download', `promptforge-${taskId}.mp4`);
}

async function pollTask(taskId, startedAt) {
  if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) {
    showError('This generation timed out. Check the engine status and try again.');
    return;
  }

  try {
    const task = await apiRequest(`/api/tasks/${encodeURIComponent(taskId)}`, {
      cache: 'no-store'
    });

    const progress = typeof task.progress === 'number' ? task.progress : null;
    setStatus(task.status, progress);

    if (task.status === 'ERROR') {
      showError(
        task.error ||
        'MoneyPrinterTurbo could not complete this generation. Check the engine console and your configured providers.'
      );
      return;
    }

    if (task.status === 'COMPLETE') {
      showComplete(taskId);
      return;
    }

    pollTimeoutId = window.setTimeout(
      () => pollTask(taskId, startedAt),
      POLL_INTERVAL_MS
    );
  } catch (error) {
    pollTimeoutId = window.setTimeout(() => {
      if (Date.now() - startedAt > GENERATION_TIMEOUT_MS) {
        showError('The connection timed out while checking this task.');
        return;
      }

      pollTask(taskId, startedAt);
    }, POLL_INTERVAL_MS);

    elements.renderMessage.textContent = error.message ||
      'Connection interrupted. Reconnecting to the engine…';
  }
}

async function generateImage() {
  const isWallpaper = selectedCreationType() === 'wallpaper';

  elements.statusTag.textContent = 'PROCESSING';
  elements.statusTag.dataset.state = 'PROCESSING';
  elements.renderEyebrow.textContent = isWallpaper ? '4K wallpaper' : 'Image generation';
  elements.renderTitle.textContent = isWallpaper
    ? 'Creating your desktop wallpaper'
    : 'Creating your image';
  elements.renderMessage.textContent = isWallpaper
    ? 'Generating a detailed 3840 × 2160 desktop image…'
    : 'Sending your prompt to the image engine…';

  const response = await apiRequest('/api/generate-image', {
    method: 'POST',
    body: JSON.stringify({
      prompt: elements.prompt.value.trim(),
      aspect: isWallpaper ? '16:9' : selectedAspect(),
      style: elements.imageStyle.value,
      lighting: elements.imageLighting.value,
      detail: isWallpaper ? 'ultra' : selectedImageDetail(),
      wallpaper: isWallpaper,
      wallpaperModel: isWallpaper ? elements.wallpaperModel.value : undefined
    })
  });

  const blob = await response.blob();
  elements.imageResult.src = URL.createObjectURL(blob);
  showImageComplete();
}

async function generateVideo(event) {
  event?.preventDefault();

  if (elements.generateButton.disabled) return;

  const prompt = elements.prompt.value.trim();

  if (!prompt) {
    elements.prompt.focus();
    elements.prompt.setCustomValidity('Write a brief before generating.');
    elements.prompt.reportValidity();
    return;
  }

  elements.prompt.setCustomValidity('');

  if (prompt.length > MAX_PROMPT_LENGTH) {
    showError(`Your brief must be ${MAX_PROMPT_LENGTH} characters or fewer.`);
    return;
  }

  clearTimeout(pollTimeoutId);
  activeTaskId = '';
  elements.generateButton.disabled = true;
  elements.renderPanel.hidden = false;
  elements.errorMessage.hidden = true;
  elements.result.hidden = true;
  elements.videoPlayer.removeAttribute('src');
  elements.videoPlayer.load();
  if (elements.imageResult.src.startsWith('blob:')) {
    URL.revokeObjectURL(elements.imageResult.src);
  }
  elements.imageResult.removeAttribute('src');
  elements.renderEyebrow.textContent = 'Generating';
  elements.renderTitle.textContent = 'Building your film';
  elements.statusTag.dataset.state = 'QUEUED';
  elements.statusTag.textContent = 'QUEUED';
  elements.renderMessage.textContent = 'Sending your brief to the engine…';
  elements.progressFill.classList.add('is-indeterminate');
  elements.progressFill.style.width = '';
  elements.progressLabel.textContent = 'In progress';
  elements.renderPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    if (selectedCreationType() === 'image') {
      await generateImage();
      return;
    }

    const response = await apiRequest('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        aspect: selectedAspect(),
        language: elements.language.value,
        subtitleEnabled: elements.subtitles.checked
      })
    });

    if (!response.taskId) {
      throw new Error('MoneyPrinterTurbo did not return a task ID.');
    }

    activeTaskId = response.taskId;
    elements.taskIdLabel.textContent = `Task ${activeTaskId}`;
    await pollTask(activeTaskId, Date.now());
  } catch (error) {
    showError(error.message);
  }
}

/* ---------- wiring ---------- */

function initPromptControls() {
  elements.prompt.addEventListener('input', updateCharacterCount);

  elements.clearPrompt.addEventListener('click', () => {
    elements.prompt.value = '';
    updateCharacterCount();
    elements.prompt.focus();
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => addPromptStarter(chip.dataset.prompt));
  });

  elements.creationType.forEach((input) => {
    input.addEventListener('change', updateCreationUI);
  });

  elements.subtitles.addEventListener('change', () => {
    elements.subtitleState.textContent = elements.subtitles.checked ? 'On' : 'Off';
  });

  elements.promptForm.addEventListener('submit', generateVideo);

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      generateVideo();
    }
  });
}

function initResultControls() {
  elements.copyTask.addEventListener('click', async () => {
    if (!activeTaskId) return;

    try {
      await navigator.clipboard.writeText(activeTaskId);
      elements.copyTask.textContent = 'Copied ✓';
      window.setTimeout(() => {
        elements.copyTask.textContent = 'Copy task ID';
      }, 1600);
    } catch {
      elements.copyTask.textContent = activeTaskId;
    }
  });

  elements.videoPlayer.addEventListener('error', () => {
    if (!elements.videoPlayer.getAttribute('src')) return; // ignore the reset between runs
    showError('The video was generated, but the browser could not load the finished MP4.');
  });

  elements.imageResult.addEventListener('error', () => {
    if (!elements.imageResult.getAttribute('src')) return;
    showError('The image was generated, but the browser could not display the result.');
  });
  // The old loadedmetadata aspect-ratio handler is gone: CSS now contains the
  // media inside the stage and keeps its natural ratio.
}

initTheme();
initPromptControls();
initResultControls();
updateCreationUI();
updateCharacterCount();
checkConnection();
window.setInterval(checkConnection, 15_000);