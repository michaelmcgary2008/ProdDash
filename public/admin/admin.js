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
  layoutsSection.hidden = true;
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

function fieldFor(key, spec, value, passwordSet) {
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
  } else if (type === 'select' && Array.isArray(spec.options)) {
    const span = document.createElement('span');
    span.textContent = label;
    const select = document.createElement('select');
    for (const opt of spec.options) {
      const o = document.createElement('option');
      o.value = String(typeof opt === 'object' ? opt.value : opt);
      o.textContent = String(typeof opt === 'object' ? (opt.label ?? opt.value) : opt);
      select.appendChild(o);
    }
    select.value = String(value ?? '');
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

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

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

  head.append(dot, name, version, spacer, toggleLabel);
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
  mountError.hidden = !mod.mountError;
  mountError.textContent = mod.mountError ? `Failed to start: ${mod.mountError}` : '';
  card.appendChild(mountError);

  liveEls.set(mod.id, { dot, healthEl, toggle, toggleText, mountError });

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
      const { field, read } = fieldFor(key, spec, mod.config[key], mod.passwordSet[key]);
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
    els.mountError.hidden = !mod.mountError;
    els.mountError.textContent = mod.mountError ? `Failed to start: ${mod.mountError}` : '';
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
  modulesList.innerHTML = '';
  liveEls.clear();
  for (const mod of state.modules || []) {
    modulesList.appendChild(buildModuleCard(mod));
  }
  loadLayouts();
}

setInterval(() => {
  if (modulesSection.hidden) return;
  refreshStatus();
}, 5000);

loadState();
