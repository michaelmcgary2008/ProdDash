'use strict';

/**
 * Title matching for the PCO Plan module — the one answer to "is this
 * ProPresenter document that Planning Center thing?", used twice:
 *
 *   - mapping the document ProPresenter has live to a plan item (the
 *     highlight and the item runtimes), and
 *   - recognising the documents an admin picked as the service start / end
 *     cues (see service-timing.js).
 *
 * A ProPresenter name and a Planning Center title rarely agree letter for
 * letter ("This Is The Day - [ Full ]" vs "This Is The Day"), so both sides
 * are tidied the way propresenter-core.cleanItemName does (tags in brackets,
 * leading date codes and dash separators dropped), lower-cased, stripped of
 * punctuation and compared:
 *
 *   1.00  identical after tidying     "Post-Service Loop"  ≈ "Post Service Loop"
 *   0.85  one contains the other      "Welcome"            ≈ "Welcome & Announcements"
 *   Dice  2·shared words ÷ all words  "Pre Service Loop"   vs "Post Service Loop" → 0.67
 *
 * Filler words ("the", "of", "and"…) are ignored. The thresholds:
 *
 *   MATCH_THRESHOLD   0.6   plan items — two of three words is enough, because
 *                           the item that scores best *and* is next in the
 *                           plan wins, so a near miss lands on the right row.
 *   TRIGGER_THRESHOLD 0.75  service cues — a cue starts or freezes the service
 *                           clock, so one wrong word must not fire it: the
 *                           pre-service loop (0.67 against "Post Service Loop")
 *                           stays a non-match, while a renamed
 *                           "Post-Service Loop", a tagged "Post Service Loop
 *                           [Full]" (1.0) or a shortened "Post Service" (0.85)
 *                           still trigger.
 */

const MATCH_THRESHOLD = 0.6;
const TRIGGER_THRESHOLD = 0.75;

/** Same title tidying as propresenter-core.cleanItemName (drops [tags], date codes). */
function cleanTitle(raw) {
  const original = String(raw || '').trim();
  let s = original;
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ');
  s = s.replace(/^\s*\d{6,8}\b[\s\-–—:.]*/, '');
  s = s.replace(/\s[-–—]+\s/g, ' ');
  s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || original;
}

function normalize(raw) {
  return cleanTitle(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'my', 'your', 'our']);
function tokens(norm) {
  return new Set(norm.split(' ').filter((t) => t && !STOPWORDS.has(t)));
}

/** 0..1 similarity between two titles. */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return 0.85;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return (2 * common) / (ta.size + tb.size); // Dice coefficient
}

/** Does a live ProPresenter document count as the cue document an admin picked? */
function isCue(liveName, cueDocument) {
  return Boolean(cueDocument) && similarity(liveName, cueDocument) >= TRIGGER_THRESHOLD;
}

module.exports = { MATCH_THRESHOLD, TRIGGER_THRESHOLD, cleanTitle, normalize, similarity, isCue };
