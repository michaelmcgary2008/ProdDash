/* ProdDash admin client.

   Everything here is server-wide: module enable/disable and admin config
   (written to config/modules.json, module re-inited on save), plus named
   layout management. Guarded by the shared passcode when one is set. */

const loginCard = document.getElementById('login-card');
const loginStatus = document.getElementById('login-status');
const passcodeInput = document.getElementById('passcode');
const modulesSection = document.getElementById('modules-section');
const modulesList = document.getElementById('modules-list');
const layoutsSection = document.getElementById('layouts-section');
const layoutsList = document.getElementById('layouts-list');
const toastEl = document.getElementById('toast');
const availableSection = document.getElementById('available-section');
const availableList = document.getElementById('available-list');
const catalogStatus = document.getElementById('catalog-status');
const updateCard = document.getElementById('update-card');
const updateTitle = document.getElementById('update-title');
const updateCopy = document.getElementById('update-copy');
const updateStatus = document.getElementById('update-status');
const updateBtn = document.getElementById('update-btn');
const updateChanges = document.getElementById('update-changes');
const shellVersionEl = document.getElementById('shell-version');

/** The shell version the page loaded with — the update flow watches it change. */
let shellVersion = '';

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.authRequired = Boolean(body.authRequired);
    throw err;
  }
  return body;
}

/* ── login ──────────────────────────────────────────────────────────── */

function showLogin() {
  loginCard.hidden = false;
  modulesSection.hidden = true;
  availableSection.hidden = true;
  layoutsSection.hidden = true;
  updateCard.hidden = true;
  passcodeInput.focus();
}

async function login() {
  loginStatus.textContent = '';
  loginStatus.className = 'admin-status';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ passcode: passcodeInput.value }) });
    passcodeInput.value = '';
    loginCard.hidden = true;
    await loadState();
  } catch (e) {
    loginStatus.textContent = e.message;
    loginStatus.className = 'admin-status error';
  }
}

document.getElementById('login-btn').addEventListener('click', login);
passcodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

/* ── module cards ───────────────────────────────────────────────────── */

/** moduleId -> { dot, healthEl, toggle } for cheap in-place status refreshes */
const liveEls = new Map();

function healthClass(mod) {
  if (!mod.enabled) return '';
  if (mod.mountError) return 'error';
  return mod.health ? mod.health.status : 'ok';
}

function healthText(mod) {
  if (!mod.enabled) return 'Disabled — hidden from the dashboard picker, server routes unmounted.';
  if (mod.mountError) return '';
  if (mod.health) return mod.health.message || mod.health.status;
  return mod.hasServer ? 'Mounted.' : 'Client-only module (no server part).';
}

function fieldFor(key, spec, value, passwordSet, moduleId) {
  const type = spec?.type || 'string';
  const label = spec?.label || key;
  const field = document.createElement('label');
  field.className = 'field' + (type === 'boolean' ? ' check' : '');
  let read;

  if (type === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    field.append(input, document.createTextNode(label));
    read = () => input.checked;
  } else if (type === 'endpoint') {
    // One consistent "Host / IP : Port" control for every module's upstream.
    const span = document.createElement('span');
    span.textContent = label;
    const row = document.createElement('span');
    row.className = 'endpoint-row';
    const host = document.createElement('input');
    host.type = 'text';
    host.className = 'ep-host';
    host.placeholder = 'Host / IP';
    host.autocomplete = 'off';
    host.spellcheck = false;
    host.value = value?.host ? String(value.host) : '';
    const sep = document.createElement('span');
    sep.className = 'ep-sep';
    sep.textContent = ':';
    const port = document.createElement('input');
    port.type = 'number';
    port.className = 'ep-port';
    port.placeholder = 'Port';
    port.min = '1';
    port.max = '65535';
    port.value = value?.port ? String(value.port) : '';
    row.append(host, sep, port);
    field.append(span, row);
    read = () => ({ host: host.value.trim(), port: Number(port.value) || 0 });
  } else if (type === 'select' && (Array.isArray(spec.options) || spec.optionsRoute)) {
    const span = document.createElement('span');
    span.textContent = label;
    const select = document.createElement('select');
    const fill = (options) => {
      select.innerHTML = '';
      // The saved value must stay selectable even when it isn't among the
      // live options (device unplugged, module route down).
      const saved = String(value ?? '');
      if (saved && !options.some((opt) => String(typeof opt === 'object' ? opt.value : opt) === saved)) {
        options = [{ value: saved, label: `${saved} (saved)` }, ...options];
      }
      if (!saved) options = [{ value: '', label: '— choose —' }, ...options];
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = String(typeof opt === 'object' ? opt.value : opt);
        o.textContent = String(typeof opt === 'object' ? (opt.label ?? opt.value) : opt);
        select.appendChild(o);
      }
      select.value = saved;
    };
    fill(Array.isArray(spec.options) ? spec.options : []);
    if (spec.optionsRoute && moduleId) {
      // Options discovered at runtime (audio devices, ports, sources…):
      // the module serves them from one of its own routes.
      fetch(`/api/modules/${encodeURIComponent(moduleId)}${spec.optionsRoute}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (Array.isArray(body?.options)) fill(body.options);
        })
        .catch(() => { /* keep the static/saved options */ });
    }
    field.append(span, select);
    read = () => select.value;
  } else {
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = type === 'number' ? 'number' : (type === 'password' ? 'password' : 'text');
    if (type === 'password') {
      input.placeholder = passwordSet ? 'Saved — leave blank to keep' : 'Not set';
      input.autocomplete = 'new-password';
    } else {
      input.value = value === undefined || value === null ? '' : String(value);
    }
    field.append(span, input);
    read = () => (type === 'number' ? Number(input.value) : input.value);
  }
  return { field, read };
}

function buildModuleCard(mod) {
  const card = document.createElement('section');
  card.className = 'admin-card';

  const head = document.createElement('div');
  head.className = 'module-head';

  const dot = document.createElement('span');
  dot.className = 'dot ' + healthClass(mod);

  const name = document.createElement('span');
  name.className = 'module-name';
  name.textContent = mod.name;

  const version = document.createElement('span');
  version.className = 'module-version';
  version.textContent = mod.version ? 'v' + mod.version : '';

  const source = document.createElement('span');
  source.className = 'module-source';
  source.textContent = mod.source === 'installed' ? 'installed' : 'bundled';
  source.title = mod.source === 'installed'
    ? 'Installed from the repo into the data directory'
    : 'Ships with this copy of ProdDash';

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  // filled by the catalog when the repo has a newer version
  const updateSlot = document.createElement('span');
  updateSlot.className = 'module-update-slot';

  const uninstall = document.createElement('button');
  uninstall.className = 'btn small danger';
  uninstall.textContent = 'Uninstall';
  uninstall.title = mod.source === 'installed'
    ? 'Remove this module\'s files from the data directory'
    : 'Hide this bundled module from every dashboard (its folder stays with the app)';
  uninstall.addEventListener('click', async () => {
    const what = mod.source === 'installed'
      ? `Uninstall ${mod.name}? Its files are removed from the data directory. Its settings are kept in case you install it again.`
      : `Uninstall ${mod.name}? It disappears from every dashboard and the picker. It ships with ProdDash, so it can be brought back from "Available modules" any time.`;
    if (!window.confirm(what)) return;
    uninstall.disabled = true;
    try {
      await api(`/api/admin/modules/${encodeURIComponent(mod.id)}`, { method: 'DELETE' });
      toast(`${mod.name} uninstalled`);
      await loadState();
    } catch (e) {
      uninstall.disabled = false;
      if (e.authRequired) showLogin();
      else toast(e.message, true);
    }
  });

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'switch';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = mod.enabled;
  const track = document.createElement('span');
  track.className = 'track';
  const toggleText = document.createElement('span');
  toggleText.textContent = mod.enabled ? 'Enabled' : 'Disabled';
  toggleLabel.append(toggle, track, toggleText);

  head.append(dot, name, version, source, spacer, updateSlot, toggleLabel, uninstall);
  card.appendChild(head);

  const desc = document.createElement('div');
  desc.className = 'module-desc';
  desc.textContent = mod.description;
  card.appendChild(desc);

  const healthEl = document.createElement('div');
  healthEl.className = 'module-health ' + (healthClass(mod) === 'error' ? 'error' : '');
  healthEl.textContent = healthText(mod);
  card.appendChild(healthEl);

  const mountError = document.createElement('div');
  mountError.className = 'module-mount-error';
  mountError.hidden = !mod.mountError && !mod.incompatible;
  mountError.textContent = mod.incompatible
    ? `Not loaded — ${mod.incompatible}. Update ProdDash from the banner above.`
    : (mod.mountError ? `Failed to start: ${mod.mountError}` : '');
  card.appendChild(mountError);

  liveEls.set(mod.id, { dot, healthEl, toggle, toggleText, mountError, updateSlot });

  toggle.addEventListener('change', async () => {
    try {
      await api(`/api/admin/modules/${encodeURIComponent(mod.id)}/enabled`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: toggle.checked }),
      });
      toggleText.textContent = toggle.checked ? 'Enabled' : 'Disabled';
      toast(`${mod.name} ${toggle.checked ? 'enabled' : 'disabled'}`);
      refreshStatus();
    } catch (e) {
      toggle.checked = !toggle.checked;
      if (e.authRequired) showLogin();
      else toast(e.message, true);
    }
  });

  const schemaKeys = Object.entries(mod.configSchema || {});
  if (schemaKeys.length) {
    const form = document.createElement('div');
    form.className = 'module-form';
    const readers = new Map();
    for (const [key, spec] of schemaKeys) {
      const { field, read } = fieldFor(key, spec, mod.config[key], mod.passwordSet[key], mod.id);
      readers.set(key, read);
      form.appendChild(field);
    }
    const actions = document.createElement('div');
    actions.className = 'module-actions';
    const save = document.createElement('button');
    save.className = 'btn primary';
    save.textContent = 'Save & re-init';
    const status = document.createElement('span');
    status.className = 'admin-status';
    actions.append(save, status);
    form.appendChild(actions);
    card.appendChild(form);

    save.addEventListener('click', async () => {
      const config = {};
      for (const [key, read] of readers) config[key] = read();
      save.disabled = true;
      status.textContent = 'Saving…';
      status.className = 'admin-status';
      try {
        await api(`/api/admin/modules/${encodeURIComponent(mod.id)}/config`, {
          method: 'PUT',
          body: JSON.stringify({ config }),
        });
        status.textContent = 'Saved — module re-initialised. Open tiles reconnect on their own.';
        status.className = 'admin-status ok';
        refreshStatus();
      } catch (e) {
        status.textContent = e.message;
        status.className = 'admin-status error';
        if (e.authRequired) showLogin();
      } finally {
        save.disabled = false;
      }
    });
  } else {
    const none = document.createElement('div');
    none.className = 'module-form-empty';
    none.textContent = 'No server-wide settings — this module is configured per tile.';
    card.appendChild(none);
  }

  return card;
}

/* ── status refresh (leaves form inputs alone) ──────────────────────── */

async function refreshStatus() {
  let state;
  try {
    state = await api('/api/admin/state');
  } catch {
    return; // transient — the next tick will get it
  }
  for (const mod of state.modules || []) {
    const els = liveEls.get(mod.id);
    if (!els) continue;
    els.dot.className = 'dot ' + healthClass(mod);
    els.healthEl.textContent = healthText(mod);
    els.healthEl.className = 'module-health ' + (healthClass(mod) === 'error' ? 'error' : '');
    if (!mod.incompatible) {
      els.mountError.hidden = !mod.mountError;
      els.mountError.textContent = mod.mountError ? `Failed to start: ${mod.mountError}` : '';
    }
    if (document.activeElement !== els.toggle) {
      els.toggle.checked = mod.enabled;
      els.toggleText.textContent = mod.enabled ? 'Enabled' : 'Disabled';
    }
  }
}

/* ── named layouts ──────────────────────────────────────────────────── */

async function loadLayouts() {
  let body;
  try {
    body = await api('/api/layouts');
  } catch {
    layoutsSection.hidden = true;
    return;
  }
  layoutsSection.hidden = false;
  layoutsList.innerHTML = '';
  const layouts = body.layouts || [];
  if (!layouts.length) {
    const none = document.createElement('div');
    none.className = 'layouts-empty';
    none.textContent = 'No named layouts saved yet. Save one from the dashboard’s Layout menu.';
    layoutsList.appendChild(none);
    return;
  }
  for (const layout of layouts) {
    const row = document.createElement('div');
    row.className = 'layout-row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = layout.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${layout.tiles} tile${layout.tiles === 1 ? '' : 's'}`
      + (layout.updated ? ` · ${new Date(layout.updated).toLocaleString()}` : '');
    const rename = document.createElement('button');
    rename.className = 'btn';
    rename.textContent = 'Rename';
    rename.addEventListener('click', async () => {
      const next = prompt('New name for this layout:', layout.name);
      if (!next || next.trim() === '' || next === layout.name) return;
      try {
        await api(`/api/layouts/${encodeURIComponent(layout.name)}/rename`, {
          method: 'POST',
          body: JSON.stringify({ name: next.trim() }),
        });
        toast('Layout renamed');
        loadLayouts();
      } catch (e) {
        if (e.authRequired) showLogin();
        else toast(e.message, true);
      }
    });
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the layout “${layout.name}”? Browsers using it keep their current tiles.`)) return;
      try {
        await api(`/api/layouts/${encodeURIComponent(layout.name)}`, { method: 'DELETE' });
        toast('Layout deleted');
        loadLayouts();
      } catch (e) {
        if (e.authRequired) showLogin();
        else toast(e.message, true);
      }
    });
    row.append(name, meta, rename, del);
    layoutsList.appendChild(row);
  }
}

/* ── boot ───────────────────────────────────────────────────────────── */

async function loadState() {
  let state;
  try {
    state = await api('/api/admin/state');
  } catch (e) {
    if (e.status === 401 || e.authRequired) {
      showLogin();
      return;
    }
    toast('ProdDash server unreachable — retrying…', true);
    setTimeout(loadState, 4000);
    return;
  }
  loginCard.hidden = true;
  modulesSection.hidden = false;
  availableSection.hidden = false;
  shellVersion = String(state.version || '');
  shellVersionEl.textContent = shellVersion ? 'v' + shellVersion : '';
  const storageNote = document.getElementById('storage-note');
  if (state.dataDir) {
    document.getElementById('storage-path').textContent = state.dataDir;
    storageNote.hidden = false;
  }
  modulesList.innerHTML = '';
  liveEls.clear();
  for (const mod of state.modules || []) {
    modulesList.appendChild(buildModuleCard(mod));
  }
  loadLayouts();
  loadCatalog(false);
}

/* ── the repo: available modules, module updates, shell update ──────── */

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

async function loadCatalog(refresh) {
  catalogStatus.className = 'admin-status';
  catalogStatus.textContent = refresh ? 'Checking the repo…' : 'Checking…';
  let cat;
  try {
    cat = await api('/api/admin/catalog' + (refresh ? '?refresh=1' : ''));
  } catch (e) {
    if (e.authRequired) return showLogin();
    catalogStatus.className = 'admin-status error';
    catalogStatus.textContent = e.message;
    return;
  }
  renderShell(cat.shell || {});
  renderAvailable(cat);
}

function renderShell(shell) {
  const remote = shell.remote || {};
  if (remote.error) {
    catalogStatus.className = 'admin-status error';
    catalogStatus.textContent = `Couldn't reach ${shell.repo}: ${remote.error}`;
  } else {
    catalogStatus.className = 'admin-status';
    catalogStatus.textContent = `${shell.repo}@${shell.branch}` +
      (remote.version ? ` · latest ProdDash ${remote.version}` : '') +
      (remote.checkedAt ? ` · checked ${fmtTime(remote.checkedAt)}` : '');
  }
  if (!shell.updateAvailable) {
    updateCard.hidden = true;
    return;
  }
  updateCard.hidden = false;
  updateTitle.textContent = shell.versionBehind
    ? `ProdDash ${remote.version} is available`
    : `New commits on ${shell.branch}`;
  const where = shell.local?.isGit
    ? `a git checkout of ${shell.local.branch} at ${String(shell.local.sha || '').slice(0, 7)}; updating runs git pull`
    : 'not a git checkout; updating unpacks the repo archive over the app folder';
  updateCopy.textContent = `You're running ProdDash ${shell.version} (${where}). Settings and layouts live outside the app folder and are not touched.`;
  updateChanges.href = shell.changesUrl || '#';
  updateBtn.disabled = Boolean(shell.updateBlocker) || updateBtn.dataset.busy === '1';
  if (shell.updateBlocker) {
    updateStatus.className = 'admin-status error';
    updateStatus.textContent = `Can't update from here: ${shell.updateBlocker}.`;
  } else if (updateBtn.dataset.busy !== '1') {
    updateStatus.className = 'admin-status';
    updateStatus.textContent = 'Updating restarts ProdDash; open dashboards reconnect on their own.';
  }
}

function renderAvailable(cat) {
  availableList.innerHTML = '';
  const updates = cat.updates || [];
  // newer versions of installed modules → a button on their card
  for (const els of liveEls.values()) els.updateSlot.innerHTML = '';
  for (const up of updates) {
    const els = liveEls.get(up.id);
    if (!els) continue;
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = `Update to v${up.version}`;
    btn.disabled = !up.compatible;
    btn.title = up.compatible ? `Download v${up.version} from the repo` : up.reason;
    btn.addEventListener('click', () => installFromCatalog(up, btn));
    els.updateSlot.appendChild(btn);
  }
  const available = cat.available || [];
  if (!available.length) {
    const none = document.createElement('div');
    none.className = 'layouts-empty';
    none.textContent = cat.shell?.remote?.error
      ? 'The repo could not be reached, and nothing bundled is waiting to be installed.'
      : 'Everything the repo offers is installed.';
    availableList.appendChild(none);
    return;
  }
  for (const item of available) {
    const row = document.createElement('div');
    row.className = 'catalog-row';
    const main = document.createElement('div');
    main.className = 'catalog-main';
    const title = document.createElement('div');
    title.className = 'catalog-title';
    const name = document.createElement('span');
    name.className = 'module-name';
    name.textContent = item.name;
    const version = document.createElement('span');
    version.className = 'module-version';
    version.textContent = item.version ? 'v' + item.version : '';
    const source = document.createElement('span');
    source.className = 'module-source';
    source.textContent = item.source === 'bundled' ? 'bundled' : 'repo';
    source.title = item.source === 'bundled' ? 'Ships with this copy of ProdDash — restoring it downloads nothing' : 'Downloaded from the repo';
    title.append(name, version, source);
    const desc = document.createElement('div');
    desc.className = 'module-desc';
    desc.textContent = item.description || '';
    const req = document.createElement('div');
    req.className = 'module-health' + (item.compatible ? '' : ' error');
    req.textContent = item.compatible
      ? (item.requires ? `Requires ProdDash ${item.requires}` : '')
      : item.reason;
    main.append(title, desc, req);
    const btn = document.createElement('button');
    btn.className = 'btn small primary';
    btn.textContent = 'Install';
    btn.disabled = !item.compatible;
    btn.title = item.compatible ? '' : item.reason;
    btn.addEventListener('click', () => installFromCatalog(item, btn));
    row.append(main, btn);
    availableList.appendChild(row);
  }
}

async function installFromCatalog(item, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Installing…';
  try {
    const r = await api(`/api/admin/modules/${encodeURIComponent(item.id)}/install`, { method: 'POST', body: '{}' });
    toast(`${item.name} ${r.downloaded ? 'installed' : 'restored'}${r.version ? ' (v' + r.version + ')' : ''}`);
    await loadState();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    if (e.authRequired) showLogin();
    else toast(e.message, true);
  }
}

document.getElementById('catalog-refresh').addEventListener('click', () => loadCatalog(true));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** After the update the server exits and comes back; wait for it. */
async function waitForRestart(before) {
  const started = Date.now();
  let sawDown = false;
  while (Date.now() - started < 90000) {
    await sleep(1500);
    try {
      const s = await api('/api/admin/state');
      if (sawDown || s.version !== before) {
        toast(`ProdDash ${s.version} is running`);
        await sleep(600);
        location.reload();
        return;
      }
    } catch (e) {
      if (e.status === 401) { location.reload(); return; } // back up, passcode wanted again
      sawDown = true;
    }
  }
  updateStatus.className = 'admin-status error';
  updateStatus.textContent = 'ProdDash did not come back on its own — start it again on the server, then reload this page.';
  updateBtn.dataset.busy = '';
  updateBtn.disabled = false;
}

updateBtn.addEventListener('click', async () => {
  if (!window.confirm('Update ProdDash now? The server restarts and every open dashboard reconnects a few seconds later.')) return;
  updateBtn.dataset.busy = '1';
  updateBtn.disabled = true;
  updateStatus.className = 'admin-status';
  updateStatus.textContent = 'Updating…';
  const before = shellVersion;
  try {
    const r = await api('/api/admin/update', { method: 'POST', body: '{}' });
    updateStatus.textContent = `Updated ${r.from} → ${r.to || 'latest commit'} via ${r.method}. Restarting…`;
  } catch (e) {
    updateStatus.className = 'admin-status error';
    updateStatus.textContent = e.message;
    updateBtn.dataset.busy = '';
    updateBtn.disabled = false;
    if (e.authRequired) showLogin();
    return;
  }
  await waitForRestart(before);
});

setInterval(() => {
  if (modulesSection.hidden) return;
  refreshStatus();
}, 5000);

loadState();
