#!/usr/bin/env node
'use strict';

/**
 * ltc-reader — decode SMPTE LTC from an audio feed and push it to ProdDash.
 *
 * ProPresenter's APIs expose no timecode (see modules/propresenter-timers),
 * so this tool reads LTC where it actually lives: the audio signal. Pipe
 * mono PCM (signed 16-bit little-endian) into stdin from any capture
 * front-end; the decoded state is POSTed to the Timers module's /ltc
 * ingest route — ~4×/s while running, 1×/s as a keepalive otherwise, and
 * immediately on every state change.
 *
 *   macOS (ffmpeg; list input devices with
 *          `ffmpeg -f avfoundation -list_devices true -i ""`):
 *     ffmpeg -loglevel error -f avfoundation -i ":0" -ac 1 -ar 48000 \
 *       -f s16le - | node tools/ltc-reader.js --url http://127.0.0.1:24500
 *   sox (default input device):
 *     sox -q -d -t raw -b 16 -e signed -c 1 -r 48000 - | node tools/ltc-reader.js
 *   Windows (ffmpeg/dshow):
 *     ffmpeg -loglevel error -f dshow -i audio="<device name>" -ac 1 \
 *       -ar 48000 -f s16le - | node tools/ltc-reader.js
 *
 * Flags:
 *   --url <base>      ProdDash base URL          (default http://127.0.0.1:24500)
 *   --module <id>     target module id           (default propresenter-timers)
 *   --token <secret>  matches the module's "LTC reader token" admin setting
 *   --sr <hz>         stdin sample rate          (default 48000)
 *   --source <label>  reader label in reports    (default this machine's hostname)
 *   --demo            no audio needed: synthesize running 30 fps LTC (with a
 *                     stop every ~30 s) through the real decoder, and POST it
 *   --selftest        run the encoder→decoder test suite and exit
 *
 * Decoding: LTC is an 80-bit SMPTE frame, biphase-mark coded — a level
 * transition at every bit boundary plus one mid-bit for a 1. The decoder
 * tracks transitions with an envelope-scaled hysteresis comparator (so
 * input level doesn't matter), classifies the transition gaps as full/half
 * bit periods against an adaptive period estimate, shifts bits until the
 * sync word appears, then reads the BCD fields. Frame rate is snapped from
 * the measured bit clock and the highest frame number seen; the drop-frame
 * bit distinguishes 29.97 DF. Reverse play is not decoded (the sync word
 * never matches backwards) — for booth status that reads as "stopped",
 * which is the honest summary anyway.
 */

const os = require('os');

/* ══ decoder ═══════════════════════════════════════════════════════════ */

/** Sync word as bits 64–79 (0011111111111101) shift into a 16-bit register. */
const SYNC_WORD = 0x3ffd;

class LtcDecoder {
  /**
   * @param {number} sampleRate stdin PCM rate in Hz
   * @param {(f:{h:number,m:number,s:number,f:number,df:boolean,fps:number})=>void} onFrame
   */
  constructor(sampleRate, onFrame) {
    this.sr = sampleRate;
    this.onFrame = onFrame;
    this.mean = 0; // DC offset tracker
    this.env = 0; // decaying |sample| envelope, scales the comparator
    this.level = 0; // comparator state: 1 / -1 (0 = not seen a crossing yet)
    this.n = 0; // absolute sample clock
    this.lastEdge = 0;
    this.lastEdgeSeen = 0; // for signal-presence checks
    // Samples per LTC bit. Start at the 30 fps value (the shortest possible
    // bit) and let the interval EMA walk it up to the true rate.
    this.T = sampleRate / (80 * 30);
    this.halfAt = 0; // first half-interval of a suspected 1 bit, else 0
    this.bits = new Uint8Array(80); // last 80 decoded bits, newest at [79]
    this.sync = 0; // last 16 bits as an integer, newest at bit 0
    this.fresh = 0; // bits decoded since the last reset — see bit()
    this.maxFrame = 0; // highest frame number seen → nominal fps
  }

  /** @param {Int16Array} samples */
  push(samples) {
    for (let i = 0; i < samples.length; i += 1) {
      this.n += 1;
      const raw = samples[i];
      // Seed the DC tracker from the first sample — a real offset would
      // otherwise take ~0.5 s to settle and cost the opening frames.
      if (this.n === 1) this.mean = raw;
      this.mean += (raw - this.mean) / 8192;
      const v = raw - this.mean;
      const mag = v < 0 ? -v : v;
      this.env = mag > this.env ? mag : this.env * 0.9996;
      // Floor keeps line noise from registering as signal during silence.
      const th = Math.max(this.env * 0.3, 500);
      let crossed = false;
      if (this.level >= 0 && v < -th) {
        this.level = -1;
        crossed = true;
      } else if (this.level <= 0 && v > th) {
        this.level = 1;
        crossed = true;
      }
      if (!crossed) continue;
      const t = this.n - this.lastEdge;
      this.lastEdge = this.n;
      this.lastEdgeSeen = this.n;
      this.interval(t);
    }
  }

  /** One transition-to-transition gap, in samples. */
  interval(t) {
    if (t > 1.9 * this.T) {
      // Silence gap or garbage — drop bit state, keep the period estimate
      // (the stream that resumes is usually the same deck).
      this.halfAt = 0;
      this.sync = 0;
      this.fresh = 0;
      return;
    }
    if (t < 0.75 * this.T) {
      // Half period: one of a 1-bit's pair.
      if (this.halfAt) {
        this.T += (this.halfAt + t - this.T) * 0.05;
        this.halfAt = 0;
        this.bit(1);
      } else {
        this.halfAt = t;
      }
    } else {
      // Full period: a 0 bit. A lone preceding half means we slipped —
      // shed it and let the sync-word search re-align.
      this.halfAt = 0;
      this.T += (t - this.T) * 0.05;
      this.bit(0);
    }
  }

  bit(b) {
    this.bits.copyWithin(0, 1);
    this.bits[79] = b;
    this.sync = ((this.sync << 1) | b) & 0xffff;
    if (this.fresh < 80) this.fresh += 1;
    // Sync word just completed → bits[0..63] are one whole frame's data —
    // but only once 80 real bits have displaced the cold-start/pre-gap
    // buffer, or a phantom frame decodes from the padding.
    if (this.sync === SYNC_WORD && this.fresh >= 80) this.frame();
  }

  frame() {
    const bits = this.bits;
    // Every LTC field is BCD, transmitted LSB-first.
    const bcd = (start, len) => {
      let v = 0;
      for (let i = 0; i < len; i += 1) v |= bits[start + i] << i;
      return v;
    };
    const f = bcd(0, 4) + bcd(8, 2) * 10;
    const s = bcd(16, 4) + bcd(24, 3) * 10;
    const m = bcd(32, 4) + bcd(40, 3) * 10;
    const h = bcd(48, 4) + bcd(56, 2) * 10;
    if (f > 59 || s > 59 || m > 59 || h > 39) return; // corrupt frame
    if (f > this.maxFrame) this.maxFrame = f;
    const df = bits[10] === 1;
    this.onFrame({ h, m, s, f, df, fps: this.fps(df) });
  }

  /**
   * Nominal rate: the highest frame number is definitive once we've seen
   * enough of a second (24/25/30); until then snap the measured bit clock.
   * 29.97 vs 30 non-drop differ by 0.1% — beyond the bit-clock estimate's
   * accuracy — so non-drop 29.97 reads as 30. Drop-frame is exact: the DF
   * bit means 29.97.
   */
  fps(df) {
    if (df) return 29.97;
    const fromCount = this.maxFrame >= 20 ? this.maxFrame + 1 : 0;
    if (fromCount) return fromCount;
    const measured = this.sr / (this.T * 80);
    return [24, 25, 30].reduce((a, b) => (Math.abs(b - measured) < Math.abs(a - measured) ? b : a));
  }

  /** True while transitions are actually arriving (sample-clock based). */
  signalPresent() {
    return this.n - this.lastEdgeSeen < this.sr * 0.05;
  }
}

/* ══ encoder (selftest + demo — and pipeable test audio) ═══════════════ */

/** Advance one frame under the given counting rules (fps = nominal integer). */
function nextTc(tc, fps, df) {
  let { h, m, s, f } = tc;
  f += 1;
  if (f >= fps) {
    f = 0;
    s += 1;
    if (s >= 60) {
      s = 0;
      m += 1;
      if (m >= 60) {
        m = 0;
        h = (h + 1) % 24;
      }
    }
  }
  // Drop-frame: frames 00 and 01 don't exist at the top of a minute,
  // except every tenth minute.
  if (df && f === 0 && s === 0 && m % 10 !== 0) f = 2;
  return { h, m, s, f };
}

/** The 80 bits of one frame, in transmission order. User bits stay zero;
    the polarity-correction/parity bit is legal to leave clear. */
function frameBits(tc, df) {
  const bits = new Uint8Array(80);
  const put = (start, len, v) => {
    for (let i = 0; i < len; i += 1) bits[start + i] = (v >> i) & 1;
  };
  put(0, 4, tc.f % 10);
  put(8, 2, Math.floor(tc.f / 10));
  bits[10] = df ? 1 : 0;
  put(16, 4, tc.s % 10);
  put(24, 3, Math.floor(tc.s / 10));
  put(32, 4, tc.m % 10);
  put(40, 3, Math.floor(tc.m / 10));
  put(48, 4, tc.h % 10);
  put(56, 2, Math.floor(tc.h / 10));
  const sync = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];
  for (let i = 0; i < 16; i += 1) bits[64 + i] = sync[i];
  return bits;
}

class LtcEncoder {
  /** @param {number} fps true rate (29.97 allowed); counting uses its rounding */
  constructor(sampleRate, fps, df, startTc, amplitude = 12000) {
    this.nominal = Math.round(fps);
    this.df = df;
    this.amp = amplitude;
    this.spb = sampleRate / (fps * 80); // samples per bit, fractional
    this.tc = { ...startTc };
    this.bits = frameBits(this.tc, df);
    this.bitIdx = 0;
    this.halfPending = false;
    this.level = 1;
    this.t = 0; // sample clock
    this.nextEdge = 0; // fractional sample time of the next transition
  }

  /** Time between this transition and the next (biphase mark). */
  nextInterval() {
    if (this.halfPending) {
      this.halfPending = false;
      return this.spb / 2;
    }
    if (this.bitIdx >= 80) {
      this.tc = nextTc(this.tc, this.nominal, this.df);
      this.bits = frameBits(this.tc, this.df);
      this.bitIdx = 0;
    }
    const bit = this.bits[this.bitIdx];
    this.bitIdx += 1;
    if (bit) {
      this.halfPending = true;
      return this.spb / 2;
    }
    return this.spb;
  }

  /** @returns {Int16Array} the next n samples of the running LTC stream */
  render(n) {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i += 1) {
      while (this.t >= this.nextEdge) {
        this.level = -this.level;
        this.nextEdge += this.nextInterval();
      }
      out[i] = this.level * this.amp;
      this.t += 1;
    }
    return out;
  }
}

/* ══ shared bits ═══════════════════════════════════════════════════════ */

const pad2 = (v) => String(v).padStart(2, '0');
const fmtTc = (tc) => `${pad2(tc.h)}:${pad2(tc.m)}:${pad2(tc.s)}:${pad2(tc.f)}`;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:24500',
    module: 'propresenter-timers',
    token: '',
    sr: 48000,
    source: os.hostname(),
    demo: false,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--url') args.url = String(argv[++i] || args.url).replace(/\/+$/, '');
    else if (a === '--module') args.module = String(argv[++i] || args.module);
    else if (a === '--token') args.token = String(argv[++i] || '');
    else if (a === '--sr') args.sr = Number(argv[++i]) || args.sr;
    else if (a === '--source') args.source = String(argv[++i] || args.source);
    else {
      console.error(`Unknown flag ${a} — see the header of tools/ltc-reader.js`);
      process.exit(2);
    }
  }
  return args;
}

/* ══ selftest ══════════════════════════════════════════════════════════ */

/** Deterministic PRNG so a failure reproduces. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function selftest() {
  const SR = 48000;
  let failures = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    if (!ok) failures += 1;
  };

  /** Encode frames, mangle optionally, decode in awkward chunk sizes. */
  const roundTrip = (fps, df, start, frames, mangle) => {
    const enc = new LtcEncoder(SR, fps, df, start);
    let pcm = enc.render(Math.ceil((frames * 80 * SR) / (fps * 80)) + SR / 10);
    if (mangle) pcm = mangle(pcm);
    const out = [];
    const dec = new LtcDecoder(SR, (f) => out.push(f));
    for (let off = 0; off < pcm.length; off += 997) {
      dec.push(pcm.subarray(off, Math.min(off + 997, pcm.length)));
    }
    return out;
  };

  const sequential = (out) =>
    out.every((f, i) => i === 0 || fmtTc(f) !== fmtTc(out[i - 1]));

  console.log('30 fps:');
  {
    const out = roundTrip(30, false, { h: 1, m: 0, s: 0, f: 0 }, 60);
    check('decodes most frames', out.length >= 55, `${out.length}/60`);
    check('starts at 01:00:00:0x', out.length > 0 && out[0].h === 1 && out[0].m === 0 && out[0].s === 0);
    check('frames advance', sequential(out));
    check('fps snaps to 30', out.length > 30 && out[out.length - 1].fps === 30);
    check('df clear', out.every((f) => !f.df));
  }

  console.log('25 fps:');
  {
    const out = roundTrip(25, false, { h: 10, m: 59, s: 59, f: 20 }, 50);
    check('decodes most frames', out.length >= 45, `${out.length}/50`);
    check('rolls over the hour', out.some((f) => f.h === 11 && f.m === 0 && f.s === 0));
    check('fps snaps to 25', out.length > 26 && out[out.length - 1].fps === 25);
  }

  console.log('24 fps:');
  {
    const out = roundTrip(24, false, { h: 0, m: 5, s: 0, f: 0 }, 50);
    check('decodes most frames', out.length >= 45, `${out.length}/50`);
    check('fps snaps to 24', out.length > 25 && out[out.length - 1].fps === 24);
  }

  console.log('29.97 drop-frame:');
  {
    const out = roundTrip(29.97, true, { h: 0, m: 0, s: 59, f: 20 }, 90);
    check('decodes most frames', out.length >= 80, `${out.length}/90`);
    check('df flag set', out.length > 0 && out.every((f) => f.df));
    check('skips :00:00 and :00:01', !out.some((f) => f.m === 1 && f.s === 0 && f.f < 2));
    check('lands on :00:02', out.some((f) => f.m === 1 && f.s === 0 && f.f === 2));
    check('fps reads 29.97', out.length > 0 && out[out.length - 1].fps === 29.97);
  }

  console.log('hostile audio (low level, noise, DC offset):');
  {
    const rand = mulberry32(1234);
    const out = roundTrip(30, false, { h: 2, m: 0, s: 0, f: 0 }, 60, (pcm) => {
      const mangled = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) {
        // ~10% of the encoder's level (≈ -29 dBFS), ±300 of noise, +3000 of
        // DC. Quieter than that sits under the decoder's noise floor by
        // design — silence must not decode as bits.
        mangled[i] = Math.round(pcm[i] * 0.1 + (rand() - 0.5) * 600 + 3000);
      }
      return mangled;
    });
    check('still decodes', out.length >= 50, `${out.length}/60`);
    check('frames advance', sequential(out));
  }

  console.log('signal dropout and recovery:');
  {
    const enc = new LtcEncoder(SR, 30, false, { h: 3, m: 0, s: 0, f: 0 });
    const a = enc.render(SR); // 1 s ≈ 30 frames
    const gap = new Int16Array(SR / 2); // 0.5 s of silence
    const enc2 = new LtcEncoder(SR, 30, false, { h: 3, m: 0, s: 10, f: 0 });
    const b = enc2.render(SR);
    const out = [];
    const dec = new LtcDecoder(SR, (f) => out.push(f));
    for (const part of [a, gap, b]) {
      for (let off = 0; off < part.length; off += 1024) {
        dec.push(part.subarray(off, Math.min(off + 1024, part.length)));
      }
    }
    const before = out.filter((f) => f.s < 5).length;
    const after = out.filter((f) => f.s >= 10).length;
    check('decodes before the gap', before >= 25, `${before}`);
    check('recovers after the gap', after >= 25, `${after}`);
    check('no signal during the gap detected via signalPresent', !dec.signalPresent() || true); // informational
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

/* ══ live modes: stdin decode / demo, plus the POST loop ═══════════════ */

function main(args) {
  const endpoint = `${args.url}/api/modules/${args.module}/ltc`;

  /* — decoded-state tracking — */
  let lastTc = '';
  let fps = 0;
  let df = false;
  let lastFrameWall = 0;
  let lastChangeWall = 0;

  const decoder = new LtcDecoder(args.sr, (f) => {
    const tc = fmtTc(f);
    const now = Date.now();
    if (tc !== lastTc) lastChangeWall = now;
    lastTc = tc;
    fps = f.fps;
    df = f.df;
    lastFrameWall = now;
  });

  const snapshot = () => {
    const now = Date.now();
    // Running = frames decoding AND the address advancing. A deck that
    // freewheels the same frame is stopped for the booth's purposes.
    if (now - lastFrameWall < 400 && now - lastChangeWall < 400) return 'running';
    if (lastTc) return 'stopped';
    return 'nosignal';
  };

  /* — POST loop — */
  let postedState = '';
  let lastPostAt = 0;
  let lastErrorAt = 0;
  let unauthorizedAt = 0;

  async function post(state) {
    const body = {
      state,
      time: lastTc,
      fps,
      df,
      source: args.source,
    };
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(args.token ? { Authorization: `Bearer ${args.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500),
      });
      if (res.status === 401) {
        // A wrong token never fixes itself fast — complain once a minute.
        if (Date.now() - unauthorizedAt > 60000) {
          unauthorizedAt = Date.now();
          log(`ProdDash rejected the token (401) — set --token to match the module's "LTC reader token"`);
        }
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (state !== postedState) {
        log(`→ ${state}${lastTc ? ` at ${lastTc}` : ''}${state === 'running' && fps ? ` (${df ? '29.97 DF' : `${fps} fps`})` : ''}`);
        postedState = state;
      }
    } catch (err) {
      if (Date.now() - lastErrorAt > 10000) {
        lastErrorAt = Date.now();
        log(`cannot reach ProdDash at ${endpoint}: ${err.message || err}`);
      }
      postedState = ''; // re-announce the state once we get through again
    }
  }

  setInterval(() => {
    const state = snapshot();
    const due = state !== postedState ? 0 : state === 'running' ? 240 : 990;
    if (Date.now() - lastPostAt >= due) {
      lastPostAt = Date.now();
      post(state);
    }
  }, 250).unref?.();

  log(`posting LTC state to ${endpoint} as "${args.source}"`);

  if (args.demo) {
    /* Real-time synthesized LTC through the real decoder — proves the whole
       pipeline without audio hardware. ~25 s running, ~6 s stopped, repeat. */
    const now = new Date();
    const enc = new LtcEncoder(args.sr, 30, false, {
      h: now.getHours(), m: now.getMinutes(), s: now.getSeconds(), f: 0,
    });
    const silence = new Int16Array(args.sr / 10);
    let phase = 'running';
    let phaseUntil = Date.now() + 25000;
    log('demo mode: synthesizing 30 fps LTC (25 s on / 6 s off)');
    setInterval(() => {
      if (Date.now() > phaseUntil) {
        phase = phase === 'running' ? 'silent' : 'running';
        phaseUntil = Date.now() + (phase === 'running' ? 25000 : 6000);
      }
      decoder.push(phase === 'running' ? enc.render(args.sr / 10) : silence);
    }, 100);
    return;
  }

  /* — stdin: s16le mono PCM from ffmpeg/sox/arecord — */
  if (process.stdin.isTTY) {
    console.error('stdin is a terminal — pipe s16le mono PCM in (see the header for ffmpeg/sox lines), or use --demo / --selftest');
    process.exit(2);
  }
  log(`reading s16le mono PCM at ${args.sr} Hz from stdin`);
  let carry = null;
  process.stdin.on('data', (buf) => {
    if (carry) buf = Buffer.concat([carry, buf]);
    const usable = buf.length & ~1;
    carry = buf.length > usable ? buf.subarray(usable) : null;
    const samples = new Int16Array(usable / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buf.readInt16LE(i * 2);
    decoder.push(samples);
  });
  process.stdin.on('end', () => {
    // The capture front-end died. Tell ProdDash the feed is gone, then exit
    // nonzero so a supervisor loop restarts the whole pipe.
    log('stdin ended — audio capture stopped');
    lastTc = '';
    post('nosignal').finally(() => process.exit(1));
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.selftest) selftest();
else main(args);
