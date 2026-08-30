'use strict';

/**
 * Config storage for the standalone Now/Next display.
 *
 * The file format matches the Band Lineup app's credential files (an `enc:` prefix
 * for OS-encrypted secrets, `plain:` for base64) so the two programs stay readable
 * to each other. Under Electron we use safeStorage; under plain `node server.js`
 * there is no OS keychain hook, so the password is base64-obfuscated at rest —
 * treat the config file as a secret either way.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');

const DEFAULT_CONFIG = {
  enabled: false,
  host: '',
  port: 0,
  password: '',
};

/** Electron's safeStorage when available (kiosk mode); null under plain Node. */
function safeStorage() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    if (electron?.safeStorage?.isEncryptionAvailable?.()) return electron.safeStorage;
  } catch {
    /* not running under Electron */
  }
  return null;
}

function encodeSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  const store = safeStorage();
  if (store) return `enc:${store.encryptString(text).toString('base64')}`;
  return `plain:${Buffer.from(text, 'utf8').toString('base64')}`;
}

function decodeSecret(value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (raw.startsWith('enc:')) {
    const store = safeStorage();
    if (!store) return ''; // written under Electron, now read by plain Node — can't decrypt
    try {
      return store.decryptString(Buffer.from(raw.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  if (raw.startsWith('plain:')) return Buffer.from(raw.slice(6), 'base64').toString('utf8');
  return raw;
}

/**
 * Where config.json lives. Override with PP_DISPLAY_DATA_DIR (handy on a NAS or
 * when several displays share one host). Electron callers pass app.getPath('userData').
 */
function resolveDataDir(preferred) {
  const fromEnv = process.env.PP_DISPLAY_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (preferred) return path.resolve(preferred);
  return path.join(__dirname, 'data');
}

function configPath(dataDir) {
  return path.join(dataDir, 'config.json');
}

function normalize(entry) {
  const host = String(entry?.host || '').trim();
  const portNum = Number.parseInt(String(entry?.port ?? ''), 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 0;
  return {
    enabled: Boolean(entry?.enabled) && Boolean(host) && Boolean(port),
    host,
    port,
    password: String(entry?.password || ''),
  };
}

function loadConfig(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(dataDir), 'utf8'));
    return normalize({
      enabled: raw.enabled,
      host: raw.host,
      port: raw.port,
      password: decodeSecret(raw.password),
    });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(dataDir, config) {
  const clean = normalize(config);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    configPath(dataDir),
    JSON.stringify(
      {
        enabled: clean.enabled,
        host: clean.host,
        port: clean.port,
        password: encodeSecret(clean.password),
      },
      null,
      2,
    ),
    'utf8',
  );
  return clean;
}

/* ------------------------------------------------------------------ *
 * Which address should someone actually bookmark?                     *
 *                                                                     *
 * An A/V machine backstage is the worst case: alongside the house LAN  *
 * LAN it often has a camera/Dante network, a VPN tunnel, and on Windows *
 * Hyper-V/WSL switches that hand out plausible-looking 192.168.x       *
 * addresses. Listing every non-internal IPv4 unranked (what we used to  *
 * do) gives a volunteer five equal-looking URLs and no way to choose.  *
 * So: hard-filter the impossible ones, score the rest, and let two     *
 * stronger signals override the score — the OS's own default route,    *
 * and (best of all) the local address a real viewer actually reached   *
 * us on.                                                              *
 * ------------------------------------------------------------------ */

/** Adapter names that are never the church LAN. Windows keys are friendly names. */
const VIRTUAL_IFACE = [
  /vethernet/i, /hyper-?v/i, /\bwsl\b/i, /virtualbox/i, /vmware/i, /vmnet/i, /docker/i,
  /tailscale/i, /zerotier/i, /wintun/i, /wireguard/i, /nordlynx/i, /openvpn/i, /^tap-/i,
  /radmin/i, /hamachi/i, /npcap/i, /bluetooth/i, /teredo/i, /isatap/i, /wan miniport/i,
  /loopback pseudo/i, /^utun/i, /^awdl/i, /^llw/i, /^bridge/i, /^ipsec/i, /^gif/i, /^stf/i,
];

/** Addresses that can never carry a bookmark, whatever adapter they came from. */
function isImpossibleAddress(address) {
  if (/^169\.254\./.test(address)) return true;                                  // DHCP failed on that NIC
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return true;     // CGNAT / Tailscale
  if (/^25\./.test(address)) return true;                                        // Hamachi
  if (/^192\.168\.56\./.test(address)) return true;                              // VirtualBox host-only default
  return false;
}

function isPrivate(address) {
  return /^10\./.test(address)
    || /^192\.168\./.test(address)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

/** Locally-administered MAC bit — set on virtual/bridged adapters. */
function isLocallyAdministeredMac(mac) {
  const firstOctet = Number.parseInt(String(mac || '').split(':')[0], 16);
  return Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0;
}

function scoreAddress(entry, ifaceName) {
  let score = 0;
  if (/^192\.168\./.test(entry.address)) score += 40;        // overwhelmingly the church-LAN shape
  else if (/^10\./.test(entry.address)) score += 30;
  else if (/^172\./.test(entry.address)) score += 20;
  else score -= 60;                                          // public or unrecognised
  if (entry.netmask === '255.255.255.0') score += 10;
  if (/^ethernet/i.test(ifaceName)) score += 8;              // prefer wired on an A/V machine
  else if (/wi-?fi|wlan|^en0$/i.test(ifaceName)) score += 4;
  if (isLocallyAdministeredMac(entry.mac)) score -= 25;
  return score;
}

/**
 * Ranked candidate addresses for viewers, best first.
 * @param {object} [hints]
 * @param {string} [hints.defaultRoute] Address of the interface holding the default route.
 * @param {string[]} [hints.observed] Local addresses real viewers have already connected to.
 */
function viewerAddresses(hints = {}) {
  const defaultRoute = String(hints.defaultRoute || '');
  const observed = new Set((hints.observed || []).filter(Boolean));
  const out = [];
  const interfaces = os.networkInterfaces();

  for (const [ifaceName, entries] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE.some((pattern) => pattern.test(ifaceName))) continue;
    for (const entry of entries || []) {
      // Node <18 reported family as a string, newer as the number 4 — accept both.
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal) continue;
      if (isImpossibleAddress(entry.address)) continue;
      if (entry.mac === '00:00:00:00:00:00') continue;        // tunnel / pseudo adapter

      let score = scoreAddress(entry, ifaceName);
      if (entry.address === defaultRoute) score += 100;       // the OS's own answer beats any heuristic
      const confirmed = observed.has(entry.address);
      if (confirmed) score += 1000;                           // a real viewer reached us here

      out.push({
        address: entry.address,
        iface: ifaceName,
        netmask: entry.netmask,
        private: isPrivate(entry.address),
        confirmed,
        score,
      });
    }
  }

  out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return out;
}

/**
 * The address on the interface that holds the default route, per the OS routing table.
 * A UDP "connect" sends no packets — it only asks the kernel which source address it
 * would use — so this is free and side-effect-less.
 */
function defaultRouteAddress() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      done('');
      return;
    }
    socket.once('error', () => {
      try { socket.close(); } catch { /* already closed */ }
      done('');
    });
    const timer = setTimeout(() => {
      try { socket.close(); } catch { /* already closed */ }
      done('');
    }, 400);
    timer.unref?.();
    try {
      socket.connect(53, '203.0.113.1', () => {   // RFC 5737 documentation address; nothing is sent
        let address = '';
        try { address = socket.address().address || ''; } catch { /* ignore */ }
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closed */ }
        done(address);
      });
    } catch {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      done('');
    }
  });
}

/** Legacy helper: flat list of plausible addresses, best first. */
function lanAddresses() {
  return viewerAddresses().map((entry) => entry.address);
}

module.exports = {
  DEFAULT_CONFIG,
  resolveDataDir,
  configPath,
  loadConfig,
  saveConfig,
  normalize,
  lanAddresses,
  viewerAddresses,
  defaultRouteAddress,
};
