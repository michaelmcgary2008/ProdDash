'use strict';

/**
 * LTC engine for the propresenter-timers module — SMPTE LTC decode from PCM,
 * interleaved-channel extraction, and an encoder for tests.
 *
 * Used in-process by the module's built-in LTC listener (ltc-listener.js).
 * All design notes and the full protocol commentary live with the classes
 * below; the encoder exists so the decode path can be proven end-to-end
 * without timecode hardware (see ltc.selftest.js).
 */

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
    this.prev = null; // previous valid frame, for rollover observation
    this.nominal = 0; // nominal fps locked by two agreeing rollovers
    this.rollCandidate = 0;
    this.df = false; // drop-frame with two-frame hysteresis
    this.dfPending = null;
    this.dfRun = 0;
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
      // (the stream that resumes is usually the same deck). Frame
      // continuity broke, so rollover observation restarts too; the locked
      // nominal survives — two agreeing rollovers re-lock a changed rate.
      this.halfAt = 0;
      this.sync = 0;
      this.fresh = 0;
      this.prev = null;
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
    // Strict validation: LTC has no parity worth the name, so a bit error
    // can produce a frame that "parses" — every field must be a legal BCD
    // digit AND inside its hard ceiling, or the frame is dropped whole.
    // (A lax check here once let a corrupt frames field of 35 through, and
    // downstream fps logic reported 36 fps to the dashboard.)
    const fu = bcd(0, 4);
    const su = bcd(16, 4);
    const mu = bcd(32, 4);
    const hu = bcd(48, 4);
    if (fu > 9 || su > 9 || mu > 9 || hu > 9) return;
    const f = fu + bcd(8, 2) * 10;
    const s = su + bcd(24, 3) * 10;
    const m = mu + bcd(40, 3) * 10;
    const h = hu + bcd(56, 2) * 10;
    if (f > 29 || s > 59 || m > 59 || h > 23) return;

    // Drop-frame flag with two-frame hysteresis — one corrupt-but-legal
    // frame must not flash 29.97 DF across the dashboard.
    const dfBit = bits[10] === 1;
    this.dfRun = dfBit === this.dfPending ? this.dfRun + 1 : 1;
    this.dfPending = dfBit;
    if (this.dfRun >= 2) this.df = dfBit;

    // Nominal rate from observed rollovers: the frame number that precedes
    // an f=0-with-seconds-advance IS the rate minus one. Two consecutive
    // agreeing rollovers lock it — a single corrupt frame can't fake two
    // valid, correctly-successive frames twice, and a genuine rate change
    // re-locks itself within two seconds.
    if (this.prev && f === 0 && s === (this.prev.s + 1) % 60) {
      const cand = this.prev.f + 1;
      if (cand === 24 || cand === 25 || cand === 30) {
        if (cand === this.rollCandidate) this.nominal = cand;
        this.rollCandidate = cand;
      }
    }
    this.prev = { h, m, s, f };
    this.onFrame({ h, m, s, f, df: this.df, fps: this.fps(this.df) });
  }

  /**
   * Nominal rate: locked by rollover consensus once two second-boundaries
   * agree; until then snap the measured bit clock to a standard rate.
   * 29.97 vs 30 non-drop differ by 0.1% — beyond the bit-clock estimate's
   * accuracy — so non-drop 29.97 reads as 30. Drop-frame is exact: the DF
   * bit means 29.97.
   */
  fps(df) {
    if (df) return 29.97;
    if (this.nominal) return this.nominal;
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

/**
 * Turns a raw s16le byte stream of interleaved channels into one channel's
 * samples. Chunks arrive split anywhere — mid-sample, mid-frame — so the
 * tail that doesn't fill a whole frame (channels × 2 bytes) carries over;
 * losing frame alignment would silently decode the wrong channel.
 */
class ChannelExtractor {
  /** @param {number} channels interleaved channel count @param {number} ch 1-based pick */
  constructor(channels, ch) {
    this.frameBytes = channels * 2;
    this.offset = (ch - 1) * 2;
    this.carry = null;
  }

  /** @param {Buffer} buf @returns {Int16Array} the picked channel's samples */
  push(buf) {
    if (this.carry) buf = Buffer.concat([this.carry, buf]);
    const usable = buf.length - (buf.length % this.frameBytes);
    this.carry = buf.length > usable ? buf.subarray(usable) : null;
    const out = new Int16Array(usable / this.frameBytes);
    for (let i = 0, off = this.offset; i < out.length; i += 1, off += this.frameBytes) {
      out[i] = buf.readInt16LE(off);
    }
    return out;
  }
}

const pad2 = (v) => String(v).padStart(2, '0');
const fmtTc = (tc) => `${pad2(tc.h)}:${pad2(tc.m)}:${pad2(tc.s)}:${pad2(tc.f)}`;

module.exports = { LtcDecoder, LtcEncoder, ChannelExtractor, frameBits, nextTc, fmtTc, SYNC_WORD };
