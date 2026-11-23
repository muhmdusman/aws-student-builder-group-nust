'use strict';

/*
 * Poster geometry, measured from the 1080x1350 assets.
 * Frame stroke (overlay): x 251–845, y 584–1090, ~3px wide, corner radius ~34.
 * Name plate (overlay): x 281–798, y 1045–1138, inner fill ~284–795 / 1048–1135.
 */
const POSTER = { width: 1080, height: 1350 };
const PHOTO = { x: 252, y: 585, width: 592, height: 504, radius: 34 };
const NAME = {
  centerX: 540,
  centerY: 1092,
  maxWidth: 450,
  maxFontSize: 50,
  minFontSize: 24,
  fontFamily: '"Roboto", "Inter", "Helvetica Neue", Arial, sans-serif',
  placeholder: 'Your Name',
};
const ASSETS = {
  background: 'assets/poster-background.png',
  overlay: 'assets/poster-overlay.png',
};
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const els = {
  form: document.getElementById('posterForm'),
  canvas: document.getElementById('posterCanvas'),
  frame: document.getElementById('posterFrame'),
  handle: document.getElementById('photoHandle'),
  photoInput: document.getElementById('photoInput'),
  uploadButton: document.getElementById('uploadButton'),
  uploadFilled: document.getElementById('uploadFilled'),
  changePhotoButton: document.getElementById('changePhotoButton'),
  photoThumb: document.getElementById('photoThumb'),
  photoFileName: document.getElementById('photoFileName'),
  positionHint: document.getElementById('positionHint'),
  recenterButton: document.getElementById('recenterButton'),
  nameInput: document.getElementById('nameInput'),
  message: document.getElementById('formMessage'),
  downloadButton: document.getElementById('downloadButton'),
  resetButton: document.getElementById('resetButton'),
};

const ctx = els.canvas.getContext('2d');

const state = {
  background: null,
  overlay: null,
  assetsFailed: false,
  photo: null, // pre-scaled canvas that exactly covers the photo frame
  thumbUrl: null,
  offsetX: 0, // photo pan in poster pixels, relative to centered position
  offsetY: 0,
  name: '',
};

let frameRequested = false;

/* ---------- Image helpers ---------- */

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load image: ${src}`));
    img.src = src;
  });
}

/*
 * Scale the photo once so it just covers the frame (cover crop) and keep that copy.
 * Drawing a small pre-scaled canvas while dragging is much cheaper than
 * resampling a 12MP phone photo on every frame.
 */
function createCoverPhoto(img) {
  const scale = Math.max(PHOTO.width / img.naturalWidth, PHOTO.height / img.naturalHeight);
  const w = Math.max(PHOTO.width, Math.round(img.naturalWidth * scale));
  const h = Math.max(PHOTO.height, Math.round(img.naturalHeight * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(img, 0, 0, w, h);
  return off;
}

/* ---------- Rendering ---------- */

function roundedRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function clampOffsets() {
  if (!state.photo) return;
  const maxX = (state.photo.width - PHOTO.width) / 2;
  const maxY = (state.photo.height - PHOTO.height) / 2;
  state.offsetX = Math.min(maxX, Math.max(-maxX, state.offsetX));
  state.offsetY = Math.min(maxY, Math.max(-maxY, state.offsetY));
}

function drawRoundedImage(c, source, dx, dy, dw, dh) {
  c.save();
  roundedRectPath(c, PHOTO.x, PHOTO.y, PHOTO.width, PHOTO.height, PHOTO.radius);
  c.clip();
  c.drawImage(source, dx, dy, dw, dh);
  c.restore();
}

function drawCroppedPhoto(c) {
  const photo = state.photo;
  const dx = PHOTO.x + (PHOTO.width - photo.width) / 2 + state.offsetX;
  const dy = PHOTO.y + (PHOTO.height - photo.height) / 2 + state.offsetY;
  drawRoundedImage(c, photo, dx, dy, photo.width, photo.height);
}

function drawPhotoPlaceholder(c) {
  c.save();
  roundedRectPath(c, PHOTO.x, PHOTO.y, PHOTO.width, PHOTO.height, PHOTO.radius);
  const g = c.createLinearGradient(0, PHOTO.y, 0, PHOTO.y + PHOTO.height);
  g.addColorStop(0, 'rgba(76, 191, 253, 0.10)');
  g.addColorStop(1, 'rgba(76, 191, 253, 0.02)');
  c.fillStyle = g;
  c.fill();

  // Simple person silhouette
  const cx = PHOTO.x + PHOTO.width / 2;
  const cy = PHOTO.y + PHOTO.height * 0.42;
  c.fillStyle = 'rgba(76, 191, 253, 0.22)';
  c.beginPath();
  c.arc(cx, cy - 40, 52, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(cx, cy + 95, 110, 70, 0, Math.PI, 0);
  c.fill();

  c.fillStyle = 'rgba(255, 255, 255, 0.55)';
  c.font = `500 26px ${NAME.fontFamily}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('Your photo here', cx, cy + 135);
  c.restore();
}

function fitFontSize(c, text) {
  let size = NAME.maxFontSize;
  c.font = `700 ${size}px ${NAME.fontFamily}`;
  const width = c.measureText(text).width;
  if (width > NAME.maxWidth) {
    size = Math.max(NAME.minFontSize, Math.floor(size * (NAME.maxWidth / width)));
  }
  return size;
}

function drawParticipantName(c) {
  const text = state.name.trim();
  const display = text || NAME.placeholder;
  const size = fitFontSize(c, display);

  c.save();
  c.font = `700 ${size}px ${NAME.fontFamily}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = text ? '#ffffff' : 'rgba(255, 255, 255, 0.35)';

  // Text that is still too wide at the minimum size gets squeezed horizontally
  // via maxWidth instead of overflowing the plate.
  c.fillText(display, NAME.centerX, NAME.centerY + size * 0.04, NAME.maxWidth);
  c.restore();
}

function drawPoster(c = ctx, { forExport = false } = {}) {
  c.clearRect(0, 0, POSTER.width, POSTER.height);

  if (state.background) {
    c.drawImage(state.background, 0, 0, POSTER.width, POSTER.height);
  } else {
    c.fillStyle = '#00111e';
    c.fillRect(0, 0, POSTER.width, POSTER.height);
  }

  if (state.photo) {
    drawCroppedPhoto(c);
  } else if (!forExport) {
    drawPhotoPlaceholder(c);
  }

  if (state.overlay) {
    c.drawImage(state.overlay, 0, 0, POSTER.width, POSTER.height);
  }

  if (state.name.trim() || !forExport) {
    drawParticipantName(c);
  }
}

function requestDraw() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    drawPoster();
  });
}

/* ---------- UI state ---------- */

function showMessage(text, type = 'error') {
  els.message.textContent = text;
  els.message.dataset.type = text ? type : '';
}

function updatePhotoUI(fileName) {
  const hasPhoto = Boolean(state.photo);
  els.uploadButton.hidden = hasPhoto;
  els.uploadFilled.hidden = !hasPhoto;
  els.positionHint.hidden = !hasPhoto;
  els.frame.classList.toggle('has-photo', hasPhoto);
  els.handle.setAttribute(
    'aria-label',
    hasPhoto ? 'Photo position. Drag or use arrow keys to adjust.' : 'Upload your photo'
  );
  if (hasPhoto) {
    els.photoFileName.textContent = fileName || '';
    els.photoThumb.src = state.thumbUrl;
  } else {
    els.photoThumb.removeAttribute('src');
    els.photoFileName.textContent = '';
  }
}

function setThumbnail(photoCanvas) {
  const size = 96;
  const t = document.createElement('canvas');
  t.width = size;
  t.height = size;
  const s = Math.min(photoCanvas.width, photoCanvas.height);
  t.getContext('2d').drawImage(
    photoCanvas,
    (photoCanvas.width - s) / 2,
    (photoCanvas.height - s) / 2,
    s,
    s,
    0,
    0,
    size,
    size
  );
  state.thumbUrl = t.toDataURL('image/jpeg', 0.8);
}

function openFilePicker() {
  els.photoInput.click();
}

async function handlePhotoUpload(file) {
  if (!file) return;

  if (!ACCEPTED_TYPES.includes(file.type)) {
    showMessage('That file type isn’t supported. Please choose a JPG, PNG or WebP image.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showMessage('That image is too large. Please choose one under 25 MB.');
    return;
  }

  const url = URL.createObjectURL(file);
  els.frame.classList.add('is-loading');
  try {
    const img = await loadImage(url);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Empty image');
    state.photo = createCoverPhoto(img);
    state.offsetX = 0;
    state.offsetY = 0;
    setThumbnail(state.photo);
    updatePhotoUI(file.name);
    showMessage('');
    requestDraw();
  } catch {
    showMessage('We couldn’t read that image. Please try a different photo.');
  } finally {
    URL.revokeObjectURL(url);
    els.frame.classList.remove('is-loading');
    els.photoInput.value = '';
  }
}

function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function downloadPoster() {
  const name = state.name.trim();

  if (state.assetsFailed) {
    showMessage('The poster design didn’t load. Please refresh the page and try again.');
    return;
  }
  if (!state.photo && !name) {
    showMessage('Add your photo and name to create your poster.');
    els.uploadButton.focus();
    return;
  }
  if (!state.photo) {
    showMessage('Please upload your photo first.');
    els.uploadButton.focus();
    return;
  }
  if (!name) {
    showMessage('Please enter your name.');
    els.nameInput.focus();
    return;
  }

  // Render a clean copy at full resolution, without preview-only placeholders.
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = POSTER.width;
  exportCanvas.height = POSTER.height;
  drawPoster(exportCanvas.getContext('2d'), { forExport: true });

  els.downloadButton.disabled = true;
  exportCanvas.toBlob((blob) => {
    els.downloadButton.disabled = false;
    if (!blob) {
      showMessage('Something went wrong while creating your poster. Please try again.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aws-community-day-${slugify(name) || 'attendee'}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage('Your poster is downloading. See you there!', 'success');
  }, 'image/png');
}

function recenterPhoto() {
  state.offsetX = 0;
  state.offsetY = 0;
  requestDraw();
}

function resetGenerator() {
  state.photo = null;
  state.thumbUrl = null;
  state.name = '';
  state.offsetX = 0;
  state.offsetY = 0;
  els.nameInput.value = '';
  els.photoInput.value = '';
  updatePhotoUI();
  showMessage('');
  requestDraw();
}

/* ---------- Dragging ---------- */

function setupDragging() {
  let drag = null;

  els.handle.addEventListener('pointerdown', (e) => {
    if (!state.photo) return;
    e.preventDefault();
    els.handle.setPointerCapture(e.pointerId);
    const rect = els.canvas.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: state.offsetX,
      originY: state.offsetY,
      scale: POSTER.width / rect.width, // screen px -> poster px
    };
    els.frame.classList.add('is-dragging');
  });

  els.handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    state.offsetX = drag.originX + (e.clientX - drag.startX) * drag.scale;
    state.offsetY = drag.originY + (e.clientY - drag.startY) * drag.scale;
    clampOffsets();
    requestDraw();
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    els.frame.classList.remove('is-dragging');
  };
  els.handle.addEventListener('pointerup', endDrag);
  els.handle.addEventListener('pointercancel', endDrag);

  els.handle.addEventListener('click', () => {
    if (!state.photo) openFilePicker();
  });

  els.handle.addEventListener('keydown', (e) => {
    if (!state.photo) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFilePicker();
      }
      return;
    }
    const step = e.shiftKey ? 40 : 10;
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      state.offsetX += moves[e.key][0];
      state.offsetY += moves[e.key][1];
      clampOffsets();
      requestDraw();
    } else if (e.key === 'Home') {
      e.preventDefault();
      recenterPhoto();
    }
  });
}

/* ---------- Mobile menu ---------- */

function setupMenu() {
  const header = document.getElementById('siteHeader');
  const button = document.getElementById('menuButton');
  if (!header || !button) return;

  const setOpen = (open) => {
    header.classList.toggle('menu-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };

  button.addEventListener('click', () => setOpen(!header.classList.contains('menu-open')));
  header.querySelectorAll('#mainmenu a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('menu-open')) {
      setOpen(false);
      button.focus();
    }
  });
}

/* ---------- Init ---------- */

function bindEvents() {
  setupMenu();

  els.uploadButton.addEventListener('click', openFilePicker);
  els.changePhotoButton.addEventListener('click', openFilePicker);
  els.photoInput.addEventListener('change', (e) => handlePhotoUpload(e.target.files[0]));
  els.recenterButton.addEventListener('click', recenterPhoto);
  els.resetButton.addEventListener('click', resetGenerator);

  els.nameInput.addEventListener('input', (e) => {
    state.name = e.target.value.replace(/\s+/g, ' ');
    if (els.message.dataset.type === 'error') showMessage('');
    requestDraw();
  });

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    downloadPoster();
  });

  // Dropping a photo onto the preview is a small convenience for desktop users.
  els.frame.addEventListener('dragover', (e) => e.preventDefault());
  els.frame.addEventListener('drop', (e) => {
    e.preventDefault();
    handlePhotoUpload(e.dataTransfer.files[0]);
  });

  setupDragging();
}

async function init() {
  bindEvents();
  drawPoster();

  const [bg, overlay] = await Promise.allSettled([
    loadImage(ASSETS.background),
    loadImage(ASSETS.overlay),
  ]);
  state.background = bg.status === 'fulfilled' ? bg.value : null;
  state.overlay = overlay.status === 'fulfilled' ? overlay.value : null;
  state.assetsFailed = !state.background || !state.overlay;
  if (state.assetsFailed) {
    showMessage('The poster design didn’t load. Please check your connection and refresh.');
  }
  els.frame.classList.add('is-ready');
  requestDraw();

  // Redraw once the poster font is available so the name uses the right typeface.
  if (document.fonts && document.fonts.load) {
    document.fonts.load(`700 48px Roboto`).then(requestDraw, () => {});
  }
}

init();
