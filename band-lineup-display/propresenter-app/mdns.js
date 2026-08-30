'use strict';

/**
 * A minimal multicast-DNS responder — just enough to make one name resolve.
 *
 * WHY THIS EXISTS: a bookmark has to survive DHCP handing the host a new address.
 * The obvious answer, "bookmark the computer's name", does not work here: Windows
 * ships an mDNS *resolver* but no *responder*, so it never publishes its own
 * <name>.local, and an iPad or Mac asking for it gets silence. (Windows-to-Windows
 * appears to work only via LLMNR/NetBIOS, which Microsoft is ramping down.)
 * So the app publishes its OWN name — nownext.local by default — which macOS, iOS
 * and Windows 10 1703+/11 all resolve natively.
 *
 * Scope on purpose: one A record for one name. No service discovery (_http._tcp),
 * no PTR/SRV/TXT, no full RFC 6762 probing state machine. Zero dependencies.
 *
 * Limits worth knowing: mDNS is link-local (TTL 1) and does not cross VLANs or
 * subnets, and it needs inbound UDP 5353 through the firewall. The ranked IP
 * addresses remain the fallback for anywhere this can't reach.
 */

const dgram = require('dgram');
const os = require('os');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Set on unique records so resolvers replace rather than accumulate. */
const CACHE_FLUSH = 0x8000;
const DEFAULT_TTL = 120;

function ipToInt(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value * 256) + octet;
  }
  return value;
}

function sameSubnet(addressA, addressB, netmask) {
  const a = ipToInt(addressA);
  const b = ipToInt(addressB);
  const mask = ipToInt(netmask);
  if (a === null || b === null || mask === null) return false;
  // >>> 0 keeps the result unsigned; a /0 mask would match everything, so guard it.
  return mask !== 0 && ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** Encode a dotted name as length-prefixed DNS labels. */
function encodeName(name) {
  const labels = String(name).replace(/\.$/, '').split('.');
  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > 63) throw new Error(`mDNS label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * Read a DNS name at `offset`, following compression pointers.
 * Returns the name plus the offset just past the name in the ORIGINAL position.
 */
function decodeName(buffer, offset) {
  const labels = [];
  let cursor = offset;
  let end = -1;
  let hops = 0;
  while (cursor < buffer.length) {
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      // Compression pointer: follow it, but the caller continues after the pointer.
      if (cursor + 1 >= buffer.length) return null;
      if (end === -1) end = cursor + 2;
      cursor = ((length & 0x3f) << 8) | buffer[cursor + 1];
      hops += 1;
      if (hops > 16) return null; // malformed / pointer loop
      continue;
    }
    if (cursor + 1 + length > buffer.length) return null;
    labels.push(buffer.toString('utf8', cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
  }
  return { name: labels.join('.'), offset: end === -1 ? cursor : end };
}

/** Parse the question section of a query. Returns null for anything malformed. */
function decodeQuestions(buffer) {
  if (buffer.length < 12) return null;
  const flags = buffer.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return { isResponse: true, questions: [] }; // a response, not a query
  const count = buffer.readUInt16BE(4);
  if (count === 0 || count > 32) return { isResponse: false, questions: [] };
  const questions = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const decoded = decodeName(buffer, offset);
    if (!decoded) return null;
    offset = decoded.offset;
    if (offset + 4 > buffer.length) return null;
    const type = buffer.readUInt16BE(offset);
    const rawClass = buffer.readUInt16BE(offset + 2);
    offset += 4;
    questions.push({
      name: decoded.name,
      type,
      class: rawClass & 0x7fff,
      // The top bit of QCLASS is the "unicast response wanted" flag (RFC 6762 §5.4).
      wantsUnicast: (rawClass & 0x8000) !== 0,
    });
  }
  return { isResponse: false, questions };
}

/**
 * Parse the answer section of a response, returning the A records only.
 * Needed for conflict detection: enterprise APs and mesh routers commonly REFLECT mDNS,
 * so our own announcement comes back from the reflector's address. Matching on raw bytes
 * flags that as a name clash; comparing the actual advertised addresses does not.
 */
function decodeAnswers(buffer) {
  if (buffer.length < 12) return [];
  const answerCount = buffer.readUInt16BE(6);
  if (answerCount === 0 || answerCount > 64) return [];
  const questionCount = buffer.readUInt16BE(4);
  let offset = 12;
  // Skip the question section, if the responder echoed it.
  for (let i = 0; i < questionCount; i += 1) {
    const decoded = decodeName(buffer, offset);
    if (!decoded) return [];
    offset = decoded.offset + 4;
  }
  const answers = [];
  for (let i = 0; i < answerCount; i += 1) {
    const decoded = decodeName(buffer, offset);
    if (!decoded) break;
    offset = decoded.offset;
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const rdLength = buffer.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + rdLength > buffer.length) break;
    if (type === TYPE_A && rdLength === 4) {
      answers.push({
        name: decoded.name,
        address: `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`,
      });
    }
    offset += rdLength;
  }
  return answers;
}

/** Build a standard mDNS query for one name (type A, class IN). */
function buildQuery(name) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);      // mDNS queries use id 0
  header.writeUInt16BE(0, 2);      // standard query
  header.writeUInt16BE(1, 4);      // one question
  const question = Buffer.alloc(4);
  question.writeUInt16BE(TYPE_A, 0);
  question.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, encodeName(name), question]);
}

/** Build a response packet carrying one A record per address. */
function buildResponse(name, addresses, ttl, queryId) {
  const encodedName = encodeName(name);
  const answers = addresses.map((address) => {
    const rdata = Buffer.from(String(address).split('.').map((octet) => Number.parseInt(octet, 10)));
    const record = Buffer.alloc(10);
    record.writeUInt16BE(TYPE_A, 0);
    record.writeUInt16BE(CLASS_IN | CACHE_FLUSH, 2);
    record.writeUInt32BE(ttl, 4);
    record.writeUInt16BE(4, 8);
    return Buffer.concat([encodedName, record, rdata]);
  });

  const header = Buffer.alloc(12);
  header.writeUInt16BE(queryId || 0, 0);
  header.writeUInt16BE(0x8400, 2); // QR=1 (response), AA=1 (authoritative)
  header.writeUInt16BE(0, 4);      // no question echoed back
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  return Buffer.concat([header, ...answers]);
}

/**
 * @param {object} [options]
 * @param {string} [options.name] Bare label to publish; ".local" is appended. Default "nownext".
 * @param {() => string[]} [options.getAddresses] Current IPv4 addresses to advertise, best first.
 * @param {(message: string) => void} [options.log]
 */
function createMdnsResponder(options = {}) {
  const label = String(options.name || 'nownext').replace(/[^a-zA-Z0-9-]/g, '').toLowerCase() || 'nownext';
  const fqdn = `${label}.local`;
  const ttl = Number.isFinite(options.ttl) && options.ttl > 0 ? options.ttl : DEFAULT_TTL;
  const getAddresses = typeof options.getAddresses === 'function' ? options.getAddresses : () => [];
  const log = typeof options.log === 'function' ? options.log : () => {};

  let socket = null;
  let started = false;
  let announceTimer = null;
  let lastError = '';
  let conflictHost = '';
  /** True while we have stood down from the name because another host really holds it. */
  let relinquished = false;
  /** In-flight conflict verification: { foreign: string } while probing, else null. */
  let probe = null;
  let recoveryTimer = null;

  /** Interfaces we can advertise on, as {address, netmask}. */
  function localInterfaces() {
    const out = [];
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
        if (isIPv4 && !entry.internal) out.push({ address: entry.address, netmask: entry.netmask });
      }
    }
    return out;
  }

  /**
   * Which of our addresses to hand a particular asker. On a multi-homed A/V machine
   * (house LAN + camera network) answering with everything would send a studio PC an
   * address it cannot route to, so prefer addresses on the asker's own subnet.
   */
  function addressesForPeer(peerAddress) {
    const advertised = getAddresses().filter(Boolean);
    if (!advertised.length) return [];
    const interfaces = localInterfaces();
    const onPeerSubnet = advertised.filter((address) => {
      const match = interfaces.find((entry) => entry.address === address);
      return match && sameSubnet(peerAddress, address, match.netmask);
    });
    return onPeerSubnet.length ? onPeerSubnet : advertised;
  }

  function send(message, port, address) {
    if (!socket) return;
    try {
      socket.send(message, port, address, (err) => {
        if (err) lastError = err.message;
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Aim the next multicast send out of a specific interface. Best effort. */
  function setOutgoingInterface(address) {
    try {
      socket.setMulticastInterface(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Announce (or, with ttlValue 0, withdraw) the name.
   *
   * One packet PER INTERFACE, each advertising only that interface's own address. Sending
   * every address to every interface is the tempting shortcut and it is wrong: a studio PC
   * would cache all of them, and browsers try cached addresses in turn — so a machine that
   * can only route to the house LAN might sit waiting on the camera-network address first.
   * A listener should only ever learn the address it can actually reach us on.
   */
  function announce(ttlValue = ttl) {
    const advertised = getAddresses().filter(Boolean);
    if (!advertised.length) return;
    const interfaces = localInterfaces();
    let sent = 0;
    for (const address of advertised) {
      if (!interfaces.some((entry) => entry.address === address)) continue;
      if (!setOutgoingInterface(address)) continue;
      send(buildResponse(fqdn, [address], ttlValue, 0), MDNS_PORT, MDNS_ADDRESS);
      sent += 1;
    }
    if (!sent) {
      // No interface would take the hint — fall back to one packet on the default route.
      setOutgoingInterface('0.0.0.0');
      send(buildResponse(fqdn, advertised, ttlValue, 0), MDNS_PORT, MDNS_ADDRESS);
    }
    setOutgoingInterface('0.0.0.0');
  }

  function handleMessage(buffer, rinfo) {
    let parsed;
    try {
      parsed = decodeQuestions(buffer);
    } catch {
      return; // never let a malformed packet from the network throw
    }
    if (!parsed) return;

    if (parsed.isResponse) {
      // A genuine clash is another host advertising OUR name with an address that is not
      // ours. A reflected copy of our own announcement carries only our own addresses, so
      // it no longer trips this.
      const mine = new Set(localInterfaces().map((entry) => entry.address));
      for (const answer of decodeAnswers(buffer)) {
        if (answer.name.toLowerCase() !== fqdn) continue;
        if (mine.has(answer.address)) continue;
        // Only believe a claim from something on one of our own subnets. An off-link
        // packet naming our record is a spoof, not a neighbour.
        if (!onOurLink(rinfo.address)) continue;
        if (probe) {
          probe.foreign = answer.address;   // a probe is running: this answers it
        } else if (!relinquished) {
          void verifyThenConcede(answer.address);
        }
        break;
      }
      return;
    }

    // Once the name is contested we must not answer for it (RFC 6762 §9). Two responders
    // both answering is worse than neither: the name resolves to a different machine each
    // time, so half the screens land on the wrong host and show nothing.
    if (relinquished) return;

    for (const question of parsed.questions) {
      if (question.name.toLowerCase() !== fqdn) continue;
      if (question.type !== TYPE_A && question.type !== TYPE_ANY) continue;
      if (question.class !== CLASS_IN && question.class !== TYPE_ANY) continue;
      const addresses = addressesForPeer(rinfo.address);
      if (!addresses.length) continue;
      const queryId = buffer.readUInt16BE(0);
      // Legacy resolvers (source port != 5353) and QU queries want a direct reply.
      if (question.wantsUnicast || rinfo.port !== MDNS_PORT) {
        send(buildResponse(fqdn, addresses, ttl, queryId), rinfo.port, rinfo.address);
      } else {
        // Reply out of the interface the answer is valid for, so nobody else on another
        // network caches an address they cannot reach.
        setOutgoingInterface(addresses[0]);
        send(buildResponse(fqdn, addresses, ttl, 0), MDNS_PORT, MDNS_ADDRESS);
        setOutgoingInterface('0.0.0.0');
      }
    }
  }

  /** Is this address on one of our own subnets? */
  function onOurLink(address) {
    return localInterfaces().some((entry) => sameSubnet(address, entry.address, entry.netmask));
  }

  /**
   * Ask whether anyone else is holding our name (RFC 6762 §8.1-style probing: three
   * queries, 250ms apart). Resolves with the foreign address, or '' if the link is quiet.
   *
   * This is the difference between a robust responder and a one-packet kill switch. A
   * genuine second host answers a direct question; a spoofer who fires one unsolicited
   * packet and leaves does not.
   */
  function probeForConflict() {
    return new Promise((resolve) => {
      if (!socket) {
        resolve('');
        return;
      }
      probe = { foreign: '' };
      const query = buildQuery(fqdn);
      let sent = 0;
      const tick = () => {
        if (!socket || !probe) return;
        if (probe.foreign || sent >= 3) {
          const found = probe ? probe.foreign : '';
          probe = null;
          resolve(found);
          return;
        }
        sent += 1;
        send(query, MDNS_PORT, MDNS_ADDRESS);
        const next = setTimeout(tick, 250);
        next.unref?.();
      };
      tick();
      // Give the third query time to be answered before declaring the link quiet.
      const done = setTimeout(() => {
        const found = probe ? probe.foreign : '';
        probe = null;
        resolve(found);
      }, 1200);
      done.unref?.();
    });
  }

  /**
   * A neighbour appears to hold our name. Verify it before standing down, then keep
   * checking so the name comes back when they go away.
   *
   * Deliberately NOT the RFC's rename-on-conflict: the URL is the whole point of this
   * feature, and renaming would break every bookmark in the building — and would hand a
   * spoofer the good name. Standing aside temporarily keeps resolution unambiguous while
   * the numeric addresses (which the host app lists) keep working throughout.
   */
  async function verifyThenConcede(claimedBy) {
    if (relinquished || probe) return;
    const confirmed = await probeForConflict();
    if (!confirmed) {
      log(`ignored an unverified claim on ${fqdn} (nobody answered a probe) — keeping the name`);
      return;
    }
    conflictHost = confirmed;
    relinquished = true;
    log(`another host at ${confirmed} really holds ${fqdn} — standing down until it leaves`);
    if (announceTimer) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
    try {
      announce(0); // TTL 0: resolvers drop OUR records so the name stops being ambiguous
    } catch {
      /* nothing more we can do */
    }
    startRecoveryWatch();
  }

  /** While stood down, re-probe periodically and reclaim the name once the link is quiet. */
  function startRecoveryWatch() {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(async () => {
      if (!socket || !relinquished) return;
      const stillThere = await probeForConflict();
      if (stillThere) return;
      log(`${fqdn} is free again — reclaiming it`);
      relinquished = false;
      conflictHost = '';
      clearInterval(recoveryTimer);
      recoveryTimer = null;
      announce();
      announceTimer = setInterval(announce, Math.max(30, ttl / 2) * 1000);
      announceTimer.unref?.();
    }, 60000);
    recoveryTimer.unref?.();
  }

  function start() {
    if (started) return Promise.resolve({ ok: true, name: fqdn });
    started = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        // reuseAddr is essential: macOS already runs mDNSResponder on 5353 and we must
        // coexist with it (it will not answer for our name, so there is no conflict).
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        started = false;
        finish({ ok: false, name: fqdn, error: lastError });
        return;
      }

      socket.on('error', (err) => {
        lastError = err instanceof Error ? err.message : String(err);
        log(`socket error: ${lastError}`);
        try { socket.close(); } catch { /* already closed */ }
        socket = null;
        started = false;
        finish({ ok: false, name: fqdn, error: lastError });
      });

      socket.on('message', (buffer, rinfo) => {
        try {
          handleMessage(buffer, rinfo);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      });

      socket.bind({ port: MDNS_PORT, exclusive: false }, () => {
        try {
          socket.setMulticastTTL(255); // RFC 6762 §11
        } catch { /* not fatal */ }
        let joined = 0;
        for (const entry of localInterfaces()) {
          try {
            socket.addMembership(MDNS_ADDRESS, entry.address);
            joined += 1;
          } catch {
            /* some adapters refuse multicast; others still work */
          }
        }
        if (!joined) {
          try {
            socket.addMembership(MDNS_ADDRESS);
            joined = 1;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }
        // Announce twice a second apart (RFC 6762 §8.3 asks for repeats), then hourly-ish
        // so a resolver that missed both still learns the name.
        announce();
        const second = setTimeout(announce, 1000);
        second.unref?.();
        announceTimer = setInterval(announce, Math.max(30, ttl / 2) * 1000);
        announceTimer.unref?.();
        finish({ ok: joined > 0, name: fqdn, interfaces: joined, error: joined ? '' : lastError });
      });
    });
  }

  function stop() {
    if (announceTimer) {
      clearInterval(announceTimer);
      announceTimer = null;
    }
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }
    probe = null;
    if (socket) {
      // Goodbye: TTL 0 tells resolvers to forget the name immediately, so a screen opened
      // right after we stop fails fast instead of hanging on a stale cache entry.
      try {
        announce(0);
      } catch { /* going away anyway */ }
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    }
    started = false;
  }

  return {
    start,
    stop,
    get name() { return fqdn; },
    get url() { return fqdn; },
    isRunning: () => Boolean(socket),
    /** True only while we still own the name and are answering for it. */
    isPublishing: () => Boolean(socket) && !relinquished,
    getLastError: () => lastError,
    getConflictHost: () => conflictHost,
  };
}

module.exports = {
  createMdnsResponder,
  MDNS_PORT,
  // exported for tests
  buildQuery,
  encodeName,
  decodeName,
  decodeQuestions,
  decodeAnswers,
  buildResponse,
  sameSubnet,
};
