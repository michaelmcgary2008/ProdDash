'use strict';

/**
 * Unit tests for the PCO Plan module's pure service-timing logic.
 *
 *   node modules/pco-plan/service-timing.test.js
 *
 * Plain Node, no dependencies; exits non-zero on the first failure. Times are
 * built for a two-service Sunday (9:00 and 11:00, 75 min each, 30 min
 * pre-roll) so the expectations read like the day would.
 */

const assert = require('assert');
const { similarity, isCue, MATCH_THRESHOLD, TRIGGER_THRESHOLD } = require('./matching');
const {
  MINUTE,
  LAST_SERVICE_OVERRUN_MS,
  serviceWindows,
  selectService,
  freshService,
  advance,
} = require('./service-timing');

const DAY = new Date(2026, 8, 13, 0, 0, 0, 0).getTime(); // a local midnight
const at = (h, m = 0) => DAY + (h * 60 + m) * MINUTE;
const hm = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const PLAN_TIMES = [
  { id: 'r', name: 'Rehearsal', timeType: 'rehearsal', startsAt: at(8, 0), endsAt: at(8, 45) },
  { id: 's1', name: 'First Service', timeType: 'service', startsAt: at(9, 0), endsAt: at(10, 15) },
  { id: 's2', name: 'Second Service', timeType: 'service', startsAt: at(11, 0), endsAt: at(12, 15) },
];
const PRE_ROLL = 30 * MINUTE;
const OPTS = { preRollMs: PRE_ROLL };

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err.message}`);
    process.exitCode = 1;
    throw err;
  }
}

console.log('service windows');

test('rehearsal is not a service; windows are contiguous and ordered', () => {
  const w = serviceWindows(PLAN_TIMES, OPTS);
  assert.deepStrictEqual(w.map((x) => x.id), ['s1', 's2']);
  assert.strictEqual(w[0].windowFrom, -Infinity);
  assert.strictEqual(w[0].windowUntil, w[1].windowFrom);
  assert.strictEqual(w[1].windowUntil, Infinity);
  assert.strictEqual(w[0].count, 2);
});

test('the boundary is 30 min before the next start once the first was due to end', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  // 10:15 scheduled end, 11:00 − 30 = 10:30 → boundary 10:30
  assert.strictEqual(hm(w1.windowUntil), hm(at(10, 30)));
  assert.strictEqual(w1.failsafeEndAt, w1.windowUntil, 'first service failsafe-stops at the boundary');
});

test('a pre-roll larger than the gap waits for the scheduled end, never passes the next start', () => {
  const [w1] = serviceWindows(PLAN_TIMES, { preRollMs: 60 * MINUTE });
  assert.strictEqual(hm(w1.windowUntil), hm(at(10, 15)), 'max(10:00, 10:15)');
  const [tight] = serviceWindows(
    [
      { id: 'a', timeType: 'service', startsAt: at(9, 0), endsAt: at(10, 30) },
      { id: 'b', timeType: 'service', startsAt: at(10, 0), endsAt: at(11, 0) },
    ],
    OPTS
  );
  assert.strictEqual(hm(tight.windowUntil), hm(at(10, 0)), 'capped at the next start');
});

test('an early actual end lets the next window open at pre-roll', () => {
  const [w1] = serviceWindows(PLAN_TIMES, { preRollMs: 60 * MINUTE, endedAt: { s1: at(10, 5) } });
  assert.strictEqual(hm(w1.windowUntil), hm(at(10, 5)), 'ended at 10:05 inside the 10:00 pre-roll → flips at 10:05');
  const [w1b] = serviceWindows(PLAN_TIMES, { preRollMs: PRE_ROLL, endedAt: { s1: at(10, 5) } });
  assert.strictEqual(hm(w1b.windowUntil), hm(at(10, 30)), 'ended at 10:05 before the 10:30 pre-roll → flips at 10:30');
});

test('a service without ends_at gets the planned length, else 90 min', () => {
  const [w] = serviceWindows([{ id: 'x', timeType: 'service', startsAt: at(9, 0), endsAt: 0 }], { plannedMs: 70 * MINUTE });
  assert.strictEqual(hm(w.endsAt), hm(at(10, 10)));
  const [w90] = serviceWindows([{ id: 'x', timeType: 'service', startsAt: at(9, 0), endsAt: 0 }], {});
  assert.strictEqual(hm(w90.endsAt), hm(at(10, 30)));
  assert.strictEqual(w90.failsafeEndAt, w90.endsAt + LAST_SERVICE_OVERRUN_MS);
});

test('selectService: 8:50 → 9:00, 9:30 → 9:00, 10:55 → 11:00, 11:05 → 11:00', () => {
  const w = serviceWindows(PLAN_TIMES, OPTS);
  assert.strictEqual(selectService(w, at(8, 50)).id, 's1');
  assert.strictEqual(selectService(w, at(9, 30)).id, 's1');
  assert.strictEqual(selectService(w, at(10, 29)).id, 's1', 'still the first service until the 10:30 boundary');
  assert.strictEqual(selectService(w, at(10, 55)).id, 's2');
  assert.strictEqual(selectService(w, at(11, 5)).id, 's2');
  assert.strictEqual(selectService(w, at(6, 0)).id, 's1', 'the morning belongs to the first service');
  assert.strictEqual(selectService(w, at(15, 0)).id, 's2', 'the afternoon stays with the last service');
  assert.strictEqual(selectService([], at(9, 0)), null);
});

console.log('service start');

const SCHEDULE = { startMode: 'schedule', startDocument: '', endDocument: '', startGraceMs: 10 * MINUTE };
const DOCUMENT = {
  startMode: 'document',
  startDocument: 'Welcome & Announcements',
  endDocument: 'Post Service Loop',
  startGraceMs: 10 * MINUTE,
};

test('schedule mode: idle before 9:00, running from 9:00 counting from 9:00; documents ignored', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  let s = freshService(w1);
  assert.strictEqual(advance(s, w1, SCHEDULE, at(8, 59), 'Welcome').changed, false, 'a document is not a cue in schedule mode');
  assert.strictEqual(advance(s, w1, SCHEDULE, at(8, 59)).changed, false);
  const out = advance(s, w1, SCHEDULE, at(9, 0, 30));
  assert.strictEqual(out.changed, true);
  s = out.svc;
  assert.strictEqual(s.phase, 'running');
  assert.strictEqual(s.startedAt, at(9, 0), 'counts from the scheduled start, not the tick that noticed');
  assert.strictEqual(s.startTrigger, 'schedule');
});

test('document mode: the start document going live starts the service at that moment', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  const s = freshService(w1);
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 0, 30)).changed, false, 'the scheduled time alone does not start it');
  const out = advance(s, w1, DOCUMENT, at(8, 58), 'Welcome and Announcements [Full]');
  assert.strictEqual(out.changed, true, 'a renamed / tagged start document still counts');
  assert.strictEqual(out.svc.phase, 'running');
  assert.strictEqual(out.svc.startedAt, at(8, 58), 'an early start is the real start');
  assert.strictEqual(out.svc.startTrigger, 'document');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 1), 'Post Service Loop').changed, false, 'the end document does not start an idle service');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 1), 'Goodness of God').changed, false, 'an unrelated document does nothing');
});

test('document mode: the start document is only a cue from pre-roll before the start', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  const s = freshService(w1);
  assert.strictEqual(advance(s, w1, DOCUMENT, at(8, 0), 'Welcome & Announcements').changed, false, 'rehearsal at 8:00 shows it — not the service');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(8, 30), 'Welcome & Announcements').changed, true, 'from 8:30 it counts');
});

test('document mode: failsafe at start + grace counts from the scheduled start', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  const s = freshService(w1);
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 9, 59)).changed, false);
  const out = advance(s, w1, DOCUMENT, at(9, 10));
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.svc.phase, 'running');
  assert.strictEqual(out.svc.startedAt, at(9, 0));
  assert.strictEqual(out.svc.startTrigger, 'failsafe');
  assert.match(out.event, /failsafe/);
});

test('document mode: a cue and the failsafe in the same tick — the cue wins', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  const out = advance(freshService(w1), w1, DOCUMENT, at(9, 12), 'Welcome & Announcements');
  assert.strictEqual(out.svc.startTrigger, 'document');
  assert.strictEqual(out.svc.startedAt, at(9, 12));
});

console.log('service end');

test('the end document freezes a running service; a second start document is ignored', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  let s = advance(freshService(w1), w1, DOCUMENT, at(9, 0), 'Welcome & Announcements').svc;
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 40), 'Welcome & Announcements').changed, false, 'shown again mid-service: nothing');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(9, 40), 'Pre Service Loop').changed, false, 'the PRE-service loop must not end it (0.67 < 0.75)');
  const out = advance(s, w1, DOCUMENT, at(10, 12), 'Post-Service Loop');
  assert.strictEqual(out.changed, true, 'a hyphenated end document still counts');
  s = out.svc;
  assert.strictEqual(s.phase, 'stopped');
  assert.strictEqual(s.endedAt, at(10, 12));
  assert.strictEqual(s.endTrigger, 'document');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(10, 20), 'Welcome & Announcements').changed, false, 'stopped stays stopped');
  assert.strictEqual(advance(s, w1, DOCUMENT, at(10, 45)).changed, false);
});

test('failsafe: a service still running when the next window opens stops at the boundary', () => {
  const [w1] = serviceWindows(PLAN_TIMES, OPTS);
  const s = advance(freshService(w1), w1, SCHEDULE, at(9, 0)).svc;
  assert.strictEqual(advance(s, w1, SCHEDULE, at(10, 29)).changed, false, 'running past its 10:15 end is allowed');
  const out = advance(s, w1, SCHEDULE, at(10, 31));
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.svc.phase, 'stopped');
  assert.strictEqual(hm(out.svc.endedAt), hm(at(10, 30)), 'frozen at the boundary, not at the tick');
  assert.strictEqual(out.svc.endTrigger, 'next-service');
});

test('failsafe: the last service stops an hour after its scheduled end', () => {
  const [, w2] = serviceWindows(PLAN_TIMES, OPTS);
  const s = advance(freshService(w2), w2, SCHEDULE, at(11, 0)).svc;
  assert.strictEqual(advance(s, w2, SCHEDULE, at(13, 14)).changed, false);
  const out = advance(s, w2, SCHEDULE, at(13, 15));
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.svc.phase, 'stopped');
  assert.strictEqual(hm(out.svc.endedAt), hm(at(13, 15)));
  assert.strictEqual(out.svc.endTrigger, 'plan-end');
});

test('the end document does not stop a service in the wrong window', () => {
  const w = serviceWindows(PLAN_TIMES, OPTS);
  const s1 = advance(freshService(w[0]), w[0], DOCUMENT, at(9, 0), 'Welcome & Announcements').svc;
  assert.strictEqual(advance(s1, w[1], DOCUMENT, at(10, 40), 'Post Service Loop').changed, false, 'state and window must belong together');
});

console.log('matching');

test('plan items: 0.6 — two of three words; cues: 0.75 — pre/post loops stay apart', () => {
  assert.strictEqual(MATCH_THRESHOLD, 0.6);
  assert.strictEqual(TRIGGER_THRESHOLD, 0.75);
  assert.strictEqual(similarity('Post-Service Loop', 'Post Service Loop'), 1);
  assert.strictEqual(similarity('Post Service Loop [Full]', 'Post Service Loop'), 1);
  assert.strictEqual(similarity('Post Service', 'Post Service Loop'), 0.85);
  assert.ok(Math.abs(similarity('Pre Service Loop', 'Post Service Loop') - 2 / 3) < 0.001);
  assert.strictEqual(isCue('Pre Service Loop', 'Post Service Loop'), false);
  assert.strictEqual(isCue('Post-Service Loop', 'Post Service Loop'), true);
  assert.strictEqual(isCue('Welcome', 'Welcome & Announcements'), true);
  assert.strictEqual(isCue('Anything', ''), false);
});

console.log(`\n${passed} tests passed`);
