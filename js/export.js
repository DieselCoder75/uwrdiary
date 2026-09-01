// ── Sheets-vienti (admin) ─────────────────────────────────────
// Lukee treenidatan Firestoresta admin-selaimessa ja puskee sen Google Sheetiin
// Apps Script Web App -välityksen kautta. Kaksi vaihetta:
//   backfill    — vanhimmat treenit ensin, ≤5000 lukua/vrk, kunnes rintama saavuttaa
//                 today−30 pv jokaiselle pelaajalle.
//   maintenance — ≤1000 lukua/vrk: tuoreikkuna (uudet/muuttuneet) joka ajolla +
//                 kiertävä tarkistusikkuna (poistot/muutokset) menneisyyteen.
// Kaikki pysyvä tila haetaan Sheetistä (GET) ennen ajoa → app on tilaton.

const EXPORT_CFG_LS   = 'uppis_export_cfg';         // { url, secret, sheetUrl }
const EXPORT_CAP_BACK = 5000;
const EXPORT_CAP_MAINT = 1000;
const EXPORT_FRONTIER_DAYS = 30;   // backfill-rintaman raja (today − N)
const EXPORT_WINDOW_DAYS   = 14;   // tarkistusikkunan leveys
const EXPORT_VERIFY_DAYS   = 120;  // kuinka kauas taakse kiertävä tarkistus ulottuu
const EXPORT_PAGE          = 300;  // Firestore-sivun koko

const EXPORT_PERF = ['', 'I – Peruskunto', 'II – Kestävyys', 'III – Maksimikestävyys', 'IV – Nopeuskestävyys', 'V – Nopeus'];
const EXPORT_FEEL = ['', 'Erittäin väsynyt', 'Väsynyt', 'Normaali', 'Hyvä', 'Erinomainen'];

function exportGetCfg() {
  try { return JSON.parse(localStorage.getItem(EXPORT_CFG_LS) || 'null'); }
  catch { return null; }
}
function exportSetCfg(cfg) {
  localStorage.setItem(EXPORT_CFG_LS, JSON.stringify(cfg));
}

function exportIsoDay(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function exportDayMinus(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d;
}

function exportStatus(msg, color) {
  const s = el('export-status');
  if (!s) return;
  s.textContent = msg;
  s.style.color = color || 'var(--text-muted)';
}

// ── Web App -kutsut ───────────────────────────────────────────

async function exportGetState(cfg) {
  const res = await fetch(cfg.url + '?secret=' + encodeURIComponent(cfg.secret), {
    method: 'GET',
  });
  const data = await res.json();
  if (data.error) throw new Error('GET: ' + data.error);
  return data.state || null;
}

async function exportPost(cfg, payload) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    // text/plain → ei CORS-preflightia Apps Scriptille
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ secret: cfg.secret }, payload)),
  });
  const data = await res.json();
  if (data.error) throw new Error('POST: ' + data.error);
  return data;
}

// ── Rivien muunnos ────────────────────────────────────────────

function exportEntryRow(uid, entryId, e, playerName, email) {
  const dateIso = e.date?.toDate ? exportIsoDay(e.date.toDate()) : '';
  const updIso  = e.updatedAt?.toDate ? e.updatedAt.toDate().toISOString() : '';
  return [
    uid + '|' + entryId,
    playerName, email, dateIso,
    e.type || '',
    e.duration ?? '',
    e.performance ? EXPORT_PERF[e.performance] : '',
    e.feeling ? EXPORT_FEEL[e.feeling] : '',
    e.distance ?? '', e.avgHr ?? '', e.maxHr ?? '',
    e.comment ?? '', updIso,
  ];
}

// ── Käyttäjälista (kevyt, ei count-aggregaattia) ──────────────

async function exportUserList() {
  if (Array.isArray(cachedAdminUsers) && cachedAdminUsers.length) {
    return { users: cachedAdminUsers.map(u => ({ uid: u.uid, email: u.email, profile: u.profile || {} })), reads: 0 };
  }
  const snap = await db.collection('users').get();
  return {
    users: snap.docs.map(d => ({ uid: d.id, email: d.data().email || '', profile: d.data().profile || {} })),
    reads: snap.size,
  };
}

function exportPlayerName(u) {
  const p = u.profile || {};
  return (p.nickname || [p.firstName, p.lastName].filter(Boolean).join(' ') || u.email || u.uid).trim();
}

// ── Pääajologiikka ────────────────────────────────────────────

async function runSheetExport() {
  const cfg = exportGetCfg();
  if (!cfg || !cfg.url || !cfg.secret) {
    exportStatus('Aseta ensin Web App -URL ja salasana.', 'var(--red)');
    return;
  }
  const btn = el('export-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Ajetaan…'; }

  try {
    exportStatus('Haetaan tila Sheetistä…');
    let state = await exportGetState(cfg);
    const today = exportIsoDay(new Date());
    if (!state || typeof state !== 'object') state = {};
    if (state.phase !== 'maintenance') state.phase = 'backfill';
    if (!state.users) state.users = {};
    if (state.readDate !== today) { state.readDate = today; state.readToday = 0; }
    if (typeof state.verifyStep !== 'number') state.verifyStep = 1;

    const cap = state.phase === 'maintenance' ? EXPORT_CAP_MAINT : EXPORT_CAP_BACK;
    let budget = cap - (state.readToday || 0);
    if (budget <= 0) {
      exportStatus(`Päivän lukukiintiö (${cap}) käytetty. Jatka huomenna.`, 'var(--red)');
      return;
    }

    const { users, reads: listReads } = await exportUserList();
    state.readToday += listReads; budget -= listReads;

    if (state.phase === 'backfill') {
      await exportRunBackfill(cfg, state, users, () => budget, n => { budget -= n; });
    } else {
      await exportRunMaintenance(cfg, state, users, () => budget, n => { budget -= n; });
    }

    // Vaiheen vaihto: kaikki pelaajat rintamassa → maintenance
    if (state.phase === 'backfill') {
      const allDone = users.every(u => state.users[u.uid] && state.users[u.uid].done);
      if (allDone) { state.phase = 'maintenance'; state.watermark = 0; }
    }

    await exportPost(cfg, { state });
    exportRenderStatus(state, users.length);
  } catch (err) {
    console.error('Sheets-vienti:', err);
    exportStatus('Virhe: ' + err.message, 'var(--red)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Päivitä Sheet'; }
  }
}

// Backfill: vanhimmat ensin per pelaaja, kunnes kursori ylittää today−30pv.
async function exportRunBackfill(cfg, state, users, getBudget, spend) {
  const frontierIso = exportIsoDay(exportDayMinus(EXPORT_FRONTIER_DAYS));
  const rows = [];
  let processed = 0;

  for (const u of users) {
    if (getBudget() <= 0) break;
    const us = state.users[u.uid] || { cursor: null, done: false };
    if (us.done) { state.users[u.uid] = us; continue; }

    const playerName = exportPlayerName(u);
    const col = db.collection('users').doc(u.uid).collection('entries');

    while (getBudget() > 0 && !us.done) {
      let q = col.orderBy('date', 'asc');
      if (us.cursor) q = q.startAfter(firebase.firestore.Timestamp.fromMillis(us.cursor));
      q = q.limit(Math.min(EXPORT_PAGE, getBudget()));
      const snap = await q.get();
      const n = snap.size;
      state.readToday += n; spend(n);
      if (snap.empty) { us.done = true; break; }

      snap.docs.forEach(d => rows.push(exportEntryRow(u.uid, d.id, d.data(), playerName, u.email)));
      const lastDoc = snap.docs[snap.size - 1];
      const lastMs  = lastDoc.data().date?.toMillis?.() ?? null;
      us.cursor = lastMs;

      const lastIso = lastDoc.data().date?.toDate ? exportIsoDay(lastDoc.data().date.toDate()) : '';
      if (lastIso >= frontierIso) us.done = true;       // rintama saavutettu
      else if (snap.size < EXPORT_PAGE) us.done = true; // pelaajan treenit loppu
    }
    state.users[u.uid] = us;
    processed++;
    exportStatus(`Backfill… ${processed}/${users.length} pelaajaa · ${rows.length} riviä`);

    // Puske väliraportti ettei muistiin kerry liikaa
    if (rows.length >= 1000) { await exportPost(cfg, { treenit: rows.splice(0) }); }
  }
  if (rows.length) await exportPost(cfg, { treenit: rows });
}

// Maintenance: (1) tuoreikkuna [today−14pv, today+1] joka ajolla,
// (2) kiertävä tarkistusikkuna menneisyyteen. Molemmat upsert + poistosovitus.
async function exportRunMaintenance(cfg, state, users, getBudget, spend) {
  const step = state.verifyStep || 1;
  const maxStep = Math.ceil(EXPORT_VERIFY_DAYS / EXPORT_WINDOW_DAYS);

  const windows = [];
  // Ikkuna 0 (tuore) aina
  windows.push(exportWindow(0));
  // Kiertävä ikkuna (ohita 0, se on jo mukana)
  if (maxStep > 1) windows.push(exportWindow(step));

  for (const win of windows) {
    const rows = [];
    const keys = [];
    for (const u of users) {
      if (getBudget() <= 0) break;
      const playerName = exportPlayerName(u);
      const col = db.collection('users').doc(u.uid).collection('entries');
      let cursor = null;
      while (getBudget() > 0) {
        let q = col
          .where('date', '>=', firebase.firestore.Timestamp.fromMillis(win.startMs))
          .where('date', '<',  firebase.firestore.Timestamp.fromMillis(win.endMs))
          .orderBy('date', 'asc');
        if (cursor) q = q.startAfter(firebase.firestore.Timestamp.fromMillis(cursor));
        q = q.limit(Math.min(EXPORT_PAGE, getBudget()));
        const snap = await q.get();
        const n = snap.size;
        state.readToday += n; spend(n);
        if (snap.empty) break;
        snap.docs.forEach(d => {
          rows.push(exportEntryRow(u.uid, d.id, d.data(), playerName, u.email));
          keys.push(u.uid + '|' + d.id);
        });
        if (snap.size < EXPORT_PAGE) break;
        cursor = snap.docs[snap.size - 1].data().date?.toMillis?.() ?? null;
      }
    }
    await exportPost(cfg, {
      treenit: rows,
      verifyWindows: [{ start: win.start, end: win.end, keys }],
    });
    exportStatus(`Maintenance… ikkuna ${win.start}–${win.end} · ${rows.length} riviä`);
  }

  // Etene kiertävää ikkunaa
  state.verifyStep = (step % (maxStep - 1 || 1)) + 1;
}

function exportWindow(step) {
  // step 0 → [today−14, today+1)  (tuore, sisältää tämän päivän)
  // step k → [today−(k+1)*14, today−k*14)
  const start = exportDayMinus((step + 1) * EXPORT_WINDOW_DAYS);
  const end   = step === 0 ? exportDayMinus(-1) : exportDayMinus(step * EXPORT_WINDOW_DAYS);
  return {
    start: exportIsoDay(start), end: exportIsoDay(end),
    startMs: start.getTime(),  endMs: end.getTime(),
  };
}

function exportRenderStatus(state, userCount) {
  const cap = state.phase === 'maintenance' ? EXPORT_CAP_MAINT : EXPORT_CAP_BACK;
  const doneCount = Object.values(state.users || {}).filter(u => u.done).length;
  let line = `Vaihe: ${state.phase === 'maintenance' ? 'ylläpito' : 'alkulataus'}`;
  if (state.phase === 'backfill') line += ` · ${doneCount}/${userCount} pelaajaa valmiina`;
  line += ` · tänään luettu ${state.readToday}/${cap}`;
  exportStatus('✓ ' + line, 'var(--green)');
}

// ── Testit (pieni data, täysi korvaus) ────────────────────────

async function runTestExport() {
  const cfg = exportGetCfg();
  if (!cfg || !cfg.url || !cfg.secret) {
    exportStatus('Aseta ensin Web App -URL ja salasana.', 'var(--red)');
    return;
  }
  const btn = el('export-tests-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Ajetaan…'; }
  try {
    const { users } = await exportUserList();
    const rows = [];
    for (const u of users) {
      const name = exportPlayerName(u);
      const base = db.collection('users').doc(u.uid);
      const [fit, max] = await Promise.all([
        base.collection('fitTests').get(),
        base.collection('maxSpeedTests').get(),
      ]);
      fit.docs.forEach(d => {
        const t = d.data();
        const times = (t.measurements || []).map(m => m.time).filter(x => x != null);
        const summary = times.length ? times.join(' / ') : '';
        rows.push([u.uid + '|fit|' + d.id, name, u.email, '10×100m',
          t.date?.toDate ? exportIsoDay(t.date.toDate()) : '', summary]);
      });
      max.docs.forEach(d => {
        const t = d.data();
        rows.push([u.uid + '|max|' + d.id, name, u.email, 'Max nopeus',
          t.date?.toDate ? exportIsoDay(t.date.toDate()) : '', t.time ?? '']);
      });
    }
    await exportPost(cfg, { testit: rows });
    exportStatus(`✓ Testit päivitetty — ${rows.length} riviä`, 'var(--green)');
  } catch (err) {
    console.error('Testivienti:', err);
    exportStatus('Virhe: ' + err.message, 'var(--red)');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Päivitä testit'; }
  }
}

// ── Asetusten tallennus ───────────────────────────────────────

function exportSaveCfg() {
  const url     = (el('export-url')?.value || '').trim();
  const secret  = (el('export-secret')?.value || '').trim();
  const sheetUrl = (el('export-sheet-url')?.value || '').trim();
  if (!url || !secret) { exportStatus('Anna sekä URL että salasana.', 'var(--red)'); return; }
  exportSetCfg({ url, secret, sheetUrl });
  exportStatus('Asetukset tallennettu tähän selaimeen.', 'var(--green)');
  exportInitPanel();
}

function exportInitPanel() {
  const cfg = exportGetCfg() || {};
  const u = el('export-url'), s = el('export-secret'), sh = el('export-sheet-url');
  if (u)  u.value  = cfg.url || '';
  if (s)  s.value  = cfg.secret || '';
  if (sh) sh.value = cfg.sheetUrl || '';
  const link = el('export-sheet-link');
  if (link) {
    if (cfg.sheetUrl) { link.href = cfg.sheetUrl; link.classList.remove('hidden'); }
    else link.classList.add('hidden');
  }
}

window.runSheetExport = runSheetExport;
window.runTestExport  = runTestExport;
window.exportSaveCfg  = exportSaveCfg;
window.exportInitPanel = exportInitPanel;
