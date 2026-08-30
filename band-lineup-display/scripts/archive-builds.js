'use strict';

/**
 * Keep old installers instead of overwriting them.
 *
 * Runs automatically after `npm run dist` (see the "postdist" script). The freshly built
 * version stays at the top level of dist/ so there is never a question about which file to
 * install; every older version is moved into dist/archive/ and the archive is pruned to the
 * most recent KEEP_VERSIONS so the folder cannot grow without bound.
 *
 * Zero dependencies. Set DIST_DIR to point it somewhere else (used by the tests).
 */

const fs = require('fs');
const path = require('path');

/** How many previous versions to keep. Each version is ~460 MB (installer + portable). */
const KEEP_VERSIONS = 5;

const ROOT = path.join(__dirname, '..');
const DIST = process.env.DIST_DIR || path.join(ROOT, 'dist');
const ARCHIVE = path.join(DIST, 'archive');

/** Pull "1.2.1" out of "Band Lineup Setup 1.2.1.exe". */
function versionOf(fileName) {
  const match = fileName.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function currentVersion() {
  if (process.env.CURRENT_VERSION) return process.env.CURRENT_VERSION;
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
}

/** Installer-ish artifacts worth keeping. Build scratch (win-unpacked, logs) is left alone. */
function isArtifact(fileName) {
  return /\.(exe|blockmap|dmg|zip|appx|msi)$/i.test(fileName);
}

function humanSize(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function run() {
  if (!fs.existsSync(DIST)) {
    console.log('[archive-builds] no dist/ yet — nothing to do');
    return;
  }
  const version = currentVersion();
  fs.mkdirSync(ARCHIVE, { recursive: true });

  // 1. Move anything that isn't the current version out of the way.
  let moved = 0;
  for (const name of fs.readdirSync(DIST)) {
    const from = path.join(DIST, name);
    if (!fs.statSync(from).isFile() || !isArtifact(name)) continue;
    const fileVersion = versionOf(name);
    if (!fileVersion || fileVersion === version) continue;
    const to = path.join(ARCHIVE, name);
    fs.renameSync(from, to);
    moved += 1;
    console.log(`[archive-builds] archived ${name}`);
  }

  // 2. Prune the archive to the newest KEEP_VERSIONS, by version number.
  const byVersion = new Map();
  for (const name of fs.readdirSync(ARCHIVE)) {
    const full = path.join(ARCHIVE, name);
    if (!fs.statSync(full).isFile() || !isArtifact(name)) continue;
    const fileVersion = versionOf(name);
    if (!fileVersion) continue;
    if (!byVersion.has(fileVersion)) byVersion.set(fileVersion, []);
    byVersion.get(fileVersion).push(full);
  }
  const versions = [...byVersion.keys()].sort(compareVersions).reverse();
  const drop = versions.slice(KEEP_VERSIONS);
  for (const old of drop) {
    for (const file of byVersion.get(old)) {
      fs.unlinkSync(file);
    }
    console.log(`[archive-builds] pruned ${old} (keeping the newest ${KEEP_VERSIONS})`);
  }

  const kept = versions.slice(0, KEEP_VERSIONS);
  let bytes = 0;
  for (const v of kept) {
    for (const file of byVersion.get(v)) bytes += fs.statSync(file).size;
  }
  console.log(
    `[archive-builds] current: ${version} in dist/ | archived: ${kept.join(', ') || 'none yet'}`
    + (bytes ? ` (${humanSize(bytes)})` : ''),
  );
  if (!moved && !kept.length) console.log('[archive-builds] first run — nothing to archive yet');
}

run();
