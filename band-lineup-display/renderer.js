if (window.__bandLineupRendererLoaded) {
  console.warn('renderer.js already loaded; skipping duplicate initialization');
} else {
  window.__bandLineupRendererLoaded = true;
/**
 * @typedef {{ id: string, fileName: string, originalName: string, lastLabel: string, lastName: string, source?: string, pcoPersonId?: string, pcoPlanPersonId?: string }} LibraryPerson
 * @typedef {{ personId: string, label: string }} StageSlot
 * @typedef {{ teamName: string, positionName: string, count: number }} PcoDisplayPosition
 */

const DEFAULT_COLUMNS = 7;
const DEFAULT_ROWS = 2;
const DRAG_THRESHOLD = 14;
const TOUCH_HOLD_MS = 420;
const DOUBLE_TAP_MS = 325;
const DOUBLE_TAP_DISTANCE = 24;
const CHROME_HIDE_MS = 12000;

/** @type {LibraryPerson[]} */
let library = [];
let stageColumns = DEFAULT_COLUMNS;
let stageRows = DEFAULT_ROWS;
let parallaxEnabled = true;
let pcoServiceTypeId = '';
/** @type {PcoDisplayPosition[]} */
let pcoDisplayPositions = [];
let pcoPositionOptions = [];
let slotLabelMemory = [];
let slotNameMemory = [];
/** @type {StageSlot[]} */
let stageSlots = createEmptySlots();
const imageUrlCache = new Map();
/** @type {null | { enabled: boolean, reachable: boolean, lastError: string, needsPlaylist: boolean, playlistName: string, items: Array<{uuid:string,name:string,type:string,isHidden:boolean,isPco:boolean,slideCount:number|null}>, activeIndex: number, activePresentationName: string, currentSlide: number, currentSlideTotal: number }} */
let ppData = null;
let saveTimer = null;
let chromeHideTimer = 0;
/** When true, chrome was shown via double-tap edit mode: stay visible until double-tap dismisses (no idle hide). */
let chromeEditLocked = false;

/** @type {null | { type: 'library' | 'stage', personId: string, slotIndex: number, startX: number, startY: number, pointerId: number, pointerType: string, el: HTMLElement, active: boolean, cancelled: boolean, holdTimer: number | null }} */
let pointerDrag = null;

/** @type {{ type: 'name' | 'slotName' | 'slotLabel', personId: string | null, slotIndex: number }} */
let labelEdit = { type: 'slotLabel', personId: null, slotIndex: -1 };
/** @type {HTMLInputElement | null} */
let numericEditTarget = null;
let numericEditCommit = null;
let numericEditMin = 1;
let numericEditMax = Number.POSITIVE_INFINITY;
let numericEditOnInvalid = null;

/** @type {{ time: number, x: number, y: number, pointerType: string, source: string } | null} */
let lastTap = null;
let lastPointerType = 'mouse';

const row = document.getElementById('row');
const empty = document.getElementById('empty');
const dropZone = document.getElementById('drop-zone');
const toolbar = document.getElementById('toolbar');
const libraryList = document.getElementById('library-list');
const libraryPanel = document.getElementById('library-panel');
const btnAdd = document.getElementById('btn-add');
const btnFullscreen = document.getElementById('btn-fullscreen');
const btnApplyLayout = document.getElementById('btn-apply-layout');
const btnToggleParallax = document.getElementById('btn-toggle-parallax');
const btnPcoConnect = document.getElementById('btn-pco-connect');
const btnPcoSync = document.getElementById('btn-pco-sync');
const btnPcoDisconnect = document.getElementById('btn-pco-disconnect');
const btnPcoAddPosition = document.getElementById('btn-pco-add-position');
const inputLayoutCols = document.getElementById('layout-cols');
const inputLayoutRows = document.getElementById('layout-rows');
const slotSizeReadout = document.getElementById('slot-size-readout');
const pcoServiceTypeSelect = document.getElementById('pco-service-type');
const pcoPositionOptionSelect = document.getElementById('pco-position-option');
const pcoPositionList = document.getElementById('pco-position-list');
const pcoStatus = document.getElementById('pco-status');
const dragGhost = document.getElementById('drag-ghost');
const labelModal = document.getElementById('label-modal');
const labelTitle = document.getElementById('label-modal-title');
const labelInput = document.getElementById('label-input');
const labelDone = document.getElementById('label-done');
const labelCancel = document.getElementById('label-cancel');
const labelBackdrop = document.getElementById('label-modal-backdrop');
const numberModal = document.getElementById('number-modal');
const numberModalTitle = document.getElementById('number-modal-title');
const numberInput = document.getElementById('number-input');
const numberDone = document.getElementById('number-done');
const numberCancel = document.getElementById('number-cancel');
const numberBackdrop = document.getElementById('number-modal-backdrop');
const numberKeyboard = document.getElementById('number-keyboard');
const pcoModal = document.getElementById('pco-modal');
const pcoModalBackdrop = document.getElementById('pco-modal-backdrop');
const pcoClientIdInput = document.getElementById('pco-client-id');
const pcoSecretInput = document.getElementById('pco-secret');
const pcoSaveButton = document.getElementById('pco-save');
const pcoCancelButton = document.getElementById('pco-cancel');
const ppColumn = document.getElementById('pp-column');
const ppPlaylistName = document.getElementById('pp-playlist-name');
const ppNow = document.getElementById('pp-now');
const ppNextLabel = document.getElementById('pp-next-label');
const ppNextList = document.getElementById('pp-next-list');
const ppStatus = document.getElementById('pp-status');
const ppPlaylistSelect = document.getElementById('pp-playlist-select');
const btnPpConnect = document.getElementById('btn-pp-connect');
const btnPpDisconnect = document.getElementById('btn-pp-disconnect');
const ppModal = document.getElementById('pp-modal');
const ppModalBackdrop = document.getElementById('pp-modal-backdrop');
const ppHostInput = document.getElementById('pp-host');
const ppPortInput = document.getElementById('pp-port');
const ppPasswordInput = document.getElementById('pp-password');
const ppSaveButton = document.getElementById('pp-save');
const ppCancelButton = document.getElementById('pp-cancel');
const libraryTabs = document.getElementById('library-tabs');
const appVersionEl = document.getElementById('app-version');
const btnDisplayToggle = document.getElementById('btn-display-toggle');
const displayStatusEl = document.getElementById('display-status');
const displayUrlsEl = document.getElementById('display-urls');
const displayPortInput = document.getElementById('display-port');

const VK_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
];
const parallaxAssetCache = new Map();
const parallaxViewStates = new Set();
let parallaxAnimationFrame = 0;

function getStageSlotCount() {
  return stageColumns * stageRows;
}

function createEmptySlots(count = getStageSlotCount()) {
  return Array.from({ length: count }, (_slot, index) => ({
    personId: '',
    label: slotLabelMemory[index] || '',
  }));
}

function ensureSlotLabelMemorySize(count) {
  while (slotLabelMemory.length < count) {
    slotLabelMemory.push('');
  }
}

function ensureSlotNameMemorySize(count) {
  while (slotNameMemory.length < count) {
    slotNameMemory.push('');
  }
}

/**
 * @param {unknown} raw
 */
function normalizeLineup(raw, slotCount = getStageSlotCount()) {
  ensureSlotLabelMemorySize(slotCount);
  ensureSlotNameMemorySize(slotCount);
  const normalized = createEmptySlots(slotCount);
  if (!Array.isArray(raw)) return normalized;

  for (let i = 0; i < Math.min(raw.length, slotCount); i += 1) {
    const entry = raw[i];
    if (!entry || typeof entry !== 'object') continue;
    normalized[i] = {
      personId: typeof entry.personId === 'string' ? entry.personId : '',
      label: slotLabelMemory[i] || (typeof entry.label === 'string' ? entry.label : ''),
    };
  }

  return normalized;
}

function isModalOpen() {
  return (
    !labelModal.classList.contains('hidden') ||
    !numberModal.classList.contains('hidden') ||
    !pcoModal.classList.contains('hidden') ||
    !ppModal.classList.contains('hidden')
  );
}

function isToolbarActive() {
  return toolbar.contains(document.activeElement) || toolbar.matches(':hover');
}

function isLibraryActive() {
  return libraryPanel.contains(document.activeElement) || libraryPanel.matches(':hover');
}

function clearChromeHideTimer() {
  if (!chromeHideTimer) return;
  clearTimeout(chromeHideTimer);
  chromeHideTimer = 0;
}

function enterChromeEditMode() {
  chromeEditLocked = true;
  clearChromeHideTimer();
  document.body.classList.remove('chrome-hidden');
}

function exitChromeEditMode() {
  chromeEditLocked = false;
  clearChromeHideTimer();
  document.body.classList.add('chrome-hidden');
}

function toggleChromeEditMode() {
  if (chromeEditLocked || !document.body.classList.contains('chrome-hidden')) {
    exitChromeEditMode();
    return;
  }
  enterChromeEditMode();
}

function scheduleChromeHide() {
  clearChromeHideTimer();
}

function revealChrome() {
  enterChromeEditMode();
}

function noteActivity() {
  void CHROME_HIDE_MS;
}

function syncLayoutInputs() {
  inputLayoutCols.value = String(stageColumns);
  inputLayoutRows.value = String(stageRows);
}

function syncParallaxToggle() {
  btnToggleParallax.textContent = parallaxEnabled ? 'Parallax On' : 'Parallax Off';
  btnToggleParallax.classList.toggle('primary', parallaxEnabled);
}

function setPcoStatus(message, isError = false) {
  pcoStatus.textContent = message;
  pcoStatus.style.color = isError ? '#ffb1b1' : '#9ea7bc';
}

function setPcoControlsEnabled(enabled) {
  btnPcoConnect.disabled = !enabled;
  btnPcoSync.disabled = !enabled;
  btnPcoDisconnect.disabled = !enabled;
  btnPcoAddPosition.disabled = !enabled;
  pcoServiceTypeSelect.disabled = !enabled;
  pcoPositionOptionSelect.disabled = !enabled;
}

function normalizePcoDisplayPosition(entry) {
  const count = Number.parseInt(String(entry?.count ?? 1), 10);
  return {
    teamName: String(entry?.teamName || '').trim(),
    positionName: String(entry?.positionName || '').trim(),
    count: Number.isFinite(count) && count > 0 ? count : 1,
  };
}

function pcoPositionKey(teamName, positionName) {
  return `${String(teamName || '').trim().toLowerCase()}::${String(positionName || '').trim().toLowerCase()}`;
}

function renderPcoServiceTypes(serviceTypes) {
  const previousValue = pcoServiceTypeId;
  pcoServiceTypeSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose service type';
  pcoServiceTypeSelect.appendChild(placeholder);
  for (const serviceType of serviceTypes) {
    const option = document.createElement('option');
    option.value = serviceType.id;
    option.textContent = serviceType.name;
    pcoServiceTypeSelect.appendChild(option);
  }
  pcoServiceTypeSelect.value = previousValue || '';
}

async function refreshPcoServiceTypes() {
  const serviceTypes = await window.lineup.pcoServiceTypes();
  renderPcoServiceTypes(Array.isArray(serviceTypes) ? serviceTypes : []);
}

function renderPcoPositionOptions() {
  const previousValue = pcoPositionOptionSelect.value;
  pcoPositionOptionSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = pcoServiceTypeId ? 'Choose position' : 'Choose service type first';
  pcoPositionOptionSelect.appendChild(placeholder);
  for (const optionData of pcoPositionOptions) {
    const option = document.createElement('option');
    option.value = optionData.key;
    option.textContent = `${optionData.teamName} | ${optionData.positionName}`;
    pcoPositionOptionSelect.appendChild(option);
  }
  pcoPositionOptionSelect.value = previousValue || '';
}

function movePcoDisplayPosition(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= pcoDisplayPositions.length) return;
  const next = [...pcoDisplayPositions];
  const [entry] = next.splice(index, 1);
  next.splice(targetIndex, 0, entry);
  pcoDisplayPositions = next;
  renderPcoDisplayPositions();
  scheduleSave();
}

function updatePcoDisplayPositionCount(index, delta) {
  const entry = pcoDisplayPositions[index];
  if (!entry) return;
  entry.count = Math.max(1, entry.count + delta);
  renderPcoDisplayPositions();
  scheduleSave();
}

function removePcoDisplayPosition(index) {
  pcoDisplayPositions = pcoDisplayPositions.filter((_entry, entryIndex) => entryIndex !== index);
  renderPcoDisplayPositions();
  scheduleSave();
}

function renderPcoDisplayPositions() {
  pcoPositionList.innerHTML = '';
  if (!pcoDisplayPositions.length) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'pco-position-empty';
    emptyItem.textContent = 'Add the positions you want to display. Increase the count if you need multiple slots for a position like Vocalists.';
    pcoPositionList.appendChild(emptyItem);
    return;
  }
  for (const [index, entry] of pcoDisplayPositions.entries()) {
    const item = document.createElement('div');
    item.className = 'pco-position-item';

    const copy = document.createElement('div');
    copy.className = 'pco-position-copy';
    const name = document.createElement('div');
    name.className = 'pco-position-name';
    name.textContent = entry.positionName;
    const team = document.createElement('div');
    team.className = 'pco-position-team';
    team.textContent = entry.teamName;
    copy.appendChild(name);
    copy.appendChild(team);

    const downCount = document.createElement('button');
    downCount.type = 'button';
    downCount.className = 'btn btn-small';
    downCount.textContent = '-';
    downCount.addEventListener('click', () => updatePcoDisplayPositionCount(index, -1));

    const countChip = document.createElement('div');
    countChip.className = 'pco-count-chip';
    countChip.textContent = `x${entry.count}`;

    const upCount = document.createElement('button');
    upCount.type = 'button';
    upCount.className = 'btn btn-small';
    upCount.textContent = '+';
    upCount.addEventListener('click', () => updatePcoDisplayPositionCount(index, 1));

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'btn btn-small';
    up.textContent = 'Up';
    up.addEventListener('click', () => movePcoDisplayPosition(index, -1));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'btn btn-small';
    down.textContent = 'Down';
    down.addEventListener('click', () => movePcoDisplayPosition(index, 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-small';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removePcoDisplayPosition(index));

    item.appendChild(copy);
    item.appendChild(downCount);
    item.appendChild(countChip);
    item.appendChild(upCount);
    item.appendChild(up);
    item.appendChild(down);
    item.appendChild(remove);
    pcoPositionList.appendChild(item);
  }
}

async function refreshPcoPositionOptions() {
  if (!pcoServiceTypeId) {
    pcoPositionOptions = [];
    renderPcoPositionOptions();
    return;
  }
  const options = await window.lineup.pcoPositionOptions(pcoServiceTypeId);
  pcoPositionOptions = Array.isArray(options) ? options : [];
  renderPcoPositionOptions();
}

function openPcoModal() {
  pcoModal.classList.remove('hidden');
  pcoClientIdInput.focus();
  pcoClientIdInput.select();
}

function closePcoModal() {
  pcoModal.classList.add('hidden');
  pcoSecretInput.value = '';
}

function applyLoadedState(data) {
  library = Array.isArray(data.library)
    ? data.library.map((person) => ({
        id: String(person.id),
        fileName: String(person.fileName),
        originalName: typeof person.originalName === 'string' ? person.originalName : '',
        lastLabel: typeof person.lastLabel === 'string' ? person.lastLabel : '',
        lastName: typeof person.lastName === 'string' ? person.lastName : '',
        source: person?.source === 'pco' ? 'pco' : 'local',
        pcoPersonId: typeof person?.pcoPersonId === 'string' ? person.pcoPersonId : '',
        pcoPlanPersonId: typeof person?.pcoPlanPersonId === 'string' ? person.pcoPlanPersonId : '',
      }))
    : [];
  const savedColumns = Number.parseInt(String(data?.layout?.columns ?? DEFAULT_COLUMNS), 10);
  const savedRows = Number.parseInt(String(data?.layout?.rows ?? DEFAULT_ROWS), 10);
  stageColumns = Number.isFinite(savedColumns) && savedColumns > 0 ? savedColumns : DEFAULT_COLUMNS;
  stageRows = Number.isFinite(savedRows) && savedRows > 0 ? savedRows : DEFAULT_ROWS;
  parallaxEnabled = typeof data?.parallaxEnabled === 'boolean' ? data.parallaxEnabled : true;
  pcoServiceTypeId = typeof data?.pcoServiceTypeId === 'string' ? data.pcoServiceTypeId : '';
  pcoDisplayPositions = Array.isArray(data?.pcoDisplayPositions)
    ? data.pcoDisplayPositions.map((entry) => normalizePcoDisplayPosition(entry)).filter((entry) => entry.teamName && entry.positionName)
    : [];
  slotLabelMemory = Array.isArray(data.slotLabels)
    ? data.slotLabels.map((label) => (typeof label === 'string' ? label : ''))
    : [];
  slotNameMemory = Array.isArray(data.slotNames)
    ? data.slotNames.map((label) => (typeof label === 'string' ? label : ''))
    : [];
  ensureSlotLabelMemorySize(getStageSlotCount());
  ensureSlotNameMemorySize(getStageSlotCount());
  syncLayoutInputs();
  syncParallaxToggle();
  pcoServiceTypeSelect.value = pcoServiceTypeId;
  renderPcoDisplayPositions();
  stageSlots = normalizeLineup(data.lineup, getStageSlotCount());
}

function updateSlotSizeReadout() {
  // The readout is no longer in the toolbar. Kept null-safe because several render paths
  // still call it; the source-resolution numbers move into the Pictures tab.
  if (!slotSizeReadout) return;
  const firstSlot = row.querySelector('.stage-slot');
  const visual = firstSlot ? firstSlot.querySelector('.slot-visual') : null;
  if (!firstSlot || !visual) {
    slotSizeReadout.textContent = 'Slot: -- x -- px | Visible image: -- x -- px | Minimum source: -- x -- px | Ideal source: -- x -- px';
    return;
  }

  const slotRect = firstSlot.getBoundingClientRect();
  const visualRect = visual.getBoundingClientRect();
  const slotWidth = Math.max(1, Math.round(slotRect.width));
  const slotHeight = Math.max(1, Math.round(slotRect.height));
  const imageWidth = Math.max(1, Math.round(visualRect.width));
  const imageHeight = Math.max(1, Math.round(visualRect.height));
  const minimumWidth = imageWidth * 2;
  const minimumHeight = imageHeight * 2;
  const idealWidth = imageWidth * 3;
  const idealHeight = imageHeight * 3;

  slotSizeReadout.textContent = `Slot: ${slotWidth} x ${slotHeight} px | Visible image: ${imageWidth} x ${imageHeight} px | Minimum source: ${minimumWidth} x ${minimumHeight} px | Ideal source: ${idealWidth} x ${idealHeight} px`;
}

function resizeStageSlots(nextColumns, nextRows) {
  const nextCount = nextColumns * nextRows;
  for (let i = 0; i < stageSlots.length; i += 1) {
    slotLabelMemory[i] = stageSlots[i].label || '';
  }
  ensureSlotLabelMemorySize(nextCount);
  ensureSlotNameMemorySize(nextCount);
  const nextSlots = createEmptySlots(nextCount);
  for (let i = 0; i < Math.min(stageSlots.length, nextCount); i += 1) {
    nextSlots[i] = {
      personId: stageSlots[i].personId || '',
      label: slotLabelMemory[i] || '',
    };
  }
  stageColumns = nextColumns;
  stageRows = nextRows;
  stageSlots = nextSlots;
}

async function applyLayoutChange() {
  const nextColumns = Number.parseInt(inputLayoutCols.value, 10);
  const nextRows = Number.parseInt(inputLayoutRows.value, 10);
  const safeColumns = Number.isFinite(nextColumns) && nextColumns > 0 ? nextColumns : stageColumns;
  const safeRows = Number.isFinite(nextRows) && nextRows > 0 ? nextRows : stageRows;

  if (safeColumns === stageColumns && safeRows === stageRows) {
    syncLayoutInputs();
    return;
  }

  resizeStageSlots(safeColumns, safeRows);
  syncLayoutInputs();
  await renderStage();
  await renderLibrary();
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await window.lineup.saveState({
      library,
      layout: { columns: stageColumns, rows: stageRows },
      parallaxEnabled,
      pcoServiceTypeId,
      pcoDisplayPositions,
      slotLabels: slotLabelMemory,
      slotNames: slotNameMemory,
      lineup: stageSlots,
    });
  }, 250);
}

function pointInRect(x, y, rect) {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function getPerson(personId) {
  return library.find((person) => person.id === personId) || null;
}

/**
 * @param {LibraryPerson} person
 */
function getLibraryDisplayName(person) {
  if (typeof person.originalName === 'string' && person.originalName.trim()) {
    return person.originalName.trim();
  }
  if (typeof person.lastName === 'string' && person.lastName.trim()) {
    return person.lastName.trim();
  }
  return String(person.fileName || '').replace(/\.[^.]+$/, '');
}

function getStageName(slotIndex, person) {
  if (person && typeof person.lastName === 'string' && person.lastName.trim()) {
    return person.lastName.trim();
  }
  return slotNameMemory[slotIndex] || '';
}

async function getImageHref(fileName) {
  if (!fileName) return '';
  if (imageUrlCache.has(fileName)) {
    return imageUrlCache.get(fileName) || '';
  }
  const href = await window.lineup.imageUrl(fileName);
  imageUrlCache.set(fileName, href || '');
  return href || '';
}

async function getParallaxAssets(fileName) {
  if (!fileName) return null;
  if (parallaxAssetCache.has(fileName)) {
    return parallaxAssetCache.get(fileName);
  }
  const result = await window.lineup.parallaxAssets(fileName);
  parallaxAssetCache.set(fileName, result);
  return result;
}

function ensureParallaxLoop() {
  if (parallaxAnimationFrame) return;
  const step = (time) => {
    parallaxAnimationFrame = 0;
    if (!parallaxViewStates.size) return;
    for (const state of [...parallaxViewStates]) {
      if (!state.root.isConnected) {
        parallaxViewStates.delete(state);
        continue;
      }
      const camX = Math.sin(time / 3200 + state.phase) * state.xRange;
      const camY = Math.cos(time / 4100 + state.phase) * state.yRange;
      const camRot = Math.sin(time / 3600 + state.phase) * state.rotRange;
      state.root.style.setProperty('--cam-x', `${camX}px`);
      state.root.style.setProperty('--cam-y', `${camY}px`);
      state.root.style.setProperty('--cam-rot', `${camRot}deg`);
    }
    parallaxAnimationFrame = window.requestAnimationFrame(step);
  };
  parallaxAnimationFrame = window.requestAnimationFrame(step);
}

function setupParallaxViewport(root, seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  parallaxViewStates.add({
    root,
    phase: (hash % 628) / 100,
    xRange: 8 + (hash % 5),
    yRange: 5 + ((hash >> 5) % 4),
    rotRange: 1.2 + ((hash >> 9) % 8) / 10,
  });
  ensureParallaxLoop();
}

/**
 * @param {PointerEvent | MouseEvent} e
 */
function interactionPointerType(e) {
  if ('pointerType' in e && typeof e.pointerType === 'string' && e.pointerType) {
    return e.pointerType;
  }
  return lastPointerType || 'mouse';
}

/**
 * @param {HTMLElement | null} target
 */
function shouldIgnoreChromeToggleTarget(target) {
  if (!target) return false;
  return Boolean(
    target.closest(
      'button, input, select, textarea, a, .btn, .vk-key, .label-input, .caption, .name-badge, .remove, .lib-delete',
    ),
  );
}

function findStageIndexByPersonId(personId) {
  return stageSlots.findIndex((slot) => slot.personId === personId);
}

function getStageSlotIndexFromPoint(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const slot = el ? el.closest('.stage-slot') : null;
  if (!slot) return null;
  const idx = Number(slot.dataset.slotIndex);
  return Number.isInteger(idx) ? idx : null;
}

function removeFromStageIndex(slotIndex) {
  if (slotIndex < 0 || slotIndex >= getStageSlotCount()) return;
  stageSlots[slotIndex].personId = '';
}

/**
 * Put a person into a slot.
 * @param sourceIndex the slot being dragged FROM for a stage move, or -1 for a library drag.
 *
 * A library drag places into the target and leaves any other slots holding that person
 * ALONE — the same photo can fill several slots (e.g. one player covering two mix positions).
 * A stage drag still swaps, using the exact slot dragged from rather than searching by
 * person, so a duplicated person moves the tile you actually grabbed.
 */
function placePersonIntoSlot(personId, targetIndex, sourceIndex = -1) {
  if (targetIndex < 0 || targetIndex >= getStageSlotCount()) return [];
  if (sourceIndex === targetIndex) return [];

  if (sourceIndex >= 0) {
    const targetPersonId = stageSlots[targetIndex].personId;
    stageSlots[targetIndex].personId = personId;
    stageSlots[sourceIndex].personId = targetPersonId || '';
    return [sourceIndex, targetIndex];
  }
  stageSlots[targetIndex].personId = personId;
  return [targetIndex];
}

function showGhostFromImg(imgEl) {
  const ghostImage = dragGhost.querySelector('img') || document.createElement('img');
  if (!ghostImage.parentElement) dragGhost.appendChild(ghostImage);
  ghostImage.src = imgEl.currentSrc || imgEl.src;
  dragGhost.classList.remove('hidden');
}

function moveGhost(x, y) {
  dragGhost.style.left = `${x - 44}px`;
  dragGhost.style.top = `${y - 59}px`;
}

function hideGhost() {
  dragGhost.classList.add('hidden');
}

function clearHoldTimer() {
  if (pointerDrag && pointerDrag.holdTimer) {
    window.clearTimeout(pointerDrag.holdTimer);
    pointerDrag.holdTimer = null;
  }
}

function startActiveDrag() {
  if (!pointerDrag || pointerDrag.active || pointerDrag.cancelled) return;
  pointerDrag.active = true;
  pointerDrag.el.classList.add('dragging-source');
  const image = pointerDrag.el.querySelector('img');
  if (image) showGhostFromImg(image);
  moveGhost(pointerDrag.startX, pointerDrag.startY);
  try {
    pointerDrag.el.setPointerCapture(pointerDrag.pointerId);
  } catch {
    /* ignore */
  }
}

function startDragSession(el, state) {
  pointerDrag = {
    ...state,
    active: false,
    cancelled: false,
    holdTimer: null,
  };

  if (state.pointerType === 'touch') {
    pointerDrag.holdTimer = window.setTimeout(() => {
      startActiveDrag();
    }, TOUCH_HOLD_MS);
  }
}

/**
 * @param {PointerEvent | MouseEvent} e
 * @param {string} source
 */
function maybeToggleChromeOnDoubleActivate(e, source) {
  const pointerType = interactionPointerType(e);
  if (!pointerType) return;
  const now = Date.now();
  if (
    lastTap &&
    lastTap.pointerType === pointerType &&
    lastTap.source === source &&
    now - lastTap.time <= DOUBLE_TAP_MS &&
    Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE
  ) {
    lastTap = null;
    toggleChromeEditMode();
    return;
  }

  lastTap = {
    time: now,
    x: e.clientX,
    y: e.clientY,
    pointerType,
    source,
  };
}

/**
 * @param {MouseEvent} e
 * @param {string} source
 */
function handleChromeToggleSurfaceClick(e, source) {
  if (isModalOpen()) return;
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (shouldIgnoreChromeToggleTarget(target)) return;
  noteActivity();
  maybeToggleChromeOnDoubleActivate(e, source);
}

async function handlePointerDrop(clientX, clientY, ctx) {
  const targetIndex = getStageSlotIndexFromPoint(clientX, clientY);
  const libraryRect = libraryPanel.getBoundingClientRect();
  // The whole panel counts as "drop here to remove from the stage" — except the tab strip,
  // where a drop would both remove the person and switch tabs. Measured against the panel
  // rather than the photo grid on purpose: a hidden grid reports an all-zero rect, which
  // would silently disable drag-to-remove whenever another tab is open.
  const tabsRect = libraryTabs ? libraryTabs.getBoundingClientRect() : null;
  const onTabs = tabsRect ? pointInRect(clientX, clientY, tabsRect) : false;
  const onLibrary = !onTabs && pointInRect(clientX, clientY, libraryRect);

  if (targetIndex !== null) {
    // A stage drag carries its own slot index; a library drag is -1, which lets the same
    // photo land in more than one slot instead of being moved out of its current one.
    const sourceIndex = ctx.type === 'stage' ? ctx.slotIndex : -1;
    const changedSlots = placePersonIntoSlot(ctx.personId, targetIndex, sourceIndex);
    if (!changedSlots.length) return;
    await renderStage(changedSlots);
    if (ctx.type === 'library') {
      await renderLibrary();
    }
    scheduleSave();
    return;
  }

  if (ctx.type === 'stage' && onLibrary) {
    removeFromStageIndex(ctx.slotIndex);
    await renderStage([ctx.slotIndex]);
    await renderLibrary();
    scheduleSave();
  }
}

function onPointerDown(e) {
  lastPointerType = e.pointerType || lastPointerType;
  if (isModalOpen()) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  const target = /** @type {HTMLElement} */ (e.target);
  if (
    target.closest('.lib-delete') ||
    target.closest('.remove') ||
    target.closest('.caption') ||
    target.closest('.name-badge') ||
    target.closest('.btn') ||
    target.closest('.lib-tab') ||
    target.closest('.vk-key') ||
    target.closest('.label-input')
  ) {
    noteActivity();
    return;
  }

  const libItem = target.closest('.lib-item');
  const photoArea = target.closest('.photo-area');

  if (libItem) {
    const personId = libItem.dataset.personId;
    if (!personId) return;
    startDragSession(libItem, {
      type: 'library',
      personId,
      slotIndex: -1,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      el: libItem,
    });
    return;
  }

  if (photoArea) {
    const tile = photoArea.closest('.tile');
    if (!tile) return;
    const personId = tile.dataset.personId;
    const slotIndex = Number(tile.dataset.slotIndex);
    if (!personId || !Number.isInteger(slotIndex)) return;
    startDragSession(tile, {
      type: 'stage',
      personId,
      slotIndex,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      el: tile,
    });
  }
}

function onPointerMove(e) {
  if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;
  noteActivity();
  const dx = e.clientX - pointerDrag.startX;
  const dy = e.clientY - pointerDrag.startY;
  const distance = Math.hypot(dx, dy);

  if (!pointerDrag.active) {
    if (pointerDrag.pointerType === 'touch') {
      if (distance > DRAG_THRESHOLD) {
        if (pointerDrag.holdTimer) {
          clearHoldTimer();
          pointerDrag.cancelled = true;
        }
      }
      return;
    }

    if (distance < DRAG_THRESHOLD) return;
    startActiveDrag();
  }

  moveGhost(e.clientX, e.clientY);
}

function onPointerUp(e) {
  if (!pointerDrag || e.pointerId !== pointerDrag.pointerId) return;

  const currentDrag = pointerDrag;
  const wasActive = currentDrag.active;
  clearHoldTimer();

  try {
    currentDrag.el.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }

  currentDrag.el.classList.remove('dragging-source');
  pointerDrag = null;
  hideGhost();
  noteActivity();

  if (wasActive) {
    void handlePointerDrop(e.clientX, e.clientY, {
      type: currentDrag.type,
      personId: currentDrag.personId,
      slotIndex: currentDrag.slotIndex,
    });
    return;
  }

  if (currentDrag.cancelled) return;
}

document.addEventListener('pointerdown', onPointerDown, true);
document.addEventListener('pointermove', onPointerMove, true);
document.addEventListener('pointerup', onPointerUp, true);
document.addEventListener('pointercancel', onPointerUp, true);

function updateEmpty() {
  empty.classList.toggle('visible', stageSlots.every((slot) => !slot.personId));
}

function parallaxMotionVars(seedText) {
  let hash = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    hash = (hash * 31 + seedText.charCodeAt(i)) >>> 0;
  }
  const directionX = hash % 2 === 0 ? 1 : -1;
  const directionY = (hash >> 1) % 2 === 0 ? 1 : -1;
  const bgX = 28 + (hash % 18);
  const bgY = 18 + ((hash >> 3) % 12);
  const midX = 0;
  const midY = 0;
  const fgX = 14 + ((hash >> 11) % 10);
  const fgY = 9 + ((hash >> 14) % 7);
  return {
    '--p-bg-x': `${directionX * bgX}px`,
    '--p-bg-y': `${directionY * bgY}px`,
    '--p-mid-x': `${-directionX * midX}px`,
    '--p-mid-y': `${directionY * midY}px`,
    '--p-fg-x': `${directionX * fgX}px`,
    '--p-fg-y': `${-directionY * fgY}px`,
  };
}

function createPhotoTile(person, href, slotIndex, parallaxAssets) {
  void parallaxAssets;
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.personId = person.id;
  tile.dataset.slotIndex = String(slotIndex);

  const photoArea = document.createElement('div');
  photoArea.className = 'photo-area';

  if (!parallaxEnabled) {
    const staticImage = document.createElement('img');
    staticImage.alt = '';
    staticImage.src = href;
    staticImage.className = 'static-stage-image';
    photoArea.appendChild(staticImage);
  } else {
    const parallaxViewport = document.createElement('div');
    parallaxViewport.className = 'parallax-viewport';
    const movingImage = document.createElement('img');
    movingImage.alt = '';
    movingImage.src = href;
    movingImage.className = 'moving-stage-image';
    parallaxViewport.appendChild(movingImage);

    photoArea.appendChild(parallaxViewport);
    setupParallaxViewport(parallaxViewport, `${person.id}:${slotIndex}`);
  }

  const nameBadge = document.createElement('div');
  nameBadge.className = 'name-badge';
  nameBadge.textContent = getStageName(slotIndex, person);
  nameBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    openLabelModal({ type: 'name', personId: person.id, slotIndex });
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'remove';
  removeBtn.setAttribute('aria-label', 'Remove from stage');
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeFromStageIndex(slotIndex);
    void renderStage([slotIndex]);
    void renderLibrary();
    scheduleSave();
  });

  photoArea.appendChild(nameBadge);
  photoArea.appendChild(removeBtn);
  tile.appendChild(photoArea);
  return tile;
}

function createStageSlot(slotIndex, slot, href, parallaxAssets) {
  const slotEl = document.createElement('div');
  const hasPerson = Boolean(slot.personId && href);
  slotEl.className = 'stage-slot' + (hasPerson ? '' : ' empty-slot');
  slotEl.dataset.slotIndex = String(slotIndex);
  slotEl.dataset.slotLabel = `Slot ${slotIndex + 1}`;

  const visual = document.createElement('div');
  visual.className = 'slot-visual';

  if (hasPerson) {
    const person = getPerson(slot.personId);
    if (person) {
      visual.appendChild(createPhotoTile(person, href, slotIndex, parallaxAssets));
    }
  } else {
    const nameHotspot = document.createElement('button');
    nameHotspot.type = 'button';
    nameHotspot.className = 'empty-name-hotspot';
    nameHotspot.setAttribute('aria-label', 'Add stage name');
    nameHotspot.title = 'Tap top area to add a name';
    nameHotspot.textContent = slotNameMemory[slotIndex] || '';
    nameHotspot.addEventListener('click', (e) => {
      e.stopPropagation();
      openLabelModal({ type: 'slotName', personId: null, slotIndex });
    });

    const placeholder = document.createElement('div');
    placeholder.className = 'slot-placeholder';
    placeholder.textContent = '';
    visual.appendChild(nameHotspot);
    visual.appendChild(placeholder);
  }

  const caption = document.createElement('div');
  caption.className = 'caption';
  caption.textContent = slot.label || '';
  caption.addEventListener('click', (e) => {
    e.stopPropagation();
    openLabelModal({ type: 'slotLabel', personId: null, slotIndex });
  });

  slotEl.appendChild(visual);
  slotEl.appendChild(caption);
  return slotEl;
}

function createLibraryItem(person, href, onStage) {
  const item = document.createElement('div');
  item.className = 'lib-item' + (onStage ? ' on-lineup' : '');
  item.dataset.personId = person.id;

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'lib-delete';
  deleteBtn.setAttribute('aria-label', 'Delete photo from library');
  deleteBtn.textContent = '×';
  deleteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void deleteLibraryPerson(person.id);
  });

  const image = document.createElement('img');
  image.alt = getLibraryDisplayName(person);
  image.src = href;

  const nameOverlay = document.createElement('div');
  nameOverlay.className = 'lib-name-overlay';
  nameOverlay.textContent = getLibraryDisplayName(person);

  item.appendChild(deleteBtn);
  item.appendChild(image);
  item.appendChild(nameOverlay);
  return item;
}

async function deleteLibraryPerson(personId) {
  const person = getPerson(personId);
  if (!person) return;
  const ok = window.confirm('Delete this photo from the library? It will be removed from disk and cannot be undone.');
  if (!ok) return;

  stageSlots = stageSlots.map((slot) => (slot.personId === personId ? { ...slot, personId: '' } : slot));
  library = library.filter((item) => item.id !== personId);

  await window.lineup.deleteLibraryImage(person.fileName);
  imageUrlCache.delete(person.fileName);
  await renderStage();
  await renderLibrary();
  scheduleSave();
}

async function renderStage(slotIndexes) {
  row.style.gridTemplateColumns = `repeat(${stageColumns}, minmax(0, 1fr))`;
  row.style.gridTemplateRows = `repeat(${stageRows}, minmax(0, 1fr))`;
  const slotCount = getStageSlotCount();
  const indexes =
    Array.isArray(slotIndexes) && slotIndexes.length
      ? [...new Set(slotIndexes.filter((idx) => idx >= 0 && idx < slotCount))]
      : Array.from({ length: slotCount }, (_v, idx) => idx);

  if (row.children.length !== slotCount || !Array.isArray(slotIndexes)) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < slotCount; i += 1) {
      const slot = stageSlots[i];
      const person = slot.personId ? getPerson(slot.personId) : null;
      const href = person ? await getImageHref(person.fileName) : '';
      fragment.appendChild(createStageSlot(i, slot, href, null));
    }
    row.replaceChildren(fragment);
    updateEmpty();
    window.requestAnimationFrame(updateSlotSizeReadout);
    return;
  }

  for (const i of indexes) {
    const slot = stageSlots[i];
    const person = slot.personId ? getPerson(slot.personId) : null;
    const href = person ? await getImageHref(person.fileName) : '';
    const nextSlot = createStageSlot(i, slot, href, null);
    const existingSlot = row.children[i];
    if (existingSlot) {
      existingSlot.replaceWith(nextSlot);
    } else {
      row.appendChild(nextSlot);
    }
  }
  updateEmpty();
  window.requestAnimationFrame(updateSlotSizeReadout);
}

async function renderLibrary() {
  // The grid is rebuilt after every drop. Now that it is full-height and genuinely
  // scrollable, losing the scroll position would throw the operator back to the top on
  // every single drag onto the stage.
  const previousScroll = libraryList.scrollTop;
  libraryList.innerHTML = '';
  const onStage = new Set(stageSlots.filter((slot) => slot.personId).map((slot) => slot.personId));
  for (const person of library) {
    const href = await getImageHref(person.fileName);
    if (!href) continue;
    libraryList.appendChild(createLibraryItem(person, href, onStage.has(person.id)));
  }
  libraryList.scrollTop = previousScroll;
}

async function renderAll() {
  await renderStage();
  await renderLibrary();
}

async function importNewPeople(added) {
  if (!added.length) return;
  for (const person of added) {
    library.push({
      id: person.id,
      fileName: person.fileName,
      originalName: typeof person.originalName === 'string' ? person.originalName : '',
      lastLabel: '',
      lastName: '',
      source: 'local',
      pcoPersonId: '',
      pcoPlanPersonId: '',
    });
  }
  await renderLibrary();
  scheduleSave();
}

async function connectPlanningCenter() {
  const clientId = pcoClientIdInput.value.trim();
  const secret = pcoSecretInput.value.trim();
  if (!clientId || !secret) {
    setPcoStatus('Enter both the Client ID and Secret.', true);
    return;
  }
  setPcoControlsEnabled(false);
  setPcoStatus('Connecting to Planning Center...');
  try {
    const result = await window.lineup.pcoConnect({ clientId, secret });
    renderPcoServiceTypes(Array.isArray(result?.serviceTypes) ? result.serviceTypes : []);
    pcoServiceTypeSelect.value = pcoServiceTypeId || '';
    await refreshPcoPositionOptions();
    closePcoModal();
    setPcoStatus('Planning Center connected.');
  } catch (error) {
    setPcoStatus(error instanceof Error ? error.message : 'Could not connect to Planning Center.', true);
  } finally {
    setPcoControlsEnabled(true);
  }
}

async function syncUpcomingPlanFromPco() {
  if (!pcoServiceTypeId) {
    setPcoStatus('Choose a service type before syncing.', true);
    return;
  }
  setPcoControlsEnabled(false);
  setPcoStatus('Syncing the upcoming plan from Planning Center...');
  try {
    const result = await window.lineup.pcoSyncUpcomingPlan({
      serviceTypeId: pcoServiceTypeId,
      library,
      layout: { columns: stageColumns, rows: stageRows },
      parallaxEnabled,
      slotLabels: slotLabelMemory,
      slotNames: slotNameMemory,
      lineup: stageSlots,
      pcoDisplayPositions,
    });
    applyLoadedState(result.state);
    await renderAll();
    const planLabel = [result?.plan?.title, result?.plan?.shortDates].filter(Boolean).join(' | ');
    setPcoStatus(
      planLabel
        ? `Synced ${result?.plan?.displayedCount || 0} labeled boxes from ${planLabel}.`
        : `Synced ${result?.plan?.displayedCount || 0} labeled boxes.`,
    );
  } catch (error) {
    setPcoStatus(error instanceof Error ? error.message : 'Planning Center sync failed.', true);
  } finally {
    setPcoControlsEnabled(true);
  }
}

/* ---------------- Setup panel tabs ---------------- */

/** Set while a tab switch blurs the port field, so the blur handler doesn't commit. */
let suppressPortCommit = false;

function activatePanelTab(name) {
  if (!libraryTabs) return;
  // Leaving the ProPresenter tab must not commit a port the operator was still thinking
  // about: hiding the pane blurs the field, and that blur would otherwise restart the LAN
  // display server and drop every bookmarked screen in the building.
  if (displayPortInput && document.activeElement === displayPortInput) {
    suppressPortCommit = true;
    displayPortInput.blur();
    suppressPortCommit = false;
  }
  for (const tab of libraryTabs.querySelectorAll('.lib-tab')) {
    const isOn = tab.dataset.tab === name;
    tab.classList.toggle('is-active', isOn);
    tab.setAttribute('aria-selected', isOn ? 'true' : 'false');
  }
  for (const pane of libraryPanel.querySelectorAll('.library-pane')) {
    pane.classList.toggle('is-active', pane.dataset.pane === name);
  }
  // The readout measures a stage slot, so it can only be filled in once its pane is laid out.
  if (name === 'pictures') window.requestAnimationFrame(updateSlotSizeReadout);
}

/* ---------------- Studio displays (hosting the Now/Next page on the LAN) ---------------- */

let displayState = null;
/** When hosting was switched on, so the firewall warning waits for a grace period. */
let displayOnSince = 0;
let displayRefreshTimer = null;
const DISPLAY_FIREWALL_GRACE_MS = 60000;

function setDisplayStatus(message, isError = false) {
  if (!displayStatusEl) return;
  displayStatusEl.textContent = message;
  displayStatusEl.style.color = isError ? '#ffb1b1' : '#9ea7bc';
}

/** Signature of the rendered rows, so an unchanged list is left alone. */
let displayUrlsSignature = null;

function renderDisplayUrls() {
  if (!displayUrlsEl) return;
  const addresses = displayState?.listening ? displayState.addresses || [] : [];
  // The status poll runs every 4s. Rebuilding identical rows each time would wipe a
  // "Copied" confirmation out from under the operator mid-read, and drop the row they are
  // reaching for. Only touch the DOM when the list actually changed.
  const signature = JSON.stringify(addresses.map((a) => [a.url, a.confirmed, a.detail]));
  if (signature === displayUrlsSignature) return;
  displayUrlsSignature = signature;
  displayUrlsEl.innerHTML = '';
  addresses.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = index === 0 ? 'display-url-row is-best' : 'display-url-row';

    const main = document.createElement('div');
    main.className = 'display-url-main';
    const text = document.createElement('div');
    text.className = 'display-url-text';
    text.textContent = entry.url;
    main.appendChild(text);
    const note = document.createElement('div');
    note.className = 'display-url-note';
    note.textContent = entry.detail || '';
    main.appendChild(note);
    row.appendChild(main);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      revealChrome();
      try {
        await window.lineup.display.copyUrl(entry.url);
        copy.textContent = 'Copied';
        window.setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      } catch {
        copy.textContent = 'Failed';
      }
    });
    row.appendChild(copy);
    displayUrlsEl.appendChild(row);
  });
}

function renderDisplay() {
  if (!btnDisplayToggle) return;
  const state = displayState;
  btnDisplayToggle.textContent = state?.enabled ? 'Turn Off' : 'Turn On';
  if (displayPortInput && document.activeElement !== displayPortInput) {
    displayPortInput.value = state?.port ? String(state.port) : '';
  }

  if (!state?.enabled) {
    setDisplayStatus('Off \u2014 screens around the building can\u2019t see this yet.');
  } else if (state.lastError) {
    setDisplayStatus(state.lastError, true);
  } else if (!state.listening) {
    setDisplayStatus('Starting\u2026');
  } else if (state.mdnsConflict) {
    setDisplayStatus(
      `Another computer is already publishing that name (${state.mdnsConflict}). Use one of the numeric addresses below.`,
      true,
    );
  } else if (state.viewers > 0) {
    // Report devices rather than connections: one machine can briefly hold two streams
    // while a reloaded tab's old connection is still being reaped, and "4 screens watching"
    // when two machines are open is just wrong.
    const screens = state.devices || state.viewers;
    const extra = state.viewers > screens ? ` (${state.viewers} connections)` : '';
    setDisplayStatus(`On \u2014 ${screens} screen${screens === 1 ? '' : 's'} watching${extra}.`);
  } else if (state.everHadViewer) {
    setDisplayStatus('On \u2014 no screens open right now.');
  } else if (displayOnSince && Date.now() - displayOnSince > DISPLAY_FIREWALL_GRACE_MS) {
    // On Windows the firewall prompt fires when the server starts listening, not when a
    // studio first connects — so localhost looks fine here while every other screen times
    // out. A viewer count stuck at zero is the only hint we get; say it plainly.
    setDisplayStatus(
      `On, but no screen has connected yet. If a studio can\u2019t load the page, Windows Firewall on this computer is probably blocking Band Lineup \u2014 it needs to allow TCP port ${state.port} for Private networks.`,
      true,
    );
  } else {
    setDisplayStatus('On \u2014 open one of these on any screen in the building.');
  }

  renderDisplayUrls();
}

async function refreshDisplayStatus() {
  try {
    displayState = await window.lineup.display.status();
  } catch {
    return;
  }
  renderDisplay();
}

function scheduleDisplayRefresh() {
  if (displayRefreshTimer) return;
  displayRefreshTimer = window.setInterval(() => {
    // Only while the edit chrome is up: show mode must stay completely idle.
    if (document.body.classList.contains('chrome-hidden')) return;
    void refreshDisplayStatus();
  }, 4000);
}

async function toggleDisplayHosting() {
  const next = !displayState?.enabled;
  btnDisplayToggle.disabled = true;
  setDisplayStatus(next ? 'Starting\u2026' : 'Stopping\u2026');
  try {
    displayState = await window.lineup.display.setEnabled(next);
    displayOnSince = next ? Date.now() : 0;
  } catch (error) {
    setDisplayStatus(error instanceof Error ? error.message : 'Could not change the display server.', true);
  } finally {
    btnDisplayToggle.disabled = false;
  }
  renderDisplay();
}

async function applyDisplayPort() {
  if (!displayPortInput) return;
  const value = displayPortInput.value.trim();
  if (!value || (displayState && String(displayState.port) === value)) return;
  try {
    displayState = await window.lineup.display.setPort(value);
    renderDisplay();
  } catch (error) {
    setDisplayStatus(error instanceof Error ? error.message : 'Could not change the port.', true);
  }
}

/* ---------------- ProPresenter Now / Next column ---------------- */

function setPpStatus(message, isError = false) {
  if (!ppStatus) return;
  ppStatus.textContent = message;
  ppStatus.style.color = isError ? '#ffb1b1' : '#9ea7bc';
}

function ppItemTypeTag(type) {
  switch (type) {
    case 'media':
      return 'Media';
    case 'audio':
      return 'Audio';
    case 'livevideo':
      return 'Live';
    case 'placeholder':
      return 'PCO';
    default:
      return '';
  }
}

/** Remove any NEXT rows that fall below the visible bottom of the list, so it fills with as many whole items as fit. */
function ppTrimOverflow() {
  if (!ppNextList) return;
  const listRect = ppNextList.getBoundingClientRect();
  if (listRect.height <= 0) return;
  for (const child of Array.from(ppNextList.children)) {
    if (child.getBoundingClientRect().bottom > listRect.bottom + 1) {
      child.remove();
    }
  }
}

function updatePpActiveClass() {
  // Show the column the whole time ProPresenter is connected (enabled), even when idle —
  // the NOW area then shows a "Waiting…"/"Reconnecting…" card. Hidden only after Disconnect.
  document.body.classList.toggle('pp-active', Boolean(ppData?.enabled));
}

/**
 * Scale the NOW title to fill its box: short names stay large, long names shrink to fit.
 * Picks the biggest font size (binary search) at which the text fits within `maxLines`,
 * so titles like "I Know A Name - [ Full ]" and "This Is The Day - [ Full ]" each look right.
 * Falls back to the smallest size and just wraps if a name is too long even at the minimum.
 */
function fitNowTitle(el, { min = 17, max = 40, maxLines = 2 } = {}) {
  const lineHeight = 1.1; // keep in sync with .pp-now-name line-height in styles.css
  // Wrap only at spaces; never split a word (the "Promis / ed Land" bug). An over-wide word
  // then overflows horizontally, which the width check below rejects, forcing a smaller size.
  el.style.whiteSpace = 'normal';
  el.style.overflowWrap = 'normal';
  el.style.wordBreak = 'normal';
  el.style.hyphens = 'none';
  const fits = (size) => {
    el.style.fontSize = `${size}px`;
    const allowedHeight = Math.ceil(size * lineHeight * maxLines) + 1;
    return el.scrollHeight <= allowedHeight && el.scrollWidth <= el.clientWidth + 1;
  };
  if (fits(max)) { el.style.fontSize = `${max}px`; return; }
  let lo = min;
  let hi = max;
  let best = min;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  el.style.fontSize = `${best}px`;
  // Last resort for a single word too wide even at min: allow it to break rather than spill.
  if (best === min && el.scrollWidth > el.clientWidth + 1) {
    el.style.overflowWrap = 'anywhere';
    el.style.wordBreak = 'break-word';
  }
}

/**
 * Tidy an item name for display only (the raw name is kept for ProPresenter matching).
 * Strips arrangement/section tags in brackets ([ Full ], ( TAG ), { ... }), a leading date
 * code (e.g. "260607 "), separator dashes, and any leftover edge punctuation/whitespace so the
 * card reads as cleanly as possible — "260607 Taking Thoughts Captive - [ Full ]" → "Taking Thoughts Captive".
 */
function cleanItemName(raw) {
  const original = String(raw || '').trim();
  let s = original;
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ');        // drop [..], (..), {..} tags
  s = s.replace(/^\s*\d{6,8}\b[\s\-–—:.]*/, '');       // drop a leading 6–8 digit date code
  s = s.replace(/\s[-–—]+\s/g, ' ');                   // drop " - " style separators
  s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '');     // trim edge dashes/colons/dots/space
  s = s.replace(/\s{2,}/g, ' ').trim();                // collapse runs of whitespace
  return s || original; // never blank out a title (e.g. a name that was only a tag)
}

function renderPpNow() {
  ppNow.innerHTML = '';
  const data = ppData;

  if (data?.needsPlaylist) {
    const prompt = document.createElement('div');
    prompt.className = 'pp-waiting';
    prompt.textContent = 'Pick your playlist in settings →';
    ppNow.appendChild(prompt);
    return;
  }

  const activeItem = data && data.activeIndex >= 0 ? data.items[data.activeIndex] : null;
  const name = activeItem?.name || data?.activePresentationName || '';

  if (!name) {
    const waiting = document.createElement('div');
    waiting.className = 'pp-waiting';
    waiting.textContent = data?.reachable ? 'Nothing on screen' : 'Reconnecting…';
    ppNow.appendChild(waiting);
    if (data?.lastError) {
      const errEl = document.createElement('div');
      errEl.className = 'pp-error';
      errEl.textContent = data.lastError;
      ppNow.appendChild(errEl);
    }
    return;
  }

  const label = document.createElement('div');
  label.className = 'pp-now-label';
  label.textContent = 'Now';
  ppNow.appendChild(label);

  const nameEl = document.createElement('div');
  nameEl.className = 'pp-now-name';
  nameEl.textContent = cleanItemName(name);
  ppNow.appendChild(nameEl);
  fitNowTitle(nameEl);

  const total = data.currentSlideTotal || activeItem?.slideCount || 0;
  const current = data.currentSlide || 0;
  if (total > 0 || current > 0) {
    const meta = document.createElement('div');
    meta.className = 'pp-now-meta';
    if (total > 0 && current > 0) {
      const remaining = Math.max(0, total - current);
      meta.textContent = `Slide ${current} / ${total} · ${remaining} left`;
    } else if (total > 0) {
      meta.textContent = `${total} slides`;
    } else {
      meta.textContent = `Slide ${current}`;
    }
    ppNow.appendChild(meta);

    if (total > 0) {
      const progress = document.createElement('div');
      progress.className = 'pp-progress';
      const fill = document.createElement('div');
      fill.className = 'pp-progress-fill';
      const pct = current > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      progress.appendChild(fill);
      ppNow.appendChild(progress);
    }
  }
}

function renderPpNext() {
  ppNextList.innerHTML = '';
  const data = ppData;
  const items = Array.isArray(data?.items) ? data.items : [];
  // When presenting from the playlist we list everything after the active item; when
  // presenting from the Library (activeIndex < 0) we show the whole upcoming playlist.
  const from = data && data.activeIndex >= 0 ? data.activeIndex + 1 : 0;
  const upcoming = [];
  for (let i = from; i < items.length; i += 1) {
    if (!items[i].isHidden) upcoming.push(items[i]);
  }

  for (const item of upcoming) {
    if (item.type === 'header') {
      const headerEl = document.createElement('div');
      headerEl.className = 'pp-next-item is-header';
      const headerName = document.createElement('div');
      headerName.className = 'pp-next-name';
      headerName.textContent = cleanItemName(item.name || '');
      headerEl.appendChild(headerName);
      ppNextList.appendChild(headerEl);
      continue;
    }

    const itemEl = document.createElement('div');
    itemEl.className = 'pp-next-item';
    const nameEl = document.createElement('div');
    nameEl.className = 'pp-next-name';
    nameEl.textContent = cleanItemName(item.name) || '(untitled)';
    itemEl.appendChild(nameEl);

    if (item.type === 'presentation' && Number.isInteger(item.slideCount)) {
      const chip = document.createElement('div');
      chip.className = 'pp-count-chip';
      chip.textContent = String(item.slideCount);
      itemEl.appendChild(chip);
    } else {
      const tag = ppItemTypeTag(item.type);
      if (tag) {
        const tagEl = document.createElement('div');
        tagEl.className = 'pp-type-tag';
        tagEl.textContent = tag;
        itemEl.appendChild(tagEl);
      }
    }
    ppNextList.appendChild(itemEl);
  }

  ppNextLabel.style.display = upcoming.length ? '' : 'none';
  window.requestAnimationFrame(ppTrimOverflow);
}

function renderProPresenterColumn() {
  if (!ppColumn || !ppNow || !ppNextList) return;
  ppPlaylistName.textContent = ppData?.playlistName || '';
  renderPpNow();
  renderPpNext();
}

function openPpModal() {
  ppModal.classList.remove('hidden');
  ppHostInput.focus();
  ppHostInput.select();
}

function closePpModal() {
  ppModal.classList.add('hidden');
  ppPasswordInput.value = '';
}

async function connectProPresenter() {
  const host = ppHostInput.value.trim();
  const port = ppPortInput.value.trim();
  const password = ppPasswordInput.value;
  if (!host || !port) {
    setPpStatus('Enter the ProPresenter host and port.', true);
    return;
  }
  ppSaveButton.disabled = true;
  setPpStatus('Connecting to ProPresenter…');
  try {
    await window.lineup.proPresenter.connect({ host, port, password });
    closePpModal();
    if (ppPlaylistSelect) ppPlaylistSelect.style.display = 'none';
    setPpStatus(`Connected to ProPresenter at ${host}:${port}. Auto-following the live playlist.`);
  } catch (error) {
    setPpStatus(error instanceof Error ? error.message : 'Could not connect to ProPresenter.', true);
  } finally {
    ppSaveButton.disabled = false;
  }
}

async function disconnectProPresenter() {
  try {
    await window.lineup.proPresenter.disconnect();
    if (ppPlaylistSelect) ppPlaylistSelect.value = '';
    setPpStatus('ProPresenter disconnected.');
  } catch (error) {
    setPpStatus(error instanceof Error ? error.message : 'Could not disconnect ProPresenter.', true);
  }
}

async function refreshPpPlaylists() {
  if (!ppPlaylistSelect) return;
  let playlists = [];
  let selected = '';
  try {
    playlists = await window.lineup.proPresenter.listPlaylists();
    const info = await window.lineup.proPresenter.status();
    selected = info?.playlistUuid || '';
  } catch {
    playlists = [];
  }
  ppPlaylistSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose playlist';
  ppPlaylistSelect.appendChild(placeholder);
  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    const option = document.createElement('option');
    option.value = playlist.uuid;
    option.textContent = playlist.group ? `${playlist.group} / ${playlist.name}` : playlist.name;
    option.dataset.name = playlist.name || '';
    ppPlaylistSelect.appendChild(option);
  }
  ppPlaylistSelect.value = selected;
}

btnAdd.addEventListener('click', async () => {
  revealChrome();
  const added = await window.lineup.addImagesDialog();
  await importNewPeople(added);
});

btnPcoConnect.addEventListener('click', () => {
  revealChrome();
  openPcoModal();
});

btnPcoAddPosition.addEventListener('click', () => {
  revealChrome();
  const selectedKey = pcoPositionOptionSelect.value;
  if (!selectedKey) {
    setPcoStatus('Choose a position to add.', true);
    return;
  }
  const option = pcoPositionOptions.find((entry) => entry.key === selectedKey);
  if (!option) return;
  pcoDisplayPositions.push({
    teamName: option.teamName,
    positionName: option.positionName,
    count: 1,
  });
  renderPcoDisplayPositions();
  scheduleSave();
  setPcoStatus(`Added ${option.positionName} from ${option.teamName}.`);
});

btnPcoSync.addEventListener('click', () => {
  revealChrome();
  void syncUpcomingPlanFromPco();
});

btnPcoDisconnect.addEventListener('click', async () => {
  revealChrome();
  setPcoControlsEnabled(false);
  try {
    await window.lineup.pcoDisconnect();
    pcoServiceTypeId = '';
    pcoPositionOptions = [];
    pcoServiceTypeSelect.innerHTML = '<option value="">Choose service type</option>';
    renderPcoPositionOptions();
    scheduleSave();
    setPcoStatus('Planning Center disconnected.');
  } catch (error) {
    setPcoStatus(error instanceof Error ? error.message : 'Could not disconnect Planning Center.', true);
  } finally {
    setPcoControlsEnabled(true);
  }
});

pcoServiceTypeSelect.addEventListener('change', () => {
  pcoServiceTypeId = pcoServiceTypeSelect.value;
  void refreshPcoPositionOptions();
  scheduleSave();
});

btnApplyLayout.addEventListener('click', () => {
  revealChrome();
  void applyLayoutChange();
});

btnToggleParallax.addEventListener('click', () => {
  revealChrome();
  parallaxEnabled = !parallaxEnabled;
  syncParallaxToggle();
  void renderStage();
  scheduleSave();
});

for (const input of [inputLayoutCols, inputLayoutRows]) {
  input.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lastPointerType === 'touch') {
      e.preventDefault();
      openNumberModal(input);
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void applyLayoutChange();
    }
  });
}

toolbar.addEventListener('pointerenter', () => {
  revealChrome();
});

toolbar.addEventListener('pointerleave', () => {
  noteActivity();
});

toolbar.addEventListener('focusin', () => {
  revealChrome();
});

toolbar.addEventListener('focusout', () => {
  window.setTimeout(() => {
    noteActivity();
  }, 0);
});

libraryPanel.addEventListener('pointerenter', () => {
  revealChrome();
});

libraryPanel.addEventListener('pointerleave', () => {
  noteActivity();
});

libraryPanel.addEventListener('focusin', () => {
  revealChrome();
});

libraryPanel.addEventListener('focusout', () => {
  window.setTimeout(() => {
    noteActivity();
  }, 0);
});

window.lineup.onMenuAddPhotos(() => {
  btnAdd.click();
});

btnFullscreen.addEventListener('click', () => {
  revealChrome();
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
});

document.addEventListener('fullscreenchange', () => {
  noteActivity();
  window.requestAnimationFrame(updateSlotSizeReadout);
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  noteActivity();
  e.dataTransfer.dropEffect = e.dataTransfer.types.includes('Files') ? 'copy' : 'move';
  if (e.dataTransfer.types.includes('Files')) dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  if (!dropZone.contains(/** @type {Node} */ (e.relatedTarget))) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  noteActivity();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files || []).filter((file) => file.type.startsWith('image/'));
  if (!files.length) return;
  const paths = files.map((file) => file.path).filter(Boolean);
  if (!paths.length) return;
  const added = await window.lineup.addImagesPaths(paths);
  await importNewPeople(added);
});

function buildVirtualKeyboard() {
  const root = document.getElementById('vkeyboard');
  if (!root) return;
  root.innerHTML = '';

  for (const keys of VK_ROWS) {
    const rowEl = document.createElement('div');
    rowEl.className = 'vk-row';
    for (const key of keys) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vk-key';
      button.textContent = key;
      button.dataset.ch = key;
      rowEl.appendChild(button);
    }
    root.appendChild(rowEl);
  }

  const actionsRow = document.createElement('div');
  actionsRow.className = 'vk-row';

  const space = document.createElement('button');
  space.type = 'button';
  space.className = 'vk-key space';
  space.textContent = 'Space';
  space.dataset.action = 'space';

  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'vk-key wide';
  erase.textContent = 'Erase';
  erase.dataset.action = 'erase';

  actionsRow.appendChild(space);
  actionsRow.appendChild(erase);
  root.appendChild(actionsRow);

  root.addEventListener('click', (e) => {
    const button = e.target.closest('.vk-key');
    if (!button) return;
    noteActivity();
    e.preventDefault();
    const action = button.dataset.action;
    if (action === 'space') {
      labelInput.value += ' ';
      return;
    }
    if (action === 'erase') {
      labelInput.value = labelInput.value.slice(0, -1);
      return;
    }
    const ch = button.dataset.ch;
    if (ch) labelInput.value += ch;
  });
}

function buildNumberKeyboard() {
  if (!numberKeyboard) return;
  numberKeyboard.innerHTML = '';

  const rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']];
  for (const keys of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'vk-row';
    for (const key of keys) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vk-key wide';
      button.textContent = key;
      button.dataset.ch = key;
      rowEl.appendChild(button);
    }
    numberKeyboard.appendChild(rowEl);
  }

  const lastRow = document.createElement('div');
  lastRow.className = 'vk-row';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'vk-key wide';
  clear.textContent = 'Clear';
  clear.dataset.action = 'clear';

  const zero = document.createElement('button');
  zero.type = 'button';
  zero.className = 'vk-key wide';
  zero.textContent = '0';
  zero.dataset.ch = '0';

  const erase = document.createElement('button');
  erase.type = 'button';
  erase.className = 'vk-key wide';
  erase.textContent = 'Erase';
  erase.dataset.action = 'erase';

  lastRow.appendChild(clear);
  lastRow.appendChild(zero);
  lastRow.appendChild(erase);
  numberKeyboard.appendChild(lastRow);

  numberKeyboard.addEventListener('click', (e) => {
    const button = e.target.closest('.vk-key');
    if (!button) return;
    noteActivity();
    e.preventDefault();
    const action = button.dataset.action;
    if (action === 'clear') {
      numberInput.value = '';
      return;
    }
    if (action === 'erase') {
      numberInput.value = numberInput.value.slice(0, -1);
      return;
    }
    const ch = button.dataset.ch;
    if (ch) {
      const nextValue = `${numberInput.value}${ch}`.replace(/^0+(?=\d)/, '');
      numberInput.value = nextValue;
    }
  });
}

function openNumberModal(input, options = {}) {
  numericEditTarget = input;
  numericEditCommit = typeof options.onCommit === 'function' ? options.onCommit : null;
  numericEditMin = Number.isFinite(options.min) ? options.min : 1;
  numericEditMax = Number.isFinite(options.max) ? options.max : Number.POSITIVE_INFINITY;
  numericEditOnInvalid = typeof options.onInvalid === 'function' ? options.onInvalid : null;
  numberModalTitle.textContent = options.title || (input === inputLayoutCols ? 'Columns' : 'Rows');
  numberInput.value = input.value || '';
  numberModal.classList.remove('hidden');
  revealChrome();
}

function closeNumberModal() {
  numberModal.classList.add('hidden');
  numericEditTarget = null;
  numericEditCommit = null;
  numericEditMin = 1;
  numericEditMax = Number.POSITIVE_INFINITY;
  numericEditOnInvalid = null;
  scheduleChromeHide();
}

async function commitNumberModal() {
  if (!numericEditTarget) {
    closeNumberModal();
    return;
  }
  const parsed = Number.parseInt(numberInput.value, 10);
  const commit = numericEditCommit;

  if (commit) {
    // A bounded field REFUSES a bad entry rather than coercing it. The grid's historic
    // floor-of-1 is harmless for Cols/Rows, but silently turning a cleared keypad into
    // port 1 would restart the live display server on a port nobody typed and kill every
    // bookmark in the building.
    const min = numericEditMin;
    const max = numericEditMax;
    const onInvalid = numericEditOnInvalid;
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      closeNumberModal();
      if (onInvalid) onInvalid(`Enter a number between ${min} and ${max}.`);
      return;
    }
    numericEditTarget.value = String(parsed);
    closeNumberModal();
    await commit(parsed);
    return;
  }

  const safeValue = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  numericEditTarget.value = String(safeValue);
  closeNumberModal();
  await applyLayoutChange();
}

function openLabelModal(edit) {
  labelEdit = edit;
  if (edit.type === 'name') {
    const person = edit.personId ? getPerson(edit.personId) : null;
    if (!person) return;
    labelTitle.textContent = 'Band member name';
    labelInput.placeholder = 'Enter band member name';
    labelInput.value = person.lastName || '';
  } else if (edit.type === 'slotName') {
    labelTitle.textContent = 'Stage position name';
    labelInput.placeholder = 'Enter stage name';
    labelInput.value = slotNameMemory[edit.slotIndex] || '';
  } else {
    const slot = stageSlots[edit.slotIndex];
    if (!slot) return;
    labelTitle.textContent = 'Mic / pack label';
    labelInput.placeholder = 'Enter mic / pack';
    labelInput.value = slot.label || '';
  }

  labelModal.classList.remove('hidden');
  labelInput.focus();
  labelInput.select();
}

function closeLabelModal() {
  labelModal.classList.add('hidden');
  labelEdit = { type: 'slotLabel', personId: null, slotIndex: -1 };
  labelInput.blur();
  scheduleChromeHide();
}

async function commitLabelModal() {
  const currentEdit = { ...labelEdit };
  const value = labelInput.value.trim();
  if (currentEdit.type === 'name') {
    const person = currentEdit.personId ? getPerson(currentEdit.personId) : null;
    if (person) {
      person.lastName = value;
    }
  } else if (currentEdit.type === 'slotName') {
    if (currentEdit.slotIndex >= 0 && currentEdit.slotIndex < getStageSlotCount()) {
      slotNameMemory[currentEdit.slotIndex] = value;
    }
  } else if (currentEdit.slotIndex >= 0 && currentEdit.slotIndex < getStageSlotCount()) {
    stageSlots[currentEdit.slotIndex].label = value;
    slotLabelMemory[currentEdit.slotIndex] = value;
  }

  closeLabelModal();
  if (currentEdit.type === 'name') {
    const slotIndex = currentEdit.personId ? findStageIndexByPersonId(currentEdit.personId) : -1;
    if (slotIndex >= 0) {
      await renderStage([slotIndex]);
    }
  } else if (currentEdit.type === 'slotName' && currentEdit.slotIndex >= 0) {
    await renderStage([currentEdit.slotIndex]);
  } else if (currentEdit.slotIndex >= 0) {
    await renderStage([currentEdit.slotIndex]);
  } else {
    await renderStage();
  }
  scheduleSave();
}

labelDone.addEventListener('click', () => void commitLabelModal());
labelCancel.addEventListener('click', () => closeLabelModal());
labelBackdrop.addEventListener('click', () => closeLabelModal());
numberDone.addEventListener('click', () => void commitNumberModal());
numberCancel.addEventListener('click', () => closeNumberModal());
numberBackdrop.addEventListener('click', () => closeNumberModal());
pcoSaveButton.addEventListener('click', () => void connectPlanningCenter());
pcoCancelButton.addEventListener('click', () => closePcoModal());
pcoModalBackdrop.addEventListener('click', () => closePcoModal());

btnPpConnect.addEventListener('click', () => {
  revealChrome();
  openPpModal();
});
btnPpDisconnect.addEventListener('click', () => {
  revealChrome();
  void disconnectProPresenter();
});
if (btnDisplayToggle) {
  btnDisplayToggle.addEventListener('click', () => {
    revealChrome();
    void toggleDisplayHosting();
  });
}

if (displayPortInput) {
  displayPortInput.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lastPointerType === 'touch') {
      e.preventDefault();
      openNumberModal(displayPortInput, {
        title: 'Display port',
        min: 1024,
        max: 65535,
        onCommit: () => applyDisplayPort(),
        onInvalid: (message) => setDisplayStatus(message, true),
      });
    }
  });
  displayPortInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void applyDisplayPort();
    }
  });
  displayPortInput.addEventListener('blur', () => {
    if (suppressPortCommit) {
      // A tab switch took the focus, not the operator. Put the running value back.
      displayPortInput.value = displayState?.port ? String(displayState.port) : '';
      return;
    }
    // Committing whatever is in the box on blur would restart the server on a half-typed
    // port ("76" on the way to "7654"). Apply only a value that is actually usable; put
    // anything else back so the field never disagrees with the running server.
    const parsed = Number.parseInt(displayPortInput.value.trim(), 10);
    if (Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535) {
      void applyDisplayPort();
      return;
    }
    displayPortInput.value = displayState?.port ? String(displayState.port) : '';
  });
}

ppSaveButton.addEventListener('click', () => void connectProPresenter());
ppCancelButton.addEventListener('click', () => closePpModal());
ppModalBackdrop.addEventListener('click', () => closePpModal());

if (ppPlaylistSelect) {
  ppPlaylistSelect.addEventListener('change', () => {
    revealChrome();
    const uuid = ppPlaylistSelect.value;
    const option = ppPlaylistSelect.selectedOptions[0];
    const name = option ? option.dataset.name || option.textContent || '' : '';
    void window.lineup.proPresenter.selectPlaylist({ uuid, name });
    setPpStatus(uuid ? `Showing playlist: ${name}` : 'Choose a playlist to display.');
  });
}

for (const input of [ppHostInput, ppPortInput, ppPasswordInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void connectProPresenter();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePpModal();
    }
  });
}

// Re-fit the Now/Next list whenever the column's size changes: window resize,
// fullscreen toggle, or the column becoming visible when entering show mode.
if (ppColumn && typeof ResizeObserver !== 'undefined') {
  // Re-render only when the column actually changes size (window/show-mode), not in reaction
  // to our own content writes — otherwise the fitted title can oscillate.
  let lastW = 0;
  let lastH = 0;
  let pending = false;
  const ppResizeObserver = new ResizeObserver(() => {
    const w = Math.round(ppColumn.clientWidth);
    const h = Math.round(ppColumn.clientHeight);
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      renderProPresenterColumn();
    });
  });
  ppResizeObserver.observe(ppColumn);
}

labelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void commitLabelModal();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeLabelModal();
  }
});

numberInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void commitNumberModal();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeNumberModal();
  }
});

for (const input of [pcoClientIdInput, pcoSecretInput]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void connectPlanningCenter();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePcoModal();
    }
  });
}

for (const eventName of ['keydown', 'wheel']) {
  window.addEventListener(
    eventName,
    () => {
      noteActivity();
    },
    { passive: true },
  );
}

window.addEventListener(
  'resize',
  () => {
    window.requestAnimationFrame(updateSlotSizeReadout);
  },
  { passive: true },
);

dropZone.addEventListener('click', (e) => {
  handleChromeToggleSurfaceClick(e, 'stage-surface');
});

if (libraryTabs) {
  libraryTabs.addEventListener('click', (e) => {
    const tab = e.target instanceof HTMLElement ? e.target.closest('.lib-tab') : null;
    if (!tab) return;
    // Keep this away from the panel's double-tap show-mode toggle below.
    e.stopPropagation();
    revealChrome();
    activatePanelTab(tab.dataset.tab);
  });
}

libraryPanel.addEventListener('click', (e) => {
  handleChromeToggleSurfaceClick(e, 'library-surface');
});

buildVirtualKeyboard();
buildNumberKeyboard();

(async function init() {
  const data = await window.lineup.loadState();
  applyLoadedState(data);
  await renderAll();
  try {
    const status = await window.lineup.pcoStatus();
    if (status?.connected) {
      if (!pcoServiceTypeId && typeof status.pcoServiceTypeId === 'string') {
        pcoServiceTypeId = status.pcoServiceTypeId;
      }
      if (!pcoDisplayPositions.length && Array.isArray(status.pcoDisplayPositions)) {
        pcoDisplayPositions = status.pcoDisplayPositions
          .map((entry) => normalizePcoDisplayPosition(entry))
          .filter((entry) => entry.teamName && entry.positionName);
        renderPcoDisplayPositions();
      }
      await refreshPcoServiceTypes();
      pcoServiceTypeSelect.value = pcoServiceTypeId || '';
      await refreshPcoPositionOptions();
      setPcoStatus(
        pcoServiceTypeId
          ? 'Planning Center connected.'
          : 'Planning Center connected. Choose a service type.',
      );
    } else {
      setPcoStatus('Planning Center is not connected.');
    }
  } catch (error) {
    setPcoStatus(error instanceof Error ? error.message : 'Planning Center is unavailable.', true);
  }

  window.lineup.proPresenter.onData((incoming) => {
    ppData = incoming;
    updatePpActiveClass();
    renderProPresenterColumn();
  });
  try {
    const ppInfo = await window.lineup.proPresenter.status();
    if (ppInfo?.host) ppHostInput.value = ppInfo.host;
    if (ppInfo?.port) ppPortInput.value = String(ppInfo.port);
    if (ppPlaylistSelect) ppPlaylistSelect.style.display = 'none'; // auto-follow: no manual picker
    if (ppInfo?.enabled) {
      setPpStatus(`Connected to ProPresenter at ${ppInfo.host}:${ppInfo.port}. Auto-following the live playlist.`);
      await window.lineup.proPresenter.start();
    } else {
      setPpStatus('ProPresenter is not connected.');
    }
  } catch (error) {
    setPpStatus(error instanceof Error ? error.message : 'ProPresenter is unavailable.', true);
  }

  try {
    const info = await window.lineup.appVersion();
    if (appVersionEl && info?.version) {
      appVersionEl.textContent = info.build ? `v${info.version} · build ${info.build}` : `v${info.version}`;
    }
  } catch {
    /* label just stays empty */
  }

  await refreshDisplayStatus();
  if (displayState?.enabled) displayOnSince = Date.now();
  scheduleDisplayRefresh();

  exitChromeEditMode();
})();
}
