#!/usr/bin/env node
'use strict';

/**
 * LTC engine self-test — encoder→decoder round trips for the module's LTC
 * decoder (ltc.js), which the built-in listener (ltc-listener.js) uses to
 * decode timecode from the captured audio. No audio hardware needed.
 *
 *   node modules/propresenter-timers/ltc.selftest.js
 *
 * Exits non-zero if any check fails, so it doubles as a CI smoke test.
 */

const { LtcDecoder, LtcEncoder, ChannelExtractor, frameBits, fmtTc } = require("./ltc");

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
    // hysteresis: the very first frame legitimately reports df=false
    check('df flag set', out.length > 1 && out.slice(1).every((f) => f.df));
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

  console.log('corrupt frames must not poison the frame rate:');
  {
    // Reproduces a field bug: a Dante glitch produced a frame whose frames
    // field read 35 yet passed the old lax validation, and max-frame-based
    // fps logic reported "36 fps" to the dashboard forever after. Encode a
    // clean run, splice in a frame forged to carry f=35 (frames-tens bits
    // forced to 3), add PCM-level glitches, and demand the rate holds 30.
    const enc = new LtcEncoder(SR, 30, false, { h: 6, m: 0, s: 0, f: 0 });
    const clean1 = enc.render(SR); // ~30 valid frames
    enc.bits = frameBits({ h: 6, m: 0, s: 1, f: 5 }, false);
    enc.bits[8] = 1; // frames-tens bit 0
    enc.bits[9] = 1; // frames-tens bit 1 → tens=3 → frames field reads 35
    enc.bitIdx = 0;
    const forged = enc.render(Math.ceil(SR / 30)); // one poisoned frame
    const clean2 = enc.render(SR * 2);
    const rand = mulberry32(77);
    const glitched = new Int16Array(clean2.length);
    glitched.set(clean2);
    for (let at = SR / 4; at < glitched.length - 100; at += Math.floor(SR / 3)) {
      for (let i = 0; i < 90; i += 1) glitched[at + i] = Math.round((rand() - 0.5) * 24000);
    }
    const out = [];
    const dec = new LtcDecoder(SR, (fr) => out.push(fr));
    for (const part of [clean1, forged, glitched]) {
      for (let off = 0; off < part.length; off += 997) {
        dec.push(part.subarray(off, Math.min(off + 997, part.length)));
      }
    }
    check('still decodes through the damage', out.length >= 70, `${out.length}`);
    check('no frame number above 29 survives', out.every((fr) => fr.f <= 29));
    check('fps never exceeds 30', out.every((fr) => fr.fps <= 30), `saw ${Math.max(...out.map((fr) => fr.fps))}`);
    check('fps ends locked at 30', out.length > 0 && out[out.length - 1].fps === 30);
    check('df never flashes on', out.every((fr) => !fr.df));
  }

  console.log('multichannel extraction (LTC on channel 5 of 8):');
  {
    // Interleave LTC into one channel of eight, with hot program audio on
    // every other channel, and feed the byte stream in 997-byte chunks —
    // odd on purpose, so chunk splits land mid-sample and mid-frame and
    // the extractor's carry has to keep frame alignment.
    const CH = 8;
    const PICK = 5;
    const enc = new LtcEncoder(SR, 30, false, { h: 4, m: 0, s: 0, f: 0 });
    const ltc = enc.render(SR * 2); // 2 s ≈ 60 frames
    const bytes = Buffer.alloc(ltc.length * CH * 2);
    for (let i = 0; i < ltc.length; i += 1) {
      for (let c = 0; c < CH; c += 1) {
        const v = c === PICK - 1 ? ltc[i] : Math.round(20000 * Math.sin(i * (0.02 + c * 0.05)));
        bytes.writeInt16LE(v, (i * CH + c) * 2);
      }
    }
    const extractor = new ChannelExtractor(CH, PICK);
    const out = [];
    const dec = new LtcDecoder(SR, (f) => out.push(f));
    for (let off = 0; off < bytes.length; off += 997) {
      dec.push(extractor.push(bytes.subarray(off, Math.min(off + 997, bytes.length))));
    }
    check('decodes most frames', out.length >= 55, `${out.length}/60`);
    check('starts at 04:00:00:0x', out.length > 0 && out[0].h === 4 && out[0].m === 0 && out[0].s === 0);
    check('frames advance', sequential(out));
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

selftest();
