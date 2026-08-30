// Verifies the slide-count + "remaining" logic (mirrors main.js) against tmp/pp-mock.js.
// The total comes from probing the thumbnail boundary (arrangement-expanded cue count),
// which lives in the SAME index space as slide_index — so "Slide X / Y" can never have X > Y,
// even when the selected arrangement repeats a section (the 43/41 bug this fixes).
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.argv[2] || '1599', 10);
async function get(p) {
  const r = await fetch(`http://${HOST}:${PORT}${p}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}
function countSlides(d) {
  const p = d?.presentation || d;
  const groups = Array.isArray(p?.groups) ? p.groups : [];
  let c = 0;
  for (const g of groups) c += Array.isArray(g?.slides) ? g.slides.length : 0;
  return c;
}
// Mirror of ppProbeArrangementLength: smallest thumbnail index that 404s = cue count.
async function status(p) {
  const r = await fetch(`http://${HOST}:${PORT}${p}`, { headers: { Accept: 'image/jpeg' } });
  return r.status;
}
async function probeArrangementLength(uuid) {
  const exists = async (i) => (await status(`/v1/presentation/${encodeURIComponent(uuid)}/thumbnail/${i}`)) === 200;
  if (!(await exists(0))) return 0;
  let lo = 0; let hi = 1;
  while (await exists(hi)) { lo = hi; hi *= 2; if (hi > 4000) return null; }
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (await exists(mid)) lo = mid; else hi = mid; }
  return lo + 1;
}
(async () => {
  const si = await get('/v1/presentation/slide_index');
  const node = si?.presentation_index || si?.presentation;
  const current = node && Number.isInteger(node.index) ? node.index + 1 : 0;
  const uuid = node?.presentation_id?.uuid || '';
  const det = await get(`/v1/presentation/${encodeURIComponent(uuid)}`);
  const master = countSlides(det);
  const total = await probeArrangementLength(uuid);
  const remaining = Math.max(0, total - current);
  console.log(`live presentation uuid: ${uuid}`);
  console.log(`master slides (/presentation/{uuid}): ${master}   arrangement cues (thumbnail probe): ${total}`);
  console.log(`NOW card → "Slide ${current} / ${total} · ${remaining} left"`);
  const ok = current > 0 && total > 0 && total >= current && remaining === total - current;
  console.log(ok ? '\n✅ total matches the slide_index space (X never exceeds Y)' : '\n❌ FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('error:', e.message); process.exit(2); });
