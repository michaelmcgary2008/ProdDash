'use strict';

/**
 * ProPresenter stage-display websocket client — the LTC timecode source.
 *
 * ProPresenter's HTTP openAPI exposes no timecode route (see server.js), but
 * its classic stage-display websocket (ws://host:port/stagedisplay — the
 * Pro6-era protocol, still answered by ProPresenter 21; verified live: it
 * responds `{"acn":"ath","ath":…,"majorVersion":7,"minorVersion":21}`) streams
 * the text of stage-layout fields. So: the operator puts a field labeled
 * "LTC" on a stage layout, and this client reads that field's live text.
 *
 * Protocol (community-documented, github.com/jeffmikels/ProPresenter-API):
 *   → {"pwd":"<stage password>","ptl":610,"acn":"ath"}
 *   ← {"acn":"ath","ath":true|false,"err":"…"}
 *   → {"acn":"psl"}                 ← {"acn":"psl","uid":"<layout uid>"}
 *   → {"acn":"asl"}                 ← {"acn":"asl","ary":[{acn:"sl",uid,nme,fme:[…]},…]}
 *   ← {"acn":"sys","txt":" 11:17 AM"}      every second — our liveness signal
 *   ← {"acn":"tmr","uid":"…","txt":"…"}    live text for a layout field's uid
 *
 * A layout's `fme` frames carry `nme` (the label) and, for linked fields, a
 * `uid`. We bind to the first frame labeled "LTC" (case-insensitive), then
 * treat any message carrying that uid as the timecode text — matching by uid
 * rather than acn on purpose, since how ProPresenter 21 tags timecode
 * updates is undocumented. "Receiving" is a staleness heuristic: LTC text
 * that hasn't advanced for STALE_MS is a frozen/no-signal feed.
 *
 * Zero-dependency by design (like the rest of ProdDash): a minimal RFC6455
 * client — masked client frames, text + ping/pong + close, fragmented text
 * reassembly. TLS is not needed (ProPresenter's server is plain ws://).
 */

const net = require('net');
const crypto = require('crypto');

const RECONNECT_MS = 3000;
/** Auth rejections retry slowly — a wrong password never fixes itself fast. */
const BAD_AUTH_RETRY_MS = 30000;
/** ProPresenter sends a clock tick every second; silence this long = dead link. */
const LIVENESS_MS = 10000;
/** LTC text that has not advanced for this long counts as no-signal. */
const STALE_MS = 2500;

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {{host:string, port:number, password:string, log:Function,
 *          onUpdate:(ltc:{bound:boolean,time:string,receiving:boolean,note:string})=>void}} opts
 * @returns {{stop:()=>void}}
 */
function createStageLtcClient({ host, port, password, log, onUpdate }) {
  let sock = null;
  let stopped = false;
  let reconnectTimer = null;
  let livenessTimer = null;
  let staleTimer = null;

  let ltcUid = '';          // uid of the frame labeled LTC, once bound
  let lastText = '';
  let lastAdvance = 0;
  // Known-but-unused message types; anything else is logged once so a new
  // ProPresenter's timecode tag shows up in the server log for discovery.
  const loggedUnknownAcn = new Set(['fv', 'msg', 'vid', 'tmr', 'cs', 'ns', 'csn', 'nsn']);

  function emit(partial) {
    onUpdate({
      bound: Boolean(ltcUid),
      time: lastText,
      receiving: false,
      note: '',
      ...partial,
    });
  }

  /* ── outgoing frames (client → server must be masked) ───────────── */

  function sendFrame(opcode, payload) {
    if (!sock || sock.destroyed) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    try {
      sock.write(Buffer.concat([header, mask, masked]));
    } catch { /* socket died mid-write; liveness/close handling reconnects */ }
  }

  function sendJson(obj) {
    sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  /* ── protocol: layouts → find the LTC-labeled frame ─────────────── */

  let assignedLayoutUid = '';

  function bindFromLayouts(layouts) {
    const isLtcFrame = (f) => String(f?.nme || '').trim().toLowerCase() === 'ltc';
    const pick = (layout) => (Array.isArray(layout?.fme) ? layout.fme.find(isLtcFrame) : null);
    // Prefer the layout ProPresenter assigned to this client; fall back to
    // any layout with an LTC-labeled frame.
    const ordered = layouts.slice().sort((a, b) =>
      (b.uid === assignedLayoutUid ? 1 : 0) - (a.uid === assignedLayoutUid ? 1 : 0));
    for (const layout of ordered) {
      const frame = pick(layout);
      if (frame && frame.uid) {
        if (ltcUid !== frame.uid) {
          ltcUid = String(frame.uid);
          log(`stage display: bound LTC to field "${frame.nme}" (${ltcUid}) in layout "${layout.nme || layout.uid}"`);
          emit({ receiving: false });
        }
        return;
      }
      if (frame && !frame.uid) {
        log(`stage display: layout "${layout.nme}" has an LTC field with no uid — it never streams; link it to a timecode/timer source`);
      }
    }
    ltcUid = '';
    emit({ bound: false, time: '', note: 'No stage layout field labeled "LTC"' });
  }

  function handleMessage(obj) {
    const acn = String(obj.acn || '');
    switch (acn) {
      case 'ath':
        if (obj.ath === true) {
          log('stage display: authenticated');
          sendJson({ acn: 'psl' }); // which layout are we assigned?
          sendJson({ acn: 'asl' }); // all layouts, with their frames
        } else {
          const err = String(obj.err || 'authentication rejected');
          log(`stage display: auth failed — ${err}`);
          emit({ bound: false, time: '', note: 'Stage display password rejected — set it in Admin' });
          scheduleReconnect(BAD_AUTH_RETRY_MS);
          destroySocket();
        }
        return;
      case 'psl':
        assignedLayoutUid = String(obj.uid || '');
        return;
      case 'asl':
        if (Array.isArray(obj.ary)) bindFromLayouts(obj.ary);
        return;
      case 'sl':
        // A layout definition was pushed (assignment or edit) — it may not
        // be ours, so re-resolve from the authoritative full list instead
        // of rebinding blindly.
        sendJson({ acn: 'psl' });
        sendJson({ acn: 'asl' });
        return;
      case 'sys': // per-second clock — liveness only
        return;
      default:
        break;
    }
    // Anything carrying our bound uid is the LTC text, whatever its acn —
    // ProPresenter 21's tag for timecode fields is undocumented.
    if (ltcUid && obj.uid === ltcUid && typeof obj.txt === 'string') {
      const txt = obj.txt.trim();
      const placeholder = !txt || /^[-–—:;.\s]*$/.test(txt);
      if (placeholder) {
        lastText = '';
        emit({ receiving: false });
        return;
      }
      if (txt !== lastText) {
        lastText = txt;
        lastAdvance = Date.now();
        emit({ receiving: true });
        clearTimeout(staleTimer);
        staleTimer = setTimeout(() => {
          // Frozen text = LTC stopped arriving at ProPresenter.
          emit({ receiving: false });
        }, STALE_MS);
        staleTimer.unref?.();
      }
      return;
    }
    if (acn && !loggedUnknownAcn.has(acn) && loggedUnknownAcn.size < 30) {
      loggedUnknownAcn.add(acn);
      log(`stage display: unhandled message type "${acn}" — ${JSON.stringify(obj).slice(0, 160)}`);
    }
  }

  /* ── incoming frames ────────────────────────────────────────────── */

  function connect() {
    if (stopped) return;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let fragments = null;
    const key = crypto.randomBytes(16).toString('base64');

    sock = net.connect(port, host);
    sock.setNoDelay(true);

    const bumpLiveness = () => {
      clearTimeout(livenessTimer);
      livenessTimer = setTimeout(() => {
        log('stage display: silent too long — reconnecting');
        destroySocket();
        scheduleReconnect(RECONNECT_MS);
      }, LIVENESS_MS);
      livenessTimer.unref?.();
    };

    sock.on('connect', () => {
      sock.write(
        `GET /stagedisplay HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      bumpLiveness();
    });

    sock.on('data', (chunk) => {
      bumpLiveness();
      buf = Buffer.concat([buf, chunk]);

      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const head = buf.slice(0, idx).toString();
        buf = buf.slice(idx + 4);
        const statusLine = head.split('\r\n')[0] || '';
        if (!/ 101 /.test(statusLine + ' ')) {
          log(`stage display: no websocket upgrade (${statusLine.trim()}) — this ProPresenter may not serve /stagedisplay`);
          emit({ bound: false, time: '', note: 'No stage display websocket on this ProPresenter' });
          destroySocket();
          scheduleReconnect(BAD_AUTH_RETRY_MS);
          return;
        }
        const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
        const m = head.match(/sec-websocket-accept:\s*(\S+)/i);
        if (m && m[1] !== accept) log('stage display: Sec-WebSocket-Accept mismatch (continuing)');
        upgraded = true;
        sendJson({ pwd: String(password || ''), ptl: 610, acn: 'ath' });
      }

      // decode server frames (unmasked; tolerate masked anyway)
      while (buf.length >= 2) {
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const maskBit = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const maskLen = maskBit ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.slice(off + maskLen, off + maskLen + len);
        if (maskBit) {
          const mask = buf.slice(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        }
        buf = buf.slice(off + maskLen + len);

        if (opcode === 0x9) { // ping → pong
          sendFrame(0xA, payload);
          continue;
        }
        if (opcode === 0x8) { // close
          destroySocket();
          scheduleReconnect(RECONNECT_MS);
          return;
        }
        if (opcode === 0x1 || (opcode === 0x0 && fragments)) {
          if (!fin || opcode === 0x0) { // fragmented text
            fragments = fragments ? Buffer.concat([fragments, payload]) : payload;
            if (!fin) continue;
            payload = fragments;
            fragments = null;
          }
          let obj;
          try {
            obj = JSON.parse(payload.toString());
          } catch {
            continue;
          }
          if (obj && typeof obj === 'object') handleMessage(obj);
        }
        // binary frames (slide images) are ignored
      }
    });

    sock.on('error', () => { /* close handler reconnects */ });
    sock.on('close', () => {
      clearTimeout(livenessTimer);
      if (stopped) return;
      if (!reconnectTimer) {
        emit({ receiving: false });
        scheduleReconnect(RECONNECT_MS);
      }
    });
  }

  function destroySocket() {
    if (sock) {
      try { sock.destroy(); } catch { /* already gone */ }
      sock = null;
    }
  }

  function scheduleReconnect(ms) {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, ms);
    reconnectTimer.unref?.();
  }

  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(livenessTimer);
      clearTimeout(staleTimer);
      destroySocket();
    },
  };
}

module.exports = { createStageLtcClient };
