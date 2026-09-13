'use strict';

/**
 * Service timing for the PCO Plan module — pure functions, no I/O, no
 * timers. server.js feeds them the plan's service times, the documents
 * ProPresenter puts live and the clock; service-timing.test.js calls them
 * directly. Two questions are answered here:
 *
 *   1. Which of a plan's services owns the clock right now?   → serviceWindows / selectService
 *   2. When does that service count as started, and as ended? → advance
 *
 * ── Service windows ────────────────────────────────────────────────────
 *
 * A plan can have several services (plan_times of type "service": 9:00 and
 * 11:00, say). Only ONE owns the service-elapsed clock, the current-item
 * timing and the countdown at any moment, and moving into the next
 * service's window resets all three. Each service's window runs from the
 * end of the previous one to a boundary the next service's pre-roll sets:
 *
 *   boundary(i → i+1) = min( start[i+1],
 *                            max( start[i+1] − preRoll, endOf[i] ) )
 *
 *   endOf[i] = the moment service i ended (its end cue fired), else its
 *              scheduled end (plan_time ends_at, else start + the planned
 *              length of the "during" items, else 90 min).
 *
 * In words: the next service takes over `preRoll` before its scheduled
 * start (30 min by default; admin "Pre-roll"), but never before the current
 * one has ended or was due to end, and never later than its own start. A
 * service still running at the boundary is stopped there — that is the
 * "next service's start" failsafe the end cue has. The first window opens at
 * the beginning of time (before 9:00 the day belongs to the 9:00 service:
 * countdown running, service idle); the last window never closes — the last
 * service stays "stopped" until the plan itself changes (the next day's plan
 * takes over through the plan picker). The last service also has a failsafe
 * end: its scheduled end + LAST_SERVICE_OVERRUN_MS.
 *
 * ── Start and end of a service ─────────────────────────────────────────
 *
 * phase: idle → running → stopped, never backwards within one window.
 *
 *   start, schedule mode  (default)  at the scheduled start; startedAt = it.
 *   start, document mode             when the start document goes live
 *                                    (edge: it has to *become* live, from
 *                                    pre-roll before the scheduled start
 *                                    onwards — a rehearsal an hour earlier
 *                                    that shows the same document is not the
 *                                    service). Failsafe: if the document has
 *                                    not gone live by start + grace (admin
 *                                    "Start failsafe", 10 min default), the
 *                                    service starts anyway, counting from
 *                                    the scheduled start — the best estimate
 *                                    of when it really began.
 *   end, document                    when the end document goes live while
 *                                    the service is running (an end document
 *                                    live before the start — the previous
 *                                    service's loop — is ignored). Failsafe
 *                                    either way: the window boundary (see
 *                                    above), or, for the last service, its
 *                                    scheduled end + LAST_SERVICE_OVERRUN_MS.
 *
 * Cue documents are matched with matching.isCue (TRIGGER_THRESHOLD, see
 * matching.js for the tolerance), so "Post-Service Loop" still ends the
 * service when ProPresenter calls it "Post Service Loop".
 */

const { similarity, TRIGGER_THRESHOLD } = require('./matching');

const MINUTE = 60000;
/** How long before a service's scheduled start the timers switch to it (admin "Pre-roll"). */
const DEFAULT_PRE_ROLL_MS = 30 * MINUTE;
/** Document mode: start by the schedule anyway this long after the scheduled start (admin "Start failsafe"). */
const DEFAULT_START_GRACE_MS = 10 * MINUTE;
/** The last service of a plan is stopped this long after its scheduled end if nothing ended it. */
const LAST_SERVICE_OVERRUN_MS = 60 * MINUTE;
/** A service with no end time and no planned item lengths is assumed this long. */
const DEFAULT_SERVICE_LENGTH_MS = 90 * MINUTE;

/** The plan times that are services (every timed one when none is typed "service"), earliest first. */
function serviceTimes(planTimes) {
  const list = Array.isArray(planTimes) ? planTimes.filter((t) => t && Number(t.startsAt) > 0) : [];
  const services = list.filter((t) => t.timeType === 'service');
  return (services.length ? services : list).slice().sort((a, b) => a.startsAt - b.startsAt);
}

/**
 * The window each service owns (see the file comment).
 *
 * @param {Array}  planTimes        [{ id, name, timeType, startsAt, endsAt }] (ms epochs)
 * @param {object} [opts]
 * @param {number} [opts.preRollMs] how early the next service may take over (default 30 min)
 * @param {number} [opts.plannedMs] planned length of the service — for services without ends_at
 * @param {object} [opts.endedAt]   { [serviceId]: ms } services already ended by their cue
 * @returns {Array<{ id, name, index, count, startsAt, endsAt, windowFrom, windowUntil, cueFrom, failsafeEndAt, isLast }>}
 */
function serviceWindows(planTimes, opts = {}) {
  const preRoll = Number.isFinite(opts.preRollMs) ? Math.max(0, opts.preRollMs) : DEFAULT_PRE_ROLL_MS;
  const planned = Number(opts.plannedMs) > 0 ? Number(opts.plannedMs) : 0;
  const ended = opts.endedAt && typeof opts.endedAt === 'object' ? opts.endedAt : {};
  const services = serviceTimes(planTimes);
  const windows = services.map((svc, i) => {
    const scheduledEnd = svc.endsAt > svc.startsAt ? svc.endsAt : svc.startsAt + (planned || DEFAULT_SERVICE_LENGTH_MS);
    const endOf = Number(ended[svc.id]) > 0 ? Number(ended[svc.id]) : scheduledEnd;
    const next = services[i + 1];
    const windowUntil = next ? Math.min(next.startsAt, Math.max(next.startsAt - preRoll, endOf)) : Infinity;
    return {
      id: String(svc.id),
      name: String(svc.name || ''),
      index: i,
      count: services.length,
      startsAt: svc.startsAt,
      endsAt: scheduledEnd,
      windowFrom: -Infinity, // filled in below
      windowUntil,
      cueFrom: svc.startsAt - preRoll, // a start document counts from here on
      failsafeEndAt: next ? windowUntil : scheduledEnd + LAST_SERVICE_OVERRUN_MS,
      isLast: !next,
    };
  });
  for (let i = 1; i < windows.length; i += 1) windows[i].windowFrom = windows[i - 1].windowUntil;
  return windows;
}

/** The window that holds `now` — null only when there are no services. */
function selectService(windows, now) {
  if (!Array.isArray(windows) || !windows.length) return null;
  return windows.find((w) => now >= w.windowFrom && now < w.windowUntil) || windows[windows.length - 1];
}

/** Timing state for a service that has just come into its window. */
function freshService(window) {
  return {
    id: window ? String(window.id) : '',
    phase: window ? 'idle' : 'none',
    startedAt: 0,
    endedAt: 0,
    startTrigger: '', // 'schedule' | 'document' | 'failsafe'
    endTrigger: '',   // 'document' | 'next-service' | 'plan-end'
    cue: '',          // the document that started / ended it
  };
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Move a service's timing on by a clock tick or by a document going live.
 * Pure: returns a new state and a one-line description of what happened
 * (for the log), or `changed: false`.
 *
 * @param {object} svc       state from freshService(window) / a previous advance()
 * @param {object} window    from serviceWindows()
 * @param {object} opts      { startMode: 'schedule'|'document', startDocument, endDocument, startGraceMs }
 * @param {number} now       ms epoch
 * @param {string} [cue]     the document that just went live (omit on a plain tick)
 * @returns {{ svc: object, changed: boolean, event: string }}
 */
function advance(svc, window, opts, now, cue) {
  const o = opts || {};
  const grace = Number.isFinite(o.startGraceMs) ? Math.max(0, o.startGraceMs) : DEFAULT_START_GRACE_MS;
  const cueName = String(cue || '').trim();
  const same = { svc, changed: false, event: '' };
  if (!svc || !window || svc.id !== String(window.id)) return same;
  const at = fmtTime(window.startsAt);

  if (svc.phase === 'idle') {
    const documentMode = o.startMode === 'document' && o.startDocument;
    if (documentMode) {
      if (cueName && now >= window.cueFrom) {
        const score = similarity(cueName, o.startDocument);
        if (score >= TRIGGER_THRESHOLD) {
          return {
            svc: { ...svc, phase: 'running', startedAt: now, startTrigger: 'document', cue: cueName },
            changed: true,
            event: `started at ${fmtTime(now)} — "${cueName}" went live (start document "${o.startDocument}", match ${score.toFixed(2)})`,
          };
        }
      }
      if (now >= window.startsAt + grace) {
        return {
          svc: { ...svc, phase: 'running', startedAt: window.startsAt, startTrigger: 'failsafe' },
          changed: true,
          event: `started (failsafe) — the start document "${o.startDocument}" did not go live within ${Math.round(grace / MINUTE)} min of ${at}; counting from ${at}`,
        };
      }
      return same;
    }
    if (now >= window.startsAt) {
      return {
        svc: { ...svc, phase: 'running', startedAt: window.startsAt, startTrigger: 'schedule' },
        changed: true,
        event: `started — scheduled ${at}`,
      };
    }
    return same;
  }

  if (svc.phase === 'running') {
    if (o.endDocument && cueName) {
      const score = similarity(cueName, o.endDocument);
      if (score >= TRIGGER_THRESHOLD) {
        return {
          svc: { ...svc, phase: 'stopped', endedAt: now, endTrigger: 'document', cue: cueName },
          changed: true,
          event: `ended at ${fmtTime(now)} — "${cueName}" went live (end document "${o.endDocument}", match ${score.toFixed(2)})`,
        };
      }
    }
    if (now >= window.failsafeEndAt) {
      const endedAt = Math.min(now, window.failsafeEndAt);
      return {
        svc: { ...svc, phase: 'stopped', endedAt, endTrigger: window.isLast ? 'plan-end' : 'next-service' },
        changed: true,
        event: window.isLast
          ? `stopped (failsafe) — ${Math.round(LAST_SERVICE_OVERRUN_MS / MINUTE)} min past its scheduled end ${fmtTime(window.endsAt)}`
          : `stopped (failsafe) — the next service's window opened at ${fmtTime(endedAt)}`,
      };
    }
    return same;
  }

  return same;
}

module.exports = {
  MINUTE,
  DEFAULT_PRE_ROLL_MS,
  DEFAULT_START_GRACE_MS,
  LAST_SERVICE_OVERRUN_MS,
  DEFAULT_SERVICE_LENGTH_MS,
  serviceTimes,
  serviceWindows,
  selectService,
  freshService,
  advance,
  fmtTime,
};
