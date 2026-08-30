const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const sharp = require('sharp');
const {
  createProPresenterClient,
  clearedViewModel: ppClearedViewModel,
} = require('./propresenter-core');
// Require the exact file, never the directory: propresenter-app/package.json declares the
// standalone kiosk wrapper as its main, so a bare directory require would start a second
// Electron app instead of the server.
const {
  createDisplayServer,
  DEFAULT_PORT: DEFAULT_DISPLAY_PORT,
} = require('./propresenter-app/server');

let mainWindow;
const DEFAULT_COLUMNS = 7;
const DEFAULT_ROWS = 2;
const PCO_API_BASE = 'https://api.planningcenteronline.com';
const ALLOWED_PCO_TEAM_KEYWORDS = ['communication', 'band', 'production'];
/** Default ProPresenter network API port (user-configurable in ProPresenter ▸ Preferences ▸ Network). */
const DEFAULT_PP_PORT = 1025;
/** How often to poll ProPresenter for playlist/slide changes while connected. */
const PP_POLL_MS = 600;
/** Slower retry cadence when ProPresenter is unreachable. */
const PP_RETRY_MS = 2500;
/** Long-edge cap when baking parallax layers (depth/segmentation). Higher = sharper on 4K; bump PARALLAX_VERSION when changing. */
const PARALLAX_MAX_DIMENSION = 3072;
const PARALLAX_VERSION = 10;
let depthEstimatorPromise = null;
let backgroundRemoverPromise = null;
const parallaxTaskCache = new Map();

function normalizeLayout(layout) {
  const columns = Number.parseInt(String(layout?.columns ?? DEFAULT_COLUMNS), 10);
  const rows = Number.parseInt(String(layout?.rows ?? DEFAULT_ROWS), 10);
  return {
    columns: Number.isFinite(columns) && columns > 0 ? columns : DEFAULT_COLUMNS,
    rows: Number.isFinite(rows) && rows > 0 ? rows : DEFAULT_ROWS,
  };
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function imagesDir() {
  return path.join(app.getPath('userData'), 'images');
}

function processedDir() {
  return path.join(app.getPath('userData'), 'processed');
}

function modelCacheDir() {
  return path.join(app.getPath('userData'), 'model-cache');
}

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function pcoCredentialsPath() {
  return path.join(app.getPath('userData'), 'pco-credentials.json');
}

async function ensureDirs() {
  await fs.mkdir(imagesDir(), { recursive: true });
  await fs.mkdir(processedDir(), { recursive: true });
  await fs.mkdir(modelCacheDir(), { recursive: true });
}

function encodeStoredSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(text).toString('base64')}`;
  }
  return `plain:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function decodeStoredSecret(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (raw.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
  }
  if (raw.startsWith('plain:')) {
    return Buffer.from(raw.slice(6), 'base64').toString('utf8');
  }
  return raw;
}

async function loadPcoCredentials() {
  try {
    const raw = JSON.parse(await fs.readFile(pcoCredentialsPath(), 'utf8'));
    const clientId = decodeStoredSecret(raw.clientId);
    const secret = decodeStoredSecret(raw.secret);
    if (!clientId || !secret) return null;
    return { clientId, secret };
  } catch {
    return null;
  }
}

async function savePcoCredentials(credentials) {
  await ensureDirs();
  await fs.writeFile(
    pcoCredentialsPath(),
    JSON.stringify(
      {
        clientId: encodeStoredSecret(credentials.clientId),
        secret: encodeStoredSecret(credentials.secret),
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function clearPcoCredentials() {
  try {
    await fs.unlink(pcoCredentialsPath());
  } catch {
    /* already gone */
  }
}

function ppCredentialsPath() {
  return path.join(app.getPath('userData'), 'propresenter-credentials.json');
}

async function loadPpPassword() {
  try {
    const raw = JSON.parse(await fs.readFile(ppCredentialsPath(), 'utf8'));
    return decodeStoredSecret(raw.password) || '';
  } catch {
    return '';
  }
}

async function savePpPassword(password) {
  if (!password) {
    await clearPpPassword();
    return;
  }
  await ensureDirs();
  await fs.writeFile(
    ppCredentialsPath(),
    JSON.stringify({ password: encodeStoredSecret(password) }, null, 2),
    'utf8',
  );
}

async function clearPpPassword() {
  try {
    await fs.unlink(ppCredentialsPath());
  } catch {
    /* already gone */
  }
}

function randomName(originalPath) {
  const ext = path.extname(originalPath) || '.jpg';
  return `${crypto.randomBytes(16).toString('hex')}${ext}`;
}

function originalDisplayName(sourcePath) {
  return path.parse(sourcePath).name;
}

async function copyImageToStore(sourcePath) {
  await ensureDirs();
  const destName = randomName(sourcePath);
  const dest = path.join(imagesDir(), destName);
  await fs.copyFile(sourcePath, dest);
  return destName;
}

function processedBaseName(fileName) {
  return path.join(processedDir(), path.parse(fileName).name);
}

function pcoUserAgent() {
  return `Band Lineup/${app.getVersion()} (desktop sync)`;
}

function pcoAuthHeader(credentials) {
  return `Basic ${Buffer.from(`${credentials.clientId}:${credentials.secret}`, 'utf8').toString('base64')}`;
}

function buildPcoUrl(target, searchParams) {
  const url = new URL(target.startsWith('http') ? target : `${PCO_API_BASE}${target}`);
  for (const [key, value] of Object.entries(searchParams || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function pcoRequestJson(target, credentials, searchParams) {
  const url = buildPcoUrl(target, searchParams);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: pcoAuthHeader(credentials),
      'User-Agent': pcoUserAgent(),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail =
      payload?.errors?.map((entry) => entry.detail || entry.title).filter(Boolean).join(' | ') ||
      payload?.error ||
      `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return payload || { data: [] };
}

async function pcoFetchAll(target, credentials, searchParams) {
  let nextUrl = buildPcoUrl(target, searchParams).toString();
  const data = [];
  const included = [];
  const seenIncluded = new Set();
  while (nextUrl) {
    const payload = await pcoRequestJson(nextUrl, credentials);
    if (Array.isArray(payload.data)) {
      data.push(...payload.data);
    } else if (payload.data) {
      data.push(payload.data);
    }
    if (Array.isArray(payload.included)) {
      for (const item of payload.included) {
        const key = `${item?.type || ''}:${item?.id || ''}`;
        if (!key || seenIncluded.has(key)) continue;
        seenIncluded.add(key);
        included.push(item);
      }
    }
    nextUrl = typeof payload?.links?.next === 'string' && payload.links.next ? payload.links.next : '';
  }
  return { data, included };
}

function emptyState() {
  return {
    library: [],
    layout: { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS },
    parallaxEnabled: true,
    slotLabels: [],
    slotNames: [],
    lineup: [],
    pcoServiceTypeId: '',
    pcoDisplayPositions: [],
    proPresenter: { enabled: false, host: '', port: 0, playlistUuid: '', playlistName: '' },
    displayServer: { enabled: false, port: DEFAULT_DISPLAY_PORT },
  };
}

/** Whether we host the Now/Next display for other screens, and on which port. */
function normalizeDisplayServerConfig(entry) {
  const portNum = Number.parseInt(String(entry?.port ?? ''), 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : DEFAULT_DISPLAY_PORT;
  return { enabled: Boolean(entry?.enabled), port };
}

function normalizeProPresenterConfig(entry) {
  const host = String(entry?.host || '').trim();
  const portNum = Number.parseInt(String(entry?.port ?? ''), 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 0;
  return {
    enabled: Boolean(entry?.enabled) && Boolean(host) && Boolean(port),
    host,
    port,
    playlistUuid: String(entry?.playlistUuid || ''),
    playlistName: String(entry?.playlistName || ''),
  };
}

function normalizeSavedLibraryPerson(person) {
  return {
    id: String(person.id),
    fileName: String(person.fileName),
    originalName: typeof person.originalName === 'string' && person.originalName.trim() ? person.originalName.trim() : '',
    lastLabel: typeof person.lastLabel === 'string' ? person.lastLabel : '',
    lastName: typeof person.lastName === 'string' ? person.lastName : '',
    source: person?.source === 'pco' ? 'pco' : 'local',
    pcoPersonId: typeof person?.pcoPersonId === 'string' ? person.pcoPersonId : '',
    pcoPlanPersonId: typeof person?.pcoPlanPersonId === 'string' ? person.pcoPlanPersonId : '',
  };
}

function normalizeTeamName(value) {
  return String(value || '').trim().toLowerCase();
}

function isAllowedPcoTeamName(value) {
  const normalized = normalizeTeamName(value);
  return ALLOWED_PCO_TEAM_KEYWORDS.some((keyword) => normalized === keyword || normalized.includes(keyword));
}

function normalizePcoLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePcoToken(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized) return '';
  if (/^\d+$/.test(normalized)) return '';
  if (['mix', 'mic', 'slot', 'channel', 'ch', 'pack', 'wireless', 'input'].includes(normalized)) return '';
  if (['vox', 'vocal', 'vocalist', 'vocalists', 'vocals', 'singer', 'singers'].includes(normalized)) return 'vocals';
  if (['keys', 'keyboard', 'keyboards'].includes(normalized)) return 'keys';
  if (['drum', 'drums', 'drummer', 'drummers'].includes(normalized)) return 'drums';
  if (['perc', 'percussionist', 'percussionists'].includes(normalized)) return 'percussion';
  if (['gtr', 'guitar', 'guitars'].includes(normalized)) return 'guitar';
  if (['electric', 'electricguitar'].includes(normalized)) return 'electric';
  if (['acoustic', 'acousticguitar'].includes(normalized)) return 'acoustic';
  if (['b', 'bandleader', 'leader', 'lead'].includes(normalized)) return normalized === 'b' ? '' : 'leader';
  if (['worship', 'calltoworship'].includes(normalized)) return normalized === 'calltoworship' ? 'call' : normalized;
  if (normalized.endsWith('s') && normalized.length > 4) return normalized.slice(0, -1);
  return normalized;
}

function normalizedPcoLabelTokens(value) {
  const normalized = normalizePcoLabel(value);
  if (!normalized) return [];
  const tokens = normalized
    .split(' ')
    .map((token) => normalizePcoToken(token))
    .filter(Boolean);
  if (!tokens.length && normalized) return [normalized];
  return [...new Set(tokens)];
}

function scorePcoLabelMatch(slotLabel, positionLabel) {
  const slotNormalized = normalizePcoLabel(slotLabel);
  const positionNormalized = normalizePcoLabel(positionLabel);
  if (!slotNormalized || !positionNormalized) return 0;
  if (slotNormalized === positionNormalized) return 120;
  if (slotNormalized.includes(positionNormalized) || positionNormalized.includes(slotNormalized)) return 95;

  const slotTokens = normalizedPcoLabelTokens(slotLabel);
  const positionTokens = normalizedPcoLabelTokens(positionLabel);
  if (!slotTokens.length || !positionTokens.length) return 0;

  const positionSet = new Set(positionTokens);
  const slotSet = new Set(slotTokens);
  const overlap = slotTokens.filter((token) => positionSet.has(token));
  if (!overlap.length) return 0;

  const overlapCount = overlap.length;
  const slotCoverage = overlapCount / slotSet.size;
  const positionCoverage = overlapCount / positionSet.size;
  const sharedPhrase = overlap.join(' ');

  let score = Math.round(slotCoverage * 70 + positionCoverage * 20 + overlapCount * 4);
  if (slotCoverage === 1) score += 18;
  if (positionCoverage === 1) score += 10;
  if (sharedPhrase && slotNormalized.includes(sharedPhrase) && positionNormalized.includes(sharedPhrase)) score += 8;
  return score;
}

function findBestPcoMemberForSlot(slotLabel, availableMembers) {
  let bestIndex = -1;
  let bestScore = 0;
  for (let i = 0; i < availableMembers.length; i += 1) {
    const member = availableMembers[i];
    const score = scorePcoLabelMatch(slotLabel, member.label);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  if (bestIndex < 0 || bestScore < 60) return null;
  return {
    member: availableMembers.splice(bestIndex, 1)[0],
    score: bestScore,
  };
}

function pcoPositionKey(teamName, positionName) {
  return `${normalizeTeamName(teamName)}::${String(positionName || '').trim().toLowerCase()}`;
}

function normalizePcoDisplayPosition(entry) {
  const count = Number.parseInt(String(entry?.count ?? 1), 10);
  return {
    teamName: String(entry?.teamName || '').trim(),
    positionName: String(entry?.positionName || '').trim(),
    count: Number.isFinite(count) && count > 0 ? count : 1,
  };
}

function normalizePcoDisplayPositions(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => normalizePcoDisplayPosition(entry))
    .filter((entry) => entry.teamName && entry.positionName);
}

function initialsForName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return '?';
  return parts.map((part) => part[0]).join('').toUpperCase();
}

function pcoImageExtension(contentType, imageUrl) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  const ext = path.extname(new URL(imageUrl).pathname || '').toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) return ext;
  return '.jpg';
}

async function writePcoPlaceholderImage(displayName, key) {
  await ensureDirs();
  const fileName = `pco-${crypto.createHash('sha1').update(`${key}:placeholder`).digest('hex')}.svg`;
  const filePath = path.join(imagesDir(), fileName);
  const initials = initialsForName(displayName);
  const safeInitials = initials.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0%" stop-color="#2f455c"/><stop offset="100%" stop-color="#1b2432"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><text x="50%" y="52%" font-family="Arial, Helvetica, sans-serif" font-size="260" font-weight="700" text-anchor="middle" fill="#f4f6fb">${safeInitials}</text></svg>`;
  await fs.writeFile(filePath, svg, 'utf8');
  return fileName;
}

async function downloadPcoImage(imageUrl, key, displayName) {
  if (!imageUrl) {
    return writePcoPlaceholderImage(displayName, key);
  }
  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': pcoUserAgent(),
      },
    });
    if (!response.ok) {
      throw new Error(`image download failed with ${response.status}`);
    }
    const ext = pcoImageExtension(response.headers.get('content-type'), imageUrl);
    const fileName = `pco-${crypto.createHash('sha1').update(key).digest('hex')}${ext}`;
    const filePath = path.join(imagesDir(), fileName);
    const bytes = Buffer.from(await response.arrayBuffer());
    await ensureDirs();
    await fs.writeFile(filePath, bytes);
    return fileName;
  } catch {
    return writePcoPlaceholderImage(displayName, key);
  }
}

function makePcoLocalId(serviceTypeId, planId, planPersonId) {
  return `pco-${serviceTypeId}-${planId}-${planPersonId}`;
}

async function listPcoServiceTypes(credentials) {
  const payload = await pcoFetchAll('/services/v2/service_types', credentials, {
    per_page: 100,
    order: 'sequence',
  });
  return payload.data
    .filter((entry) => !entry?.attributes?.archived_at && !entry?.attributes?.deleted_at)
    .map((entry) => ({
      id: String(entry.id),
      name: String(entry?.attributes?.name || `Service Type ${entry.id}`),
    }));
}

async function listPcoPositionOptions(serviceTypeId, credentials) {
  const normalizedServiceTypeId = String(serviceTypeId || '').trim();
  if (!normalizedServiceTypeId) return [];
  const payload = await pcoFetchAll(`/services/v2/service_types/${normalizedServiceTypeId}/team_positions`, credentials, {
    include: 'team',
    per_page: 100,
    order: 'name',
  });
  const includedByKey = new Map(payload.included.map((entry) => [`${entry?.type || ''}:${entry?.id || ''}`, entry]));
  const options = [];
  for (const entry of payload.data) {
    if (!entry || typeof entry !== 'object') continue;
    const teamId = String(entry?.relationships?.team?.data?.id || '');
    const team = teamId ? includedByKey.get(`Team:${teamId}`) : null;
    const teamName = String(team?.attributes?.name || '').trim();
    if (!isAllowedPcoTeamName(teamName)) continue;
    const positionName = String(entry?.attributes?.name || '').trim();
    if (!positionName) continue;
    options.push({
      teamName,
      positionName,
      key: pcoPositionKey(teamName, positionName),
    });
  }
  options.sort((a, b) => {
    const teamCompare = a.teamName.localeCompare(b.teamName, undefined, { sensitivity: 'base' });
    if (teamCompare) return teamCompare;
    return a.positionName.localeCompare(b.positionName, undefined, { sensitivity: 'base' });
  });
  return options;
}

async function syncUpcomingPcoPlan(payload) {
  const credentials = await loadPcoCredentials();
  if (!credentials) {
    throw new Error('Planning Center is not connected yet.');
  }
  const normalizedServiceTypeId = String(payload?.serviceTypeId || '').trim();
  if (!normalizedServiceTypeId) {
    throw new Error('Choose a service type first.');
  }
  const currentState = await loadStateRaw();
  const baseState = {
    library: Array.isArray(payload?.library) ? payload.library.map((entry) => normalizeSavedLibraryPerson(entry)) : currentState.library,
    layout: payload?.layout ? normalizeLayout(payload.layout) : currentState.layout,
    parallaxEnabled: typeof payload?.parallaxEnabled === 'boolean' ? payload.parallaxEnabled : currentState.parallaxEnabled,
    slotLabels: Array.isArray(payload?.slotLabels)
      ? payload.slotLabels.map((entry) => (typeof entry === 'string' ? entry : ''))
      : currentState.slotLabels,
    slotNames: Array.isArray(payload?.slotNames)
      ? payload.slotNames.map((entry) => (typeof entry === 'string' ? entry : ''))
      : currentState.slotNames,
    lineup: Array.isArray(payload?.lineup)
      ? payload.lineup.map((entry) => ({
          personId: typeof entry?.personId === 'string' ? entry.personId : '',
          label: typeof entry?.label === 'string' ? entry.label : '',
        }))
      : currentState.lineup,
    pcoDisplayPositions: normalizePcoDisplayPositions(payload?.pcoDisplayPositions ?? currentState.pcoDisplayPositions),
    // Carried through deliberately: this state is rebuilt field-by-field and written whole,
    // so anything omitted here is ERASED from disk by a sync.
    proPresenter: normalizeProPresenterConfig(currentState.proPresenter),
    displayServer: normalizeDisplayServerConfig(currentState.displayServer),
  };
  const planPayload = await pcoRequestJson(`/services/v2/service_types/${normalizedServiceTypeId}/plans`, credentials, {
    filter: 'future',
    per_page: 1,
    order: 'sort_date',
  });
  const plan = Array.isArray(planPayload.data) ? planPayload.data[0] : null;
  if (!plan) {
    throw new Error('No upcoming plan was found for that service type.');
  }

  const teamMembersPayload = await pcoFetchAll(
    `/services/v2/service_types/${normalizedServiceTypeId}/plans/${plan.id}/team_members`,
    credentials,
    {
      include: 'person,team',
      per_page: 100,
    },
  );
  const includedByKey = new Map(
    teamMembersPayload.included.map((entry) => [`${entry?.type || ''}:${entry?.id || ''}`, entry]),
  );
  const scheduledMembers = [];
  for (const member of teamMembersPayload.data) {
    if (!member || typeof member !== 'object') continue;
    const status = String(member?.attributes?.status || '').trim();
    if (status === 'D' || /^declined$/i.test(status)) continue;
    const personId = String(member?.relationships?.person?.data?.id || '');
    const teamId = String(member?.relationships?.team?.data?.id || '');
    const person = personId ? includedByKey.get(`Person:${personId}`) : null;
    const team = teamId ? includedByKey.get(`Team:${teamId}`) : null;
    const displayName =
      String(
        person?.attributes?.full_name ||
          person?.attributes?.profile_name ||
          member?.attributes?.name ||
          'Unknown Person',
      ).trim() || 'Unknown Person';
    const label = String(member?.attributes?.team_position_name || '').trim();
    const teamName = String(team?.attributes?.name || '').trim();
    if (!isAllowedPcoTeamName(teamName)) continue;
    const photoUrl =
      String(
        person?.attributes?.photo_url ||
          person?.attributes?.photo_thumbnail_url ||
          member?.attributes?.photo_thumbnail ||
          '',
      ).trim();
    scheduledMembers.push({
      planPersonId: String(member.id),
      personId,
      displayName,
      label,
      teamName,
      photoUrl,
    });
  }

  scheduledMembers.sort((a, b) => {
    const teamCompare = a.teamName.localeCompare(b.teamName, undefined, { sensitivity: 'base' });
    if (teamCompare) return teamCompare;
    const labelCompare = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    if (labelCompare) return labelCompare;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });

  const oldPcoFiles = new Set(
    (Array.isArray(baseState.library) ? baseState.library : [])
      .filter((entry) => entry?.source === 'pco' && typeof entry?.fileName === 'string')
      .map((entry) => entry.fileName),
  );

  const syncedLibrary = [];
  const nextPcoFiles = new Set();
  for (const member of scheduledMembers) {
    const localId = makePcoLocalId(normalizedServiceTypeId, String(plan.id), member.planPersonId);
    const fileName = await downloadPcoImage(
      member.photoUrl,
      `${normalizedServiceTypeId}:${plan.id}:${member.planPersonId}:${member.photoUrl}`,
      member.displayName,
    );
    nextPcoFiles.add(fileName);
    syncedLibrary.push({
      id: localId,
      fileName,
      originalName: member.displayName,
      lastLabel: member.label,
      lastName: member.displayName,
      source: 'pco',
      pcoPersonId: member.personId,
      pcoPlanPersonId: member.planPersonId,
    });
  }

  const layout = normalizeLayout(baseState.layout);
  const slotCount = layout.columns * layout.rows;
  const slotLabels = Array.from({ length: slotCount }, (_slot, index) =>
    typeof baseState.slotLabels[index] === 'string'
      ? baseState.slotLabels[index]
      : typeof baseState.lineup[index]?.label === 'string'
        ? baseState.lineup[index].label
        : '',
  );
  const slotNames = Array.from({ length: slotCount }, (_slot, index) =>
    typeof baseState.slotNames[index] === 'string' ? baseState.slotNames[index] : '',
  );
  const lineup = Array.from({ length: slotCount }, (_slot, index) => ({
    personId: typeof baseState.lineup[index]?.personId === 'string' ? baseState.lineup[index].personId : '',
    label: slotLabels[index] || '',
  }));
  const libraryById = new Map(baseState.library.map((entry) => [entry.id, entry]));
  let displayedCount = 0;

  const availableMembers = [...scheduledMembers].sort((a, b) => {
    const labelCompare = a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    if (labelCompare) return labelCompare;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });

  for (let i = 0; i < slotCount; i += 1) {
    const desiredLabel = String(slotLabels[i] || '').trim();
    if (!desiredLabel) continue;
    const match = findBestPcoMemberForSlot(desiredLabel, availableMembers);
    if (match?.member) {
      const member = match.member;
      lineup[i] = {
        personId: makePcoLocalId(normalizedServiceTypeId, String(plan.id), member.planPersonId),
        label: desiredLabel,
      };
      slotNames[i] = member.displayName;
      displayedCount += 1;
      continue;
    }
    const currentPerson = libraryById.get(lineup[i].personId);
    if (currentPerson?.source === 'local') {
      lineup[i] = {
        personId: currentPerson.id,
        label: desiredLabel,
      };
      continue;
    }
    lineup[i] = {
      personId: '',
      label: desiredLabel,
    };
    slotNames[i] = '';
  }

  const localLibrary = (Array.isArray(baseState.library) ? baseState.library : []).filter(
    (entry) => entry?.source !== 'pco',
  );
  const nextState = {
    library: [...localLibrary, ...syncedLibrary],
    layout,
    parallaxEnabled: typeof baseState.parallaxEnabled === 'boolean' ? baseState.parallaxEnabled : true,
    slotLabels,
    slotNames,
    lineup,
    pcoServiceTypeId: normalizedServiceTypeId,
    pcoDisplayPositions: baseState.pcoDisplayPositions,
  };
  // Re-read the keys this function does not own, immediately before writing. The snapshot
  // above was taken before a plan fetch, paginated team-member fetches and one photo
  // download per person — tens of seconds during which the operator can still connect
  // ProPresenter or switch hosting on, and this whole-file write would stamp those back to
  // their old values. (That is the bug the carry-forward was added to fix; reading the
  // values early only moved the window instead of closing it.)
  const atWriteTime = await loadStateRaw();
  nextState.proPresenter = normalizeProPresenterConfig(atWriteTime.proPresenter);
  nextState.displayServer = normalizeDisplayServerConfig(atWriteTime.displayServer);
  await saveStateRaw(nextState);

  for (const fileName of oldPcoFiles) {
    if (nextPcoFiles.has(fileName)) continue;
    try {
      await fs.unlink(path.join(imagesDir(), path.basename(fileName)));
    } catch {
      /* ignore stale file cleanup */
    }
  }

  return {
    state: nextState,
    plan: {
      id: String(plan.id),
      title: String(plan?.attributes?.title || ''),
      shortDates: String(plan?.attributes?.short_dates || plan?.attributes?.dates || ''),
      serviceTypeId: normalizedServiceTypeId,
      peopleCount: scheduledMembers.length,
      displayedCount,
    },
  };
}

/* ------------------------------------------------------------------ *
 * ProPresenter 7 integration                                          *
 *                                                                     *
 * The polling + HTTP logic lives in ./propresenter-core, shared with   *
 * the standalone display program in propresenter-app/ so both stay in  *
 * lockstep. It runs in the main process (Node fetch): no CORS and no   *
 * renderer CSP change. This file owns only the Electron side —         *
 * persistence in the app state file, and pushing the core's            *
 * view-model to the renderer over the 'pp-data' channel.               *
 * ------------------------------------------------------------------ */

/** Connection config as persisted in the app state file (password comes from safeStorage). */
let ppConfig = { enabled: false, host: '', port: 0, password: '', playlistUuid: '', playlistName: '' };

const ppClient = createProPresenterClient({
  pollMs: PP_POLL_MS,
  retryMs: PP_RETRY_MS,
  onData: (view) => {
    // Publish to the LAN FIRST, in its own guard. Two reasons: the window check below
    // returns early when there is no window (so a fan-out after it would never run for
    // the studios), and a throw from here escapes emit() into the poll loop — which is
    // precisely how polling could stop for good.
    try {
      displayServer?.publish(view);
    } catch (err) {
      displayError = err instanceof Error ? err.message : String(err);
    }
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('pp-data', view);
    } catch {
      /* window went away between the check and the send */
    }
  },
});

/** Push ppConfig (our persisted source of truth) into the polling client. */
function ppSyncClientConfig() {
  ppClient.configure(ppConfig);
}

function ppSendCleared() {
  const cleared = ppClearedViewModel();
  try {
    displayServer?.publish(cleared);
  } catch (err) {
    displayError = err instanceof Error ? err.message : String(err);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('pp-data', cleared);
}

function ppStop() {
  ppClient.stop();
}

function ppStart() {
  ppSyncClientConfig();
  ppClient.start();
}

async function ppLoadConfigFromDisk() {
  const state = await loadStateRaw();
  const config = normalizeProPresenterConfig(state.proPresenter);
  const password = await loadPpPassword();
  ppConfig = { ...config, password };
  ppSyncClientConfig();
}

/* ------------------------------------------------------------------ *
 * Hosting the Now / Next display for the rest of the building         *
 *                                                                     *
 * Serves the same display program that lives in propresenter-app/, so  *
 * studios and hallway screens need only a bookmark — nothing installed. *
 * It is handed the ppClient above rather than making its own, so there  *
 * is exactly ONE poll loop behind this app's own column and every      *
 * screen on the network, and the ProPresenter connection is still      *
 * configured in one place: here.                                      *
 * ------------------------------------------------------------------ */

/** Persisted in state.json under `displayServer`. */
let displayConfig = { enabled: false, port: DEFAULT_DISPLAY_PORT };
/** The running server, or null. Also the flag the poll-loop fan-out keys off. */
let displayServer = null;
let displayError = '';
/**
 * On Windows the firewall prompt fires at bind time, not on first connection, so this
 * machine can look perfectly healthy on localhost while every studio times out. A viewer
 * count that never leaves zero is the only signal we get, so the UI says so out loud — the
 * latch itself lives in the display server, which is what actually sees connections.
 */
/**
 * Serializes start/stop/port changes. Without this, two quick toggles interleave: the second
 * call's stop runs while the first call is still awaiting listen(), finds displayServer still
 * null, and does nothing — then the first call assigns a LISTENING server even though the
 * saved state now says off. The port would stay open with the UI reporting "Off".
 */
let displayTransition = Promise.resolve();

function queueDisplayTransition(task) {
  const run = () => task();
  const next = displayTransition.then(run, run);
  displayTransition = next.then(() => {}, () => {});
  return next;
}

function displayStatus() {
  const listening = Boolean(displayServer && displayServer.isListening());
  const status = listening ? displayServer.status() : null;
  const viewers = listening ? displayServer.viewers() : 0;
  return {
    enabled: displayConfig.enabled,
    port: displayConfig.port,
    listening,
    viewers,
    devices: status ? status.viewerDevices : 0,
    // Read from the server, not sampled here: this UI's poll is suppressed for the whole of
    // show mode, so sampling would report "nothing ever connected" after a service where
    // three studios watched the entire time.
    everHadViewer: Boolean(status && status.everHadViewer),
    peakViewers: status ? status.peakViewers : 0,
    addresses: status ? status.addresses : [],
    mdnsName: status ? status.mdnsName : '',
    mdnsConflict: status ? status.mdnsConflict : '',
    lastError: displayError,
  };
}

async function startDisplayServer() {
  if (displayServer) return displayStatus();
  displayError = '';
  const candidate = createDisplayServer({
    client: ppClient,
    port: displayConfig.port,
    hostKind: 'band-lineup',
    hostLabel: 'the Band Lineup computer backstage',
    mdnsName: 'nownext',
    appVersion: app.getVersion(),
  });
  try {
    await candidate.listen();
    // Re-check: hosting may have been switched off while listen() was in flight.
    if (!displayConfig.enabled) {
      await candidate.close().catch(() => {});
      return displayStatus();
    }
    displayServer = candidate;
    // Seed the screens with whatever is on stage right now.
    candidate.publish(ppClient.getViewModel());
  } catch (error) {
    await candidate.close().catch(() => {});
    // Deliberately NOT walking to the next free port: a moving port silently breaks every
    // bookmark this feature exists to create. Say what happened and let the operator choose.
    displayError = error?.code === 'EADDRINUSE'
      ? `Port ${displayConfig.port} is already in use on this computer — another copy of Band Lineup, or another program, may already have it. Pick a different port.`
      : `Could not start the display server: ${error instanceof Error ? error.message : String(error)}`;
  }
  return displayStatus();
}

async function stopDisplayServer() {
  const current = displayServer;
  displayServer = null;
  // close() never stops the injected ppClient — this app's own column keeps running.
  if (current) await current.close().catch(() => {});
  return displayStatus();
}

/** Tell every connected screen the ProPresenter connection changed. Never throws. */
function displayNotifyStatus() {
  try {
    displayServer?.publishStatus();
  } catch (err) {
    displayError = err instanceof Error ? err.message : String(err);
  }
}

async function persistDisplayConfig() {
  const state = await loadStateRaw();
  state.displayServer = { enabled: displayConfig.enabled, port: displayConfig.port };
  await saveStateRaw(state);
}

async function loadDisplayConfigFromDisk() {
  const state = await loadStateRaw();
  displayConfig = normalizeDisplayServerConfig(state.displayServer);
}

function parallaxMetaPath(fileName) {
  return `${processedBaseName(fileName)}.json`;
}

function parallaxLayerPath(fileName, layerName) {
  return `${processedBaseName(fileName)}-${layerName}.png`;
}

async function getDepthEstimator() {
  if (!depthEstimatorPromise) {
    depthEstimatorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = modelCacheDir();
      env.allowLocalModels = true;
      env.useFSCache = true;
      return pipeline('depth-estimation', 'Xenova/dpt-hybrid-midas', { dtype: 'q8' });
    })();
  }
  return depthEstimatorPromise;
}

async function getBackgroundRemover() {
  if (!backgroundRemoverPromise) {
    backgroundRemoverPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = modelCacheDir();
      env.allowLocalModels = true;
      env.useFSCache = true;
      return pipeline('background-removal', 'Xenova/modnet', { dtype: 'q8' });
    })();
  }
  return backgroundRemoverPromise;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function percentileFromHistogram(histogram, total, percentile) {
  const target = total * percentile;
  let running = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    running += histogram[i];
    if (running >= target) return i;
  }
  return histogram.length - 1;
}

function applyMaskToRgba(sourceData, width, height, alphaForPixel) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const srcOffset = i * 4;
    out[srcOffset] = sourceData[srcOffset];
    out[srcOffset + 1] = sourceData[srcOffset + 1];
    out[srcOffset + 2] = sourceData[srcOffset + 2];
    out[srcOffset + 3] = alphaForPixel(i);
  }
  return out;
}

async function writeRawRgbaPng(filePath, width, height, data) {
  await sharp(Buffer.from(data), {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toFile(filePath);
}

async function buildExpandedSubjectMask(width, height, foregroundData) {
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i += 1) {
    alpha[i] = foregroundData[i * 4 + 3];
  }
  const edgePx = Math.max(8, Math.min(40, Math.round(10 * (Math.max(width, height) / 768))));
  return sharp(Buffer.from(alpha), {
    raw: {
      width,
      height,
      channels: 1,
    },
  })
    .dilate(edgePx)
    .blur(edgePx)
    .raw()
    .toBuffer();
}

function averageBackgroundColor(imageData, maskData) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let i = 0; i < maskData.length; i += 1) {
    const subject = maskData[i] / 255;
    if (subject > 0.12) continue;
    const offset = i * 4;
    r += imageData[offset];
    g += imageData[offset + 1];
    b += imageData[offset + 2];
    count += 1;
  }
  if (!count) return { r: 24, g: 24, b: 24 };
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

async function existingParallaxAssets(fileName) {
  const metaPath = parallaxMetaPath(fileName);
  const bgPath = parallaxLayerPath(fileName, 'bg');
  const midPath = parallaxLayerPath(fileName, 'mid');
  const fgPath = parallaxLayerPath(fileName, 'fg');
  const depthPath = parallaxLayerPath(fileName, 'depth');
  if (!fsSync.existsSync(metaPath) || !fsSync.existsSync(bgPath) || !fsSync.existsSync(midPath) || !fsSync.existsSync(fgPath) || !fsSync.existsSync(depthPath)) {
    return null;
  }
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (meta.version !== PARALLAX_VERSION) return null;
    return {
      bgUrl: pathToFileURL(bgPath).href,
      midUrl: pathToFileURL(midPath).href,
      fgUrl: pathToFileURL(fgPath).href,
      depthUrl: pathToFileURL(depthPath).href,
      width: meta.width,
      height: meta.height,
    };
  } catch {
    return null;
  }
}

async function generateParallaxAssets(fileName) {
  const existing = await existingParallaxAssets(fileName);
  if (existing) return existing;

  const safeName = path.basename(fileName);
  const sourcePath = path.join(imagesDir(), safeName);
  if (!fsSync.existsSync(sourcePath)) return null;

  const image = sharp(sourcePath).rotate();
  const metadata = await image.metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;
  if (!sourceWidth || !sourceHeight) return null;

  const scale = Math.min(1, PARALLAX_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const encoded = await image
    .resize(width, height, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  const baseRaw = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bgRaw = await sharp(encoded).modulate({ brightness: 0.94, saturation: 1.0 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const inputBlob = new Blob([encoded], { type: 'image/png' });
  const [depthEstimator, backgroundRemover] = await Promise.all([getDepthEstimator(), getBackgroundRemover()]);
  const [depthOutput, foregroundOutput] = await Promise.all([
    depthEstimator(inputBlob),
    backgroundRemover(inputBlob),
  ]);
  const depthImage = depthOutput.depth;
  const depthData = depthImage.data;
  const foregroundImage = Array.isArray(foregroundOutput) ? foregroundOutput[0] : foregroundOutput;
  const foregroundRgba = foregroundImage.clone().rgba();
  const foregroundData = foregroundRgba.data;
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < depthData.length; i += 1) {
    histogram[depthData[i]] += 1;
  }
  const total = depthData.length;
  const midThreshold = percentileFromHistogram(histogram, total, 0.56);
  const frontThreshold = percentileFromHistogram(histogram, total, 0.82);
  const subjectMaskData = await buildExpandedSubjectMask(width, height, foregroundData);
  const avgBg = averageBackgroundColor(bgRaw.data, subjectMaskData);
  const bgData = applyMaskToRgba(bgRaw.data, width, height, () => 255);
  for (let i = 0; i < width * height; i += 1) {
    const expandedAlpha = subjectMaskData[i] / 255;
    if (expandedAlpha <= 0.02) continue;
    const offset = i * 4;
    const keep = 1 - expandedAlpha;
    bgData[offset] = Math.round(bgData[offset] * keep + avgBg.r * expandedAlpha);
    bgData[offset + 1] = Math.round(bgData[offset + 1] * keep + avgBg.g * expandedAlpha);
    bgData[offset + 2] = Math.round(bgData[offset + 2] * keep + avgBg.b * expandedAlpha);
    bgData[offset + 3] = 255;
  }
  const midData = applyMaskToRgba(baseRaw.data, width, height, (index) => {
    const depth = depthData[index];
    const fgAlpha = foregroundData[index * 4 + 3] / 255;
    const frontMask = smoothstep(frontThreshold - 16, frontThreshold + 8, depth);
    const midMask = smoothstep(midThreshold - 18, midThreshold + 10, depth) * (1 - frontMask);
    return Math.round(255 * fgAlpha * midMask);
  });
  const fgData = applyMaskToRgba(baseRaw.data, width, height, (index) => {
    const depth = depthData[index];
    const fgAlpha = foregroundData[index * 4 + 3] / 255;
    const frontMask = smoothstep(frontThreshold - 16, frontThreshold + 8, depth);
    return Math.round(255 * fgAlpha * frontMask);
  });

  const bgPath = parallaxLayerPath(fileName, 'bg');
  const midPath = parallaxLayerPath(fileName, 'mid');
  const fgPath = parallaxLayerPath(fileName, 'fg');
  const depthPath = parallaxLayerPath(fileName, 'depth');

  await Promise.all([
    writeRawRgbaPng(bgPath, width, height, bgData),
    writeRawRgbaPng(midPath, width, height, midData),
    writeRawRgbaPng(fgPath, width, height, fgData),
    depthImage.save(depthPath),
    fs.writeFile(
      parallaxMetaPath(fileName),
      JSON.stringify({ version: PARALLAX_VERSION, width, height }, null, 2),
      'utf8',
    ),
  ]);

  return {
    bgUrl: pathToFileURL(bgPath).href,
    midUrl: pathToFileURL(midPath).href,
    fgUrl: pathToFileURL(fgPath).href,
    depthUrl: pathToFileURL(depthPath).href,
    width,
    height,
  };
}

async function getOrCreateParallaxAssets(fileName) {
  const safeName = path.basename(fileName);
  if (!parallaxTaskCache.has(safeName)) {
    parallaxTaskCache.set(
      safeName,
      generateParallaxAssets(safeName).finally(() => {
        parallaxTaskCache.delete(safeName);
      }),
    );
  }
  return parallaxTaskCache.get(safeName);
}

function migrateState(data) {
  if (data && Array.isArray(data.library) && Array.isArray(data.lineup)) {
    const library = data.library.map((p) => normalizeSavedLibraryPerson(p));

    for (const entry of data.lineup) {
      if (!entry || typeof entry !== 'object') continue;
      if (!entry.personId || typeof entry.nameLabel !== 'string' || !entry.nameLabel) continue;
      const person = library.find((item) => item.id === String(entry.personId));
      if (person && !person.lastName) {
        person.lastName = entry.nameLabel;
      }
    }

    const slotLabels = Array.isArray(data.slotLabels)
      ? data.slotLabels.map((label) => (typeof label === 'string' ? label : ''))
      : data.lineup.map((entry) => (entry && typeof entry.label === 'string' ? entry.label : ''));
    const slotNames = Array.isArray(data.slotNames)
      ? data.slotNames.map((label) => (typeof label === 'string' ? label : ''))
      : data.lineup.map((entry) => (entry && typeof entry.nameLabel === 'string' ? entry.nameLabel : ''));

    return {
      library,
      layout: normalizeLayout(data.layout),
      parallaxEnabled: typeof data.parallaxEnabled === 'boolean' ? data.parallaxEnabled : true,
      slotLabels,
      slotNames,
      pcoServiceTypeId: typeof data.pcoServiceTypeId === 'string' ? data.pcoServiceTypeId : '',
      pcoDisplayPositions: normalizePcoDisplayPositions(data.pcoDisplayPositions),
      proPresenter: normalizeProPresenterConfig(data.proPresenter),
      displayServer: normalizeDisplayServerConfig(data.displayServer),
      lineup: data.lineup.map((e) => {
        if (!e || typeof e !== 'object') return { personId: '', label: '' };
        return {
          personId: typeof e.personId === 'string' ? e.personId : '',
          label: typeof e.label === 'string' ? e.label : '',
        };
      }),
    };
  }
  if (data && Array.isArray(data.tiles)) {
    const library = data.tiles.map((t) => ({
      id: String(t.id),
      fileName: String(t.fileName),
      originalName: '',
      lastLabel: typeof t.label === 'string' ? t.label : '',
      lastName: '',
      source: 'local',
      pcoPersonId: '',
      pcoPlanPersonId: '',
    }));
    const lineup = data.tiles.map((t) => ({
      personId: String(t.id),
      label: typeof t.label === 'string' ? t.label : '',
    }));
    return {
      library,
      layout: { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS },
      parallaxEnabled: true,
      slotLabels: lineup.map((slot) => slot.label || ''),
      slotNames: [],
      lineup,
      pcoServiceTypeId: '',
      pcoDisplayPositions: [],
      proPresenter: { enabled: false, host: '', port: 0, playlistUuid: '', playlistName: '' },
      displayServer: { enabled: false, port: DEFAULT_DISPLAY_PORT },
    };
  }
  return emptyState();
}

async function loadStateRaw() {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    return migrateState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

async function saveStateRaw(data) {
  await ensureDirs();
  await fs.writeFile(statePath(), JSON.stringify(data, null, 2), 'utf8');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 800,
    minHeight: 480,
    backgroundColor: '#0f0f12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAutoHideMenuBar(true);
  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    ppStop();
    mainWindow = null;
  });

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Add photos…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-add-photos'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: async () => {
            const { readFileSync } = require('fs');
            let buildNumber = '1';
            try {
              const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
              buildNumber = String(pkg.buildNumber ?? pkg.version);
            } catch {
              /* ignore */
            }
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Band Lineup',
              message: 'Band Lineup',
              detail: `Version ${app.getVersion()}\nBuild ${buildNumber}\n\nPhotos and labels are saved automatically on this computer.`,
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (gotTheLock) {
  app.whenReady().then(async () => {
    await ppLoadConfigFromDisk().catch(() => {});
    await loadDisplayConfigFromDisk().catch(() => {});
    createWindow();
    if (displayConfig.enabled) {
      await queueDisplayTransition(() => startDisplayServer());
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Best effort only: Electron does not wait for async work here. This gets the mDNS
  // goodbye packet out and closes the listener politely; if we lose the race, the OS
  // reclaims the port and viewers see "display offline" on their next poll anyway.
  const current = displayServer;
  displayServer = null;
  if (current) void current.close().catch(() => {});
});

ipcMain.handle('add-images-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Add photos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
      { name: 'All', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths.length) return [];
  const added = [];
  for (const p of filePaths) {
    const fileName = await copyImageToStore(p);
    const id = crypto.randomBytes(12).toString('hex');
    added.push({ id, fileName, originalName: originalDisplayName(p) });
  }
  return added;
});

ipcMain.handle('add-images-paths', async (_e, filePaths) => {
  if (!Array.isArray(filePaths) || !filePaths.length) return [];
  const added = [];
  for (const p of filePaths) {
    try {
      if (!fsSync.existsSync(p)) continue;
      const fileName = await copyImageToStore(p);
      const id = crypto.randomBytes(12).toString('hex');
      added.push({ id, fileName, originalName: originalDisplayName(p) });
    } catch {
      /* skip bad file */
    }
  }
  return added;
});

ipcMain.handle('load-state', async () => {
  await ensureDirs();
  return loadStateRaw();
});

ipcMain.handle('save-state', async (_e, payload) => {
  const library = Array.isArray(payload?.library) ? payload.library : [];
  const lineup = Array.isArray(payload?.lineup) ? payload.lineup : [];
  const slotLabels = Array.isArray(payload?.slotLabels) ? payload.slotLabels : [];
  const slotNames = Array.isArray(payload?.slotNames) ? payload.slotNames : [];
  const layout = normalizeLayout(payload?.layout);
  const parallaxEnabled = typeof payload?.parallaxEnabled === 'boolean' ? payload.parallaxEnabled : true;
  const pcoServiceTypeId = typeof payload?.pcoServiceTypeId === 'string' ? payload.pcoServiceTypeId : '';
  const pcoDisplayPositions = normalizePcoDisplayPositions(payload?.pcoDisplayPositions);
  const existing = await loadStateRaw();
  const proPresenter = payload?.proPresenter
    ? normalizeProPresenterConfig(payload.proPresenter)
    : normalizeProPresenterConfig(existing.proPresenter);
  // The renderer never edits this (it is changed through the display-* IPC handlers), so
  // always carry the stored value forward rather than letting a save blank it out.
  const displayServer = normalizeDisplayServerConfig(existing.displayServer);
  await saveStateRaw({ library, layout, parallaxEnabled, slotLabels, slotNames, lineup, pcoServiceTypeId, pcoDisplayPositions, proPresenter, displayServer });
  return true;
});

ipcMain.handle('delete-library-image', async (_e, fileName) => {
  if (!fileName || typeof fileName !== 'string' || fileName.includes('..')) return false;
  const full = path.join(imagesDir(), path.basename(fileName));
  try {
    await fs.unlink(full);
  } catch {
    /* already gone */
  }
  return true;
});

ipcMain.handle('image-url', async (_e, fileName) => {
  if (!fileName || typeof fileName !== 'string') return '';
  const safe = path.basename(fileName);
  const full = path.join(imagesDir(), safe);
  if (!fsSync.existsSync(full)) return '';
  return pathToFileURL(full).href;
});

ipcMain.handle('parallax-assets', async (_e, fileName) => {
  if (!fileName || typeof fileName !== 'string') return null;
  try {
    return await getOrCreateParallaxAssets(fileName);
  } catch {
    return null;
  }
});

ipcMain.handle('pco-status', async () => {
  const credentials = await loadPcoCredentials();
  const data = await loadStateRaw();
  return {
    connected: Boolean(credentials?.clientId && credentials?.secret),
    pcoServiceTypeId: typeof data?.pcoServiceTypeId === 'string' ? data.pcoServiceTypeId : '',
    pcoDisplayPositions: normalizePcoDisplayPositions(data?.pcoDisplayPositions),
  };
});

ipcMain.handle('pco-connect', async (_e, payload) => {
  const clientId = String(payload?.clientId || '').trim();
  const secret = String(payload?.secret || '').trim();
  if (!clientId || !secret) {
    throw new Error('Enter both the Planning Center client ID and secret.');
  }
  const credentials = { clientId, secret };
  const serviceTypes = await listPcoServiceTypes(credentials);
  await savePcoCredentials(credentials);
  return { connected: true, serviceTypes };
});

ipcMain.handle('pco-disconnect', async () => {
  await clearPcoCredentials();
  return true;
});

ipcMain.handle('pco-service-types', async () => {
  const credentials = await loadPcoCredentials();
  if (!credentials) {
    throw new Error('Planning Center is not connected yet.');
  }
  return listPcoServiceTypes(credentials);
});

ipcMain.handle('pco-position-options', async (_e, serviceTypeId) => {
  const credentials = await loadPcoCredentials();
  if (!credentials) {
    throw new Error('Planning Center is not connected yet.');
  }
  return listPcoPositionOptions(serviceTypeId, credentials);
});

ipcMain.handle('pco-sync-upcoming-plan', async (_e, payload) => {
  return syncUpcomingPcoPlan(payload);
});

ipcMain.handle('pp-status', async () => {
  return {
    enabled: ppConfig.enabled,
    host: ppConfig.host,
    port: ppConfig.port || '',
    reachable: ppClient.getViewModel().reachable,
    hasPassword: Boolean(ppConfig.password),
    playlistUuid: ppConfig.playlistUuid || '',
    playlistName: ppConfig.playlistName || '',
  };
});

ipcMain.handle('pp-playlists', async () => {
  ppSyncClientConfig();
  return ppClient.listPlaylists();
});

ipcMain.handle('pp-select-playlist', async (_e, payload) => {
  const uuid = String(payload?.uuid || '');
  const name = String(payload?.name || '');
  ppConfig.playlistUuid = uuid;
  ppConfig.playlistName = name;
  // Resets the core's cached playlist so the next poll refetches the newly chosen one,
  // and restarts the poll loop if it was already running.
  ppClient.selectPlaylist({ uuid, name });

  const state = await loadStateRaw();
  state.proPresenter = {
    enabled: ppConfig.enabled,
    host: ppConfig.host,
    port: ppConfig.port,
    playlistUuid: uuid,
    playlistName: name,
  };
  await saveStateRaw(state);
  displayNotifyStatus();
  return true;
});

ipcMain.handle('pp-connect', async (_e, payload) => {
  const host = String(payload?.host || '').trim();
  const portNum = Number.parseInt(String(payload?.port ?? ''), 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 0;
  const password = String(payload?.password || '');
  if (!host || !port) {
    throw new Error('Enter the ProPresenter host (IP) and port.');
  }

  const prevPlaylistUuid = ppConfig.playlistUuid || '';
  const prevPlaylistName = ppConfig.playlistName || '';
  ppConfig = { enabled: true, host, port, password, playlistUuid: prevPlaylistUuid, playlistName: prevPlaylistName };
  ppSyncClientConfig();
  try {
    await ppClient.testConnection();
  } catch (error) {
    ppConfig.enabled = false;
    ppSyncClientConfig();
    throw error;
  }

  const state = await loadStateRaw();
  state.proPresenter = { enabled: true, host, port, playlistUuid: prevPlaylistUuid, playlistName: prevPlaylistName };
  await saveStateRaw(state);
  await savePpPassword(password);

  ppClient.reset();
  ppStop();
  ppStart();
  displayNotifyStatus();
  return { connected: true, host, port };
});

ipcMain.handle('pp-disconnect', async () => {
  ppStop();
  ppConfig = { ...ppConfig, enabled: false, password: '' }; // keep host/port for easy reconnect
  ppClient.reset();
  ppSyncClientConfig();

  const state = await loadStateRaw();
  state.proPresenter = {
    enabled: false,
    host: ppConfig.host,
    port: ppConfig.port,
    playlistUuid: ppConfig.playlistUuid,
    playlistName: ppConfig.playlistName,
  };
  await saveStateRaw(state);
  await clearPpPassword();

  ppSendCleared();
  displayNotifyStatus();
  return true;
});

/** Version + build, for the toolbar label and for studio screens to confirm what they see. */
ipcMain.handle('app-version', async () => {
  let build = '';
  try {
    // Present in the packaged asar as well as in a dev run.
    build = String(require('./package.json').buildNumber || '');
  } catch {
    build = '';
  }
  return { version: app.getVersion(), build };
});

ipcMain.handle('display-status', async () => displayStatus());

ipcMain.handle('display-set-enabled', async (_e, enabled) => queueDisplayTransition(async () => {
  displayConfig.enabled = Boolean(enabled);
  await persistDisplayConfig();
  if (displayConfig.enabled) return startDisplayServer();
  return stopDisplayServer();
}));

ipcMain.handle('display-set-port', async (_e, value) => {
  const portNum = Number.parseInt(String(value ?? ''), 10);
  // Floor at 1024: below that needs elevation on macOS/Linux, and it is where a mistyped or
  // coerced value (an empty keypad entry used to become "1") would silently land and take
  // every bookmark down with it.
  const port = Number.isFinite(portNum) && portNum >= 1024 && portNum <= 65535 ? portNum : 0;
  if (!port) {
    throw new Error('Enter a port number between 1024 and 65535.');
  }
  return queueDisplayTransition(async () => {
    if (port === displayConfig.port) return displayStatus();
    displayConfig.port = port;
    await persistDisplayConfig();
    if (displayServer) await stopDisplayServer();
    // Key the restart off the SETTING, not off whether a server object exists. The usual
    // reason to change the port is that the previous one was taken — in which case there is
    // no server to stop, and the old code fell straight through without trying again,
    // leaving the stale "port N is in use" error on screen forever.
    if (displayConfig.enabled) return startDisplayServer();
    return displayStatus();
  });
});

// Goes through the main process on purpose: Electron's clipboard always works, while the
// renderer's navigator.clipboard depends on secure-context rules under a file:// origin.
ipcMain.handle('display-copy-url', async (_e, url) => {
  clipboard.writeText(String(url || ''));
  return true;
});

// Renderer calls this after attaching its 'pp-data' listener, so the first
// emit isn't missed when auto-reconnecting a saved connection on launch.
ipcMain.handle('pp-start', async () => {
  if (!ppConfig.enabled || !ppConfig.host || !ppConfig.port) return false;
  ppStop();
  ppStart();
  displayNotifyStatus();
  return true;
});
