'use strict';

const MAX_PROMPT_LENGTH = 1200;
const POLL_INTERVAL_MS = 2_500;
const GENERATION_TIMEOUT_MS = 30 * 60 * 1000;

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

function getPreferredTheme() {
  const savedTheme = localStorage.getItem('promptforge-theme');

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

function applyTheme(theme) {
  elements.root.dataset.theme = theme;
  localStorage.setItem('promptforge-theme', theme);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  elements.themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', theme === 'dark' ? '#10110f' : '#f3f2ec');
}

function initTheme() {
  applyTheme(getPreferredTheme());

  elements.themeToggle.addEventListener('click', () => {
    const nextTheme = elements.root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
  });
}

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

function updateCreationUI() {
  const type = selectedCreationType();
  const isImage = type === 'image' || type === 'wallpaper';
  const isWallpaper = type === 'wallpaper';
  const generateLabel = elements.generateButton.querySelector('span:nth-child(2)');

  generateLabel.textContent = isWallpaper
    ? 'Generate 4K wallpaper'
    : isImage
      ? 'Generate image'
      : 'Generate video';

  document.querySelector('.subtitles-group').hidden = isImage;
  document.querySelector('.language-group').hidden = isImage;
  document.querySelectorAll('.image-option').forEach((option) => {
    option.hidden = !isImage;
  });
  document.querySelectorAll('.wallpaper-option').forEach((option) => {
    option.hidden = !isWallpaper;
  });

  if (isWallpaper) {
    const landscape = document.querySelector('input[name="aspect"][value="16:9"]');
    if (landscape) landscape.checked = true;
  }

  elements.formNote.innerHTML = isWallpaper
    ? 'Desktop-ready output.<br /><span>Native 16:9 composition with a 3840 × 2160 final image.</span>'
    : 'One brief. One finished creation.<br /><span>No timeline required.</span>';
}

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
    elements.progressLabel.textContent = 'IN PROGRESS';
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
  elements.renderEyebrow.textContent = 'GENERATION STOPPED';
  elements.renderMessage.textContent = 'The engine could not finish this film.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '0%';
  elements.progressLabel.textContent = '';
  elements.errorDetail.textContent = message;
  elements.errorMessage.hidden = false;
  elements.generateButton.disabled = false;
}

function showImageComplete() {
  elements.statusTag.textContent = 'COMPLETE';
  elements.statusTag.dataset.state = 'COMPLETE';
  const isWallpaper = selectedCreationType() === 'wallpaper';
  elements.renderTitle.textContent = isWallpaper
    ? 'Your 4K wallpaper is ready.'
    : 'Your image is ready.';
  elements.renderEyebrow.textContent = isWallpaper ? '4K WALLPAPER COMPLETE' : 'IMAGE COMPLETE';
  elements.renderMessage.textContent = isWallpaper
    ? '3840 × 2160 desktop wallpaper ready to download.'
    : 'Your image is ready.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '100%';
  elements.progressLabel.textContent = '100%';
  elements.result.hidden = false;
  elements.videoPlayer.hidden = true;
  elements.imageResult.hidden = false;
  elements.resultEyebrow.textContent = isWallpaper ? 'YOUR 4K WALLPAPER' : 'YOUR IMAGE';
  elements.resultTitle.textContent = isWallpaper ? 'Ready for your desktop.' : 'Ready to view.';
  elements.downloadLabel.textContent = isWallpaper ? '4K JPG' : 'Image';
  elements.downloadButton.href = elements.imageResult.src;
  elements.downloadButton.setAttribute(
    'download',
    isWallpaper ? 'promptforge-4k-wallpaper.jpg' : 'promptforge-image.jpg'
  );
  elements.taskIdLabel.textContent = isWallpaper
    ? 'WALLPAPER / 3840 × 2160'
    : 'IMAGE / GENERATED';
  elements.generateButton.disabled = false;
}

function showComplete(taskId) {
  elements.videoPlayer.hidden = false;
  elements.imageResult.hidden = true;
  elements.resultEyebrow.textContent = 'YOUR VIDEO';
  elements.resultTitle.textContent = 'Ready to play.';
  elements.downloadLabel.textContent = 'MP4';
  elements.statusTag.textContent = 'COMPLETE';
  elements.statusTag.dataset.state = 'COMPLETE';
  elements.renderTitle.textContent = 'Your film is ready.';
  elements.renderEyebrow.textContent = 'GENERATION COMPLETE';
  elements.renderMessage.textContent = 'Your film is ready.';
  elements.progressFill.classList.remove('is-indeterminate');
  elements.progressFill.style.width = '100%';
  elements.progressLabel.textContent = '100%';
  elements.taskIdLabel.textContent = `TASK / ${taskId}`;
  elements.result.hidden = false;

  const videoUrl = `/api/tasks/${encodeURIComponent(taskId)}/video`;
  elements.videoPlayer.src = videoUrl;
  elements.downloadButton.href = videoUrl;
  elements.downloadButton.setAttribute('download', `promptforge-${taskId}.mp4`);
}

async function retrieveVideo(taskId) {
  try {
    const response = await fetch(
      `/api/tasks/${encodeURIComponent(taskId)}/video`,
      { cache: 'no-store' }
    );

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'The engine could not return the video file.');
    }

    return true;
  } catch (error) {
    showError(error.message);
    return false;
  }
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
  elements.renderEyebrow.textContent = isWallpaper ? '4K WALLPAPER' : 'IMAGE GENERATION';
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
  elements.renderEyebrow.textContent = 'GENERATION';
  elements.renderTitle.textContent = 'Building your film';
  elements.statusTag.dataset.state = 'QUEUED';
  elements.statusTag.textContent = 'QUEUED';
  elements.renderMessage.textContent = 'Sending your brief to the engine…';
  elements.progressFill.classList.add('is-indeterminate');
  elements.progressFill.style.width = '';
  elements.progressLabel.textContent = 'IN PROGRESS';
  elements.renderPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    if (selectedCreationType() === 'image') {
      await generateImage();
      elements.generateButton.disabled = false;
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
    elements.taskIdLabel.textContent = `TASK / ${activeTaskId}`;
    await pollTask(activeTaskId, Date.now());
  } catch (error) {
    showError(error.message);
  }
}

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
      elements.copyTask.innerHTML = '<span aria-hidden="true">✓</span> Copied';
      window.setTimeout(() => {
        elements.copyTask.innerHTML = '<span aria-hidden="true">▣</span> Copy task ID';
      }, 1600);
    } catch {
      elements.copyTask.textContent = activeTaskId;
    }
  });

  elements.videoPlayer.addEventListener('error', () => {
    showError('The video was generated, but the browser could not load the finished MP4.');
  });

  elements.imageResult.addEventListener('error', () => {
    showError('The image was generated, but the browser could not display the result.');
  });

  elements.videoPlayer.addEventListener('loadedmetadata', () => {
    const ratio = elements.videoPlayer.videoWidth / elements.videoPlayer.videoHeight;

    if (ratio < 0.78) {
      elements.videoFrame.style.aspectRatio = '9 / 16';
    } else if (ratio > 1.25) {
      elements.videoFrame.style.aspectRatio = '16 / 9';
    } else {
      elements.videoFrame.style.aspectRatio = '1 / 1';
    }
  });
}

initTheme();
initPromptControls();
initResultControls();
updateCreationUI();
updateCharacterCount();
checkConnection();
window.setInterval(checkConnection, 15_000);
