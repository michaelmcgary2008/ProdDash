'use strict';

/**
 * Built-in LTC listener — capture child + in-process decode.
 *
 * Spawns the module's native capture tool (ltc-capture, compiled from
 * ltc-capture.swift beside it) for the admin-configured audio device, reads
 * the interleaved s16le stream, extracts the configured channel, and decodes
 * SMPTE LTC with ltc.js — all inside the module server. Reports upward via
 * onUpdate roughly 4×/s:
 *
 *   { state: 'running'|'stopped'|'nosignal', time, fps, df }   healthy
 *   { error: '<what is wrong and how to fix it>' }             not capturing
 *
 * The capture binary is per-machine (gitignored): if it is missing this
 * tries one swiftc compile of the source next to it, and otherwise says to
 * build it on any same-architecture Mac and copy it over. A dead child is
 * restarted with backoff — fast for a crash, slow for config-shaped
 * failures (unknown device, ambiguous name) that never fix themselves.
 *
 * macOS gotcha this file can't fix: microphone permission. A ProdDash
 * server launched over SSH or from a bare launchd job gets SILENT ZEROS
 * from every input (no error!), which shows up here as endless 'nosignal'.
 * Launch ProdDash from a logged-in GUI context (Start ProdDash.command)
 * and approve the mic prompt once.
 */

const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { LtcDecoder, ChannelExtractor, fmtTc } = require('./ltc');

const RESTART_MS = 5000;
/** An immediate exit is config-shaped (bad device name, ambiguity) — a fast
    retry loop would just spam the log. */
const BAD_CONFIG_RETRY_MS = 30000;
const EVAL_MS = 250;
/** Frames must decode AND advance this recently to count as running. */
const RUNNING_WINDOW_MS = 400;

/** stderr line the capture prints once the device is open. */
const CAPTURING_RE = /capturing "(.+)": (\d+) channels @ (\d+) Hz/;

/**
 * @param {{device:string, channel:number, moduleDir:string, log:Function,
 *          onUpdate:(u:object)=>void}} opts
 * @returns {{stop:()=>void}}
 */
function createLtcListener({ device, channel, moduleDir, log, onUpdate }) {
  const bin = path.join(moduleDir, 'ltc-capture');
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let evalTimer = null;
  let startedAt = 0;

  let lastTc = '';
  let fps = 0;
  let df = false;
  let lastFrameWall = 0;
  let lastChangeWall = 0;
  let lastSent = '';

  function report(update) {
    const key = JSON.stringify(update);
    if (key === lastSent) return;
    lastSent = key;
    onUpdate(update);
  }

  function snapshotState() {
    const now = Date.now();
    if (now - lastFrameWall < RUNNING_WINDOW_MS && now - lastChangeWall < RUNNING_WINDOW_MS) return 'running';
    if (lastTc) return 'stopped';
    return 'nosignal';
  }

  function ensureBinary() {
    if (fs.existsSync(bin)) return '';
    const src = bin + '.swift';
    log('ltc-capture binary missing — trying a one-time swiftc build');
    const built = spawnSync('swiftc', ['-O', '-o', bin, src], { timeout: 120000 });
    if (built.status === 0 && fs.existsSync(bin)) {
      log('ltc-capture compiled');
      return '';
    }
    return 'LTC capture tool missing — build it on any Apple Silicon Mac with '
      + '`swiftc -O -o modules/propresenter-timers/ltc-capture modules/propresenter-timers/ltc-capture.swift` '
      + 'and copy it here';
  }

  function start() {
    if (stopped) return;
    const missing = ensureBinary();
    if (missing) {
      report({ error: missing });
      scheduleRestart(BAD_CONFIG_RETRY_MS);
      return;
    }

    startedAt = Date.now();
    let extractor = null;
    let decoder = null;
    let stderrTail = '';

    child = spawn(bin, ['--device', device], { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      stderrTail = (stderrTail + text).slice(-500);
      const m = text.match(CAPTURING_RE);
      if (!m) return;
      const channels = Number(m[2]);
      const rate = Number(m[3]);
      if (channel > channels) {
        report({ error: `"${m[1]}" has ${channels} input channels — channel ${channel} is configured. Fix it in Admin.` });
        try { child.kill(); } catch { /* exiting anyway */ }
        return;
      }
      log(`LTC listener: capturing "${m[1]}" (${channels} ch @ ${rate} Hz), decoding channel ${channel}`);
      extractor = new ChannelExtractor(channels, channel);
      decoder = new LtcDecoder(rate, (frame) => {
        const tc = fmtTc(frame);
        const now = Date.now();
        if (tc !== lastTc) lastChangeWall = now;
        lastTc = tc;
        fps = frame.fps;
        df = frame.df;
        lastFrameWall = now;
      });
    });

    child.stdout.on('data', (buf) => {
      if (extractor && decoder) decoder.push(extractor.push(buf));
    });

    child.on('error', (err) => {
      report({ error: `LTC capture failed to start: ${err.message}` });
    });

    child.on('exit', (code) => {
      child = null;
      if (stopped) return;
      // The capture's own failure text (unknown device, ambiguous name,
      // permission hint) is the most useful thing we can show.
      const said = stderrTail.split('\n').reverse().find((l) => l.includes('ltc-capture:') && !CAPTURING_RE.test(l));
      const quickDeath = Date.now() - startedAt < 3000;
      report({ error: (said ? said.replace(/^.*ltc-capture:\s*/, '') : `LTC capture exited (code ${code})`) + (quickDeath ? '' : ' — restarting') });
      scheduleRestart(quickDeath ? BAD_CONFIG_RETRY_MS : RESTART_MS);
    });
  }

  function scheduleRestart(ms) {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, ms);
    restartTimer.unref?.();
  }

  evalTimer = setInterval(() => {
    if (stopped || !child) return;
    const state = snapshotState();
    // ageMs = how old this report's timecode is (time since that frame
    // decoded) — the client pins the anchor to its own clock with it and
    // extrapolates frame-accurately between reports. Only while running:
    // a held frame has no meaningful age, and a varying field would defeat
    // the report dedupe while stopped.
    const update = { state, time: lastTc, fps, df };
    if (state === 'running') update.ageMs = Date.now() - lastFrameWall;
    report(update);
  }, EVAL_MS);
  evalTimer.unref?.();

  start();

  return {
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      clearInterval(evalTimer);
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
    },
  };
}

module.exports = { createLtcListener };
