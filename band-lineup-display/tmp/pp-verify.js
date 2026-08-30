/**
 * Verifies the ProPresenter data pipeline used by main.js against tmp/pp-mock.js.
 * Mirrors the main-process client logic (stream parsing, slide-count summing,
 * active-item matching, NOW/NEXT assembly) and asserts the resulting view-model.
 *
 *   node tmp/pp-verify.js [port]
 */
const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.argv[2] || '1599', 10);

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures += 1;
}

// ---- client logic mirrored from main.js ----
const slideCountCache = new Map();
let state = { reachable: false, playlistUuid: '', playlistName: '', items: [], activeUuid: '', activeName: '', activeIndex: -1, currentSlide: 0 };

function ppUrl(target) { return `http://${HOST}:${PORT}${target}`; }
async function ppRequestJson(target, init) {
  const r = await fetch(ppUrl(target), { headers: { Accept: 'application/json' }, ...init });
  if (!r.ok) throw new Error(`${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function ppSlideCount(uuid) {
  if (!uuid) return null;
  if (slideCountCache.has(uuid)) return slideCountCache.get(uuid);
  try {
    const data = await ppRequestJson(`/v1/presentation/${encodeURIComponent(uuid)}`);
    let count = 0;
    for (const g of data?.groups || []) for (const s of g?.slides || []) if (s?.enabled !== false) count += 1;
    slideCountCache.set(uuid, count);
    return count;
  } catch { return null; }
}
function recomputeActiveIndex() {
  state.activeIndex = state.activeUuid ? state.items.findIndex((it) => it.uuid && it.uuid === state.activeUuid) : -1;
}
async function refreshCurrentPlaylist() {
  const cur = await ppRequestJson('/v1/playlist/current');
  state.playlistUuid = String(cur?.uuid || '');
  state.playlistName = String(cur?.name || '');
  if (!state.playlistUuid) { state.items = []; recomputeActiveIndex(); return; }
  const data = await ppRequestJson(`/v1/playlist/${encodeURIComponent(state.playlistUuid)}`);
  state.items = (data?.items || []).map((it) => ({
    uuid: String(it?.id?.uuid || ''), name: String(it?.id?.name || ''), type: String(it?.type || ''),
    isHidden: Boolean(it?.is_hidden), isPco: Boolean(it?.is_pco), slideCount: null,
  }));
  recomputeActiveIndex();
}
async function fillSlideCounts() {
  for (const it of state.items) if (it.type === 'presentation' && it.uuid && it.slideCount === null) it.slideCount = await ppSlideCount(it.uuid);
}
function applySlideIndex(data) {
  const pres = data?.presentation;
  if (!pres || !pres.presentation_id) { state.activeUuid = ''; state.activeName = ''; state.currentSlide = 0; recomputeActiveIndex(); return; }
  state.currentSlide = Number.isInteger(pres.index) ? pres.index + 1 : 0;
  state.activeUuid = String(pres.presentation_id.uuid || '');
  state.activeName = String(pres.presentation_id.name || '');
  recomputeActiveIndex();
}
async function viewModel() {
  let total = 0;
  if (state.activeUuid) { const c = slideCountCache.get(state.activeUuid); total = Number.isInteger(c) ? c : (await ppSlideCount(state.activeUuid)) || 0; }
  return { reachable: state.reachable, playlistName: state.playlistName, items: state.items, activeIndex: state.activeIndex, activePresentationName: state.activeName, currentSlide: state.currentSlide, currentSlideTotal: total };
}
function describe(vm) {
  const now = vm.activeIndex >= 0 ? vm.items[vm.activeIndex].name : vm.activePresentationName;
  const from = vm.activeIndex >= 0 ? vm.activeIndex + 1 : 0;
  const next = vm.items.slice(from).filter((it) => !it.isHidden)
    .map((it) => it.type === 'presentation' ? `${it.name} (${it.slideCount})` : `${it.name} [${it.type}]`);
  return `NOW: ${now} — slide ${vm.currentSlide}/${vm.currentSlideTotal}\n  NEXT: ${next.join(' · ')}`;
}

async function main() {
  await refreshCurrentPlaylist();
  applySlideIndex(await ppRequestJson('/v1/presentation/slide_index'));
  await fillSlideCounts();
  state.reachable = true;
  const vm = await viewModel();
  console.log('\n--- initial view-model ---\n' + describe(vm) + '\n');

  const byName = (n) => vm.items.find((it) => it.name === n);
  check('playlist name', vm.playlistName === 'Sunday AM — June 1');
  check('item count = 8', vm.items.length === 8);
  check('Welcome slides = 3', byName('Welcome').slideCount === 3);
  check('Amazing Grace slides = 12', byName('Amazing Grace').slideCount === 12);
  check('Sermon slides = 5', byName('Sermon: Living Hope').slideCount === 5);
  check('Closing slides = 8', byName('Closing Song').slideCount === 8);
  check('Benediction slides = 2', byName('Benediction').slideCount === 2);
  check('media item has no count', byName('Bumper Video').slideCount === null);
  check('header item has no count', byName('Pre-Service Loop').slideCount === null);
  check('active is Amazing Grace', vm.activeIndex === vm.items.findIndex((it) => it.name === 'Amazing Grace'));
  check('current slide >= 1', vm.currentSlide >= 1);
  check('current total = 12', vm.currentSlideTotal === 12);
  const from = vm.activeIndex + 1;
  const nextNames = vm.items.slice(from).filter((it) => !it.isHidden).map((it) => it.name);
  check('NEXT excludes hidden cue', !nextNames.includes('Hidden Cue'));
  check('NEXT starts with Sermon', nextNames[0] === 'Sermon: Living Hope');

  // Now exercise the live chunked stream for a few updates.
  console.log('\n--- streaming live updates ---');
  setTimeout(() => { console.error('TIMEOUT waiting for stream updates'); process.exit(3); }, 8000);
  const res = await fetch(ppUrl('/v1/status/updates'), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(['presentation/slide_index', 'playlist/current']),
  });
  check('stream opened (chunked)', res.ok && !!res.body);
  let updates = 0;
  const seenSlides = [];
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (String(msg.url).includes('presentation/slide_index')) {
        applySlideIndex(msg.data);
        seenSlides.push(state.currentSlide);
        console.log(describe(await viewModel()).split('\n')[0]);
        updates += 1;
      }
    }
    if (updates >= 4) break;
  }
  check('received >= 4 live slide updates', updates >= 4);
  check('slide value changed across updates', new Set(seenSlides).size >= 2);

  console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('verify error:', e); process.exit(2); });
