// ============================================================
// ENTRIES — PAGINATED REAL-TIME LIST
// ============================================================

// Always the real signed-in user (profile reads/writes)
function getUserDoc() {
  return db.collection('users').doc(currentUser.uid);
}

// The user currently being viewed — impersonated user or real user
function getViewDoc() {
  return db.collection('users').doc(impersonating ? impersonating.uid : currentUser.uid);
}

// UID of the user currently being viewed — käytä KAIKISSA välimuistiavaimissa
// jotka koskevat treenidataa, jotta impersonointi ei sekoita adminin omaa cachea.
function viewUid() {
  return impersonating ? impersonating.uid : currentUser.uid;
}

function getUserEntries() {
  return getViewDoc().collection('entries');
}

// Serialise a Firestore doc to plain JSON (Timestamps → millis)
function serialiseEntry(doc) {
  const d = doc.data();
  return {
    id:          doc.id,
    date:        d.date?.toMillis       ? d.date.toMillis()      : null,
    updatedAt:   d.updatedAt?.toMillis  ? d.updatedAt.toMillis() : null,
    hasTime:     d.hasTime  ?? false,
    type:        d.type        || '',
    duration:    d.duration    || 0,
    performance: d.performance || 0,
    feeling:     d.feeling     || 0,
    comment:        d.comment        || '',
    privateComment: d.privateComment ?? false,
    distance:       d.distance      ?? null,
    avgHr:          d.avgHr         ?? null,
    maxHr:          d.maxHr         ?? null,
    reactionCounts: d.reactionCounts || {},
  };
}

// Deserialise back — restore Timestamp-like objects for existing code
function deserialiseEntry(raw) {
  const toTs = ms => ms ? { toMillis: () => ms, toDate: () => new Date(ms) } : null;
  return {
    date:           toTs(raw.date),
    updatedAt:      toTs(raw.updatedAt),
    hasTime:        raw.hasTime,
    type:           raw.type,
    duration:       raw.duration,
    performance:    raw.performance,
    feeling:        raw.feeling,
    comment:        raw.comment,
    privateComment: raw.privateComment ?? false,
    distance:       raw.distance ?? null,
    avgHr:          raw.avgHr   ?? null,
    maxHr:          raw.maxHr   ?? null,
    reactionCounts: raw.reactionCounts || {},
  };
}

// Returns a Date set to midnight at start of the Monday N weeks ago
function weeksAgoMonday(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;          // 1=Mon … 7=Sun
  d.setDate(d.getDate() - (day - 1));   // this Monday
  d.setDate(d.getDate() - n * 7);       // N weeks back
  return d;
}

// Returns the Monday (midnight) of the week that contains the given date
function weekMondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;          // 1=Mon … 7=Sun
  d.setDate(d.getDate() - (day - 1));
  return d;
}

function loadEntries() {
  pageWindowStart = weeksAgoMonday(PAGE_WEEKS);
  olderDocs       = [];
  hasMorePages    = true;

  hide('load-more-wrap');
  hide('no-more-entries');
  el('period-label').textContent = '';

  if (unsubEntries) { unsubEntries(); unsubEntries = null; }

  const cacheKey   = 'entries_' + pageWindowStart.getTime();
  const cachedDocs = Cache.get(viewUid(), cacheKey);

  // ── Serve from cache instantly (zero reads) ─────────────────
  if (cachedDocs && cachedDocs.length > 0) {
    const fakeDocs = cachedDocs.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
    allEntries = cachedDocs.map(raw => ({ id: raw.id, ...deserialiseEntry(raw) }));
    refreshActiveChart();
    renderPage(fakeDocs, olderDocs);
    const cachedHasMore = Cache.get(viewUid(), 'hasMore_' + pageWindowStart.getTime());
    if (cachedHasMore !== null) {
      hasMorePages = cachedHasMore;
      if (hasMorePages) show('load-more-wrap'); else hide('load-more-wrap');
    }
  } else {
    renderPage([], olderDocs);
  }

  // ── Background fetch — re-renders only if data changed ──────
  fetchEntries();
}

async function fetchEntries() {
  if (!currentUser) return;

  const btn = el('refresh-btn');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }

  try {
    const windowStart = firebase.firestore.Timestamp.fromDate(pageWindowStart);
    const cacheKey    = 'entries_' + pageWindowStart.getTime();

    // N+1 pattern: fetch the window docs + 1 extra doc to detect more pages without a separate query.
    // We drop the lower-bound filter and cap at 501 docs; any doc below windowStart means more pages exist.
    const PAGE_CAP = 500;
    const snapPlus1    = await getUserEntries().orderBy('date', 'desc').limit(PAGE_CAP + 1).get();
    const inWindowDocs = snapPlus1.docs.filter(d => {
      const ts = d.data().date;
      return ts && (ts.toMillis ? ts.toMillis() : 0) >= windowStart.toMillis();
    });
    const hasExtra = snapPlus1.docs.length > inWindowDocs.length;

    const serialised = inWindowDocs.map(serialiseEntry);
    const cached     = Cache.get(viewUid(), cacheKey) || [];

    if (Cache.fingerprint(serialised) !== Cache.fingerprint(cached)) {
      Cache.set(viewUid(), cacheKey, serialised);
      allEntries = inWindowDocs.map(doc => ({ id: doc.id, ...doc.data() }));
      refreshActiveChart();
      renderPage(inWindowDocs, olderDocs);
    }

    // Always update hasMorePages from the fresh Firestore result (N+1 pattern gives this for free)
    hasMorePages = hasExtra;
    Cache.set(viewUid(), 'hasMore_' + pageWindowStart.getTime(), hasMorePages);
    if (hasMorePages) show('load-more-wrap'); else hide('load-more-wrap');
  } catch (err) {
    console.error('fetchEntries:', err);
  } finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

// ── Chart entries: full 12-week window, independent of Treenit pagination ──
async function fetchChartEntries() {
  if (!currentUser) return;

  const weeks    = getLastNWeeks(12);
  const weekStart = weeks[0];
  // Cache-avain seuraa katseltavaa käyttäjää (impersonointi)
  const viewUid  = impersonating ? impersonating.uid : currentUser.uid;
  const lsKey    = 'uppis_ch_' + viewUid;

  // Serve from cache if fresh
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CHART_CACHE_TTL && parsed.wk === weekStart.getTime()) {
        allChartEntries = parsed.data.map(e => ({ id: e.id, ...deserialiseEntry(e) }));
        return;
      }
    }
  } catch {}

  // Fetch from Firestore
  const cutoff = firebase.firestore.Timestamp.fromDate(weekStart);
  const snap   = await getUserEntries().where('date', '>=', cutoff).orderBy('date', 'desc').get();
  allChartEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Cache
  try {
    localStorage.setItem(lsKey, JSON.stringify({
      ts: Date.now(), wk: weekStart.getTime(),
      data: snap.docs.map(serialiseEntry),
    }));
  } catch {}
}

function invalidateChartCache() {
  const viewUid = impersonating ? impersonating.uid : currentUser.uid;
  try { localStorage.removeItem('uppis_ch_' + viewUid); } catch {}
  allChartEntries = [];
}

async function loadOlderPage() {
  const btn = el('load-more-btn');
  btn.disabled = true;
  btn.textContent = 'Ladataan…';

  // Earliest meaningful date to search back to (avoid infinite loops)
  const MIN_DATE = new Date('2020-01-01');

  try {
    let searchFrom  = new Date(pageWindowStart);
    let olderRaw    = [];
    let newWindowStart;

    // Skip empty windows — keep going back until we find entries or hit MIN_DATE
    while (olderRaw.length === 0 && searchFrom > MIN_DATE) {
      newWindowStart = new Date(searchFrom);
      newWindowStart.setDate(newWindowStart.getDate() - OLDER_PAGE_WEEKS * 7);

      const from     = firebase.firestore.Timestamp.fromDate(newWindowStart);
      const to       = firebase.firestore.Timestamp.fromDate(searchFrom);
      const cacheKey = 'entries_older_' + newWindowStart.getTime();

      const cachedOlder = Cache.get(viewUid(), cacheKey);
      if (cachedOlder) {
        olderRaw = cachedOlder;
      } else {
        const snap = await getUserEntries()
          .orderBy('date', 'desc')
          .where('date', '>=', from)
          .where('date', '<',  to)
          .get();
        olderRaw = snap.docs.map(serialiseEntry);
        Cache.set(viewUid(), cacheKey, olderRaw);
      }

      if (olderRaw.length === 0) {
        searchFrom = newWindowStart; // window empty — step further back
      }
    }

    if (olderRaw.length === 0) {
      // Exhausted all windows back to MIN_DATE
      hasMorePages = false;
      hide('load-more-wrap');
      show('no-more-entries');
    } else {
      const fakeDocs = olderRaw.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
      olderDocs = [...olderDocs, ...fakeDocs];
      pageWindowStart = newWindowStart;

      // Check for even older entries
      const oldest    = firebase.firestore.Timestamp.fromDate(newWindowStart);
      const checkSnap = await getUserEntries().where('date', '<', oldest).limit(1).get();
      hasMorePages    = !checkSnap.empty;
      Cache.set(viewUid(), 'hasMore_' + newWindowStart.getTime(), hasMorePages);

      // Get live window docs from cache
      const liveKey      = 'entries_' + weeksAgoMonday(PAGE_WEEKS).getTime();
      const liveRaw      = Cache.get(viewUid(), liveKey) || [];
      const liveFakeDocs = liveRaw.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));

      allEntries = [...liveFakeDocs, ...olderDocs].map(d => ({ id: d.id, ...d.data() }));
      refreshActiveChart();
      renderPage(liveFakeDocs, olderDocs);
    }
  } catch (err) {
    console.error(err);
    toast('Vanhempien treenien lataus epäonnistui.', 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Lataa 2 viikkoa lisää';
}

function sortEntries(docs) {
  return [...docs].sort((a, b) => {
    const da = a.data(), db_ = b.data();
    const ta = da.date?.toMillis ? da.date.toMillis() : new Date(da.date).getTime();
    const tb = db_.date?.toMillis ? db_.date.toMillis() : new Date(db_.date).getTime();

    // Local YYYY-MM-DD key — avoids UTC offset issues in Finland (UTC+2/+3)
    const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const dayA = localDay(ta);
    const dayB = localDay(tb);

    // Different days → later day first
    if (dayA !== dayB) return dayA > dayB ? -1 : 1;

    // Same day: timed entries before date-only
    const haA = da.hasTime ?? (ta % 86400000 !== 0);
    const haB = db_.hasTime ?? (tb % 86400000 !== 0);
    if (haA !== haB) return haB ? 1 : -1;

    // Both timed → later time first
    if (haA && haB) return tb - ta;

    // Both date-only → later updatedAt first (or doc order)
    const ua = da.updatedAt?.toMillis ? da.updatedAt.toMillis() : 0;
    const ub = db_.updatedAt?.toMillis ? db_.updatedAt.toMillis() : 0;
    return ub - ua;
  });
}

function entryCardHtml(doc) {
  const d         = doc.data();
  const date      = d.date ? formatDisplayDate(d.date) : '—';
  const comment   = d.comment ? `<div class="entry-comment">${escapeHtml(d.comment)}</div>` : '';
  const perfColor = d.performance ? PERF_COLORS[d.performance - 1] : 'var(--blue)';
  return `
    <div class="entry-card" onclick="openEntry('${doc.id}')">
      <div class="entry-card-stripe" style="background:${perfColor}"></div>
      <div class="entry-card-body">
        <div class="entry-card-header">
          <span class="entry-type">${escapeHtml(d.type || '—')}</span>
          <span class="entry-date">${escapeHtml(date)}</span>
        </div>
        <div class="entry-stats-grid">
          <span class="entry-duration">⏱ ${escapeHtml(String(d.duration || '?'))} min</span>
          <span class="stats-center">${d.performance ? `<span class="entry-perf-badge" style="background:${PERF_COLORS[d.performance-1]}22;color:${PERF_COLORS_DARK[d.performance-1]};border:1px solid ${PERF_COLORS[d.performance-1]}55">${PERF_ROMAN[d.performance - 1]} – ${PERF_LABELS[d.performance].split(' – ')[1]}</span>` : ''}</span>
          <span class="stats-right">${d.feeling ? `<span class="entry-feel-badge" style="background:${FEEL_COLORS[d.feeling].bg};color:${FEEL_COLORS[d.feeling].color}">${FEEL_EMOJIS[d.feeling]} ${FEEL_LABELS[d.feeling]}</span>` : ''}</span>
          ${(d.distance != null || d.avgHr != null || d.maxHr != null) ? `
          <span class="extra-col1">${d.distance != null ? `📍 ${String(d.distance).replace('.', ',')} km` : ''}</span>
          <span class="extra-col2">${d.avgHr != null ? `❤️ ${d.avgHr} bpm` : ''}</span>
          <span class="extra-col3">${d.maxHr != null ? `🔺 ${d.maxHr} bpm` : ''}</span>` : ''}
        </div>
        ${comment}
        <div class="entry-reactions" id="ereact-${doc.id}"></div>
      </div>
    </div>`;
}

// ============================================================
// VIIKKOYHTEENVETO-KORTTI
// ── Tavoiterengas-helper (jaettu kuluvan + menneiden korteille) ──
const _WSC_R    = 15; // hieman pienempi → paksumpi viiva ei kasvata ulkomittaa
const _WSC_CIRC = +(2 * Math.PI * _WSC_R).toFixed(2);

function _ringHtml(current, goal, label, isPast = false) {
  const pct  = Math.min(current / goal, 1);
  const done = pct >= 1;
  if (done) {
    return `<div class="wsc-goal-row">
      <span class="wsc-goal-text">${current}&thinsp;/&thinsp;${goal}&thinsp;${label}</span>
      <svg class="wsc-ring" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="${_WSC_R}" fill="rgba(255,255,255,0.15)"/>
        <circle cx="20" cy="20" r="${_WSC_R}" fill="#22C55E"/>
        <path d="M13 21l4.5 4.5 9.5-9.5" stroke="white" stroke-width="2.5"
              fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>`;
  }
  // Mennyt viikko + tavoite ei täyttynyt → punainen X
  if (isPast) {
    return `<div class="wsc-goal-row">
      <span class="wsc-goal-text">${current}&thinsp;/&thinsp;${goal}&thinsp;${label}</span>
      <svg class="wsc-ring" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="${_WSC_R}" fill="rgba(255,255,255,0.15)"/>
        <circle cx="20" cy="20" r="${_WSC_R}" fill="#EF4444"/>
        <path d="M14 14 L26 26 M26 14 L14 26" stroke="white" stroke-width="2.5"
              fill="none" stroke-linecap="round"/>
      </svg>
    </div>`;
  }
  const offset = +((_WSC_CIRC) * (1 - pct)).toFixed(2);
  return `<div class="wsc-goal-row">
    <span class="wsc-goal-text">${current}&thinsp;/&thinsp;${goal}&thinsp;${label}</span>
    <svg class="wsc-ring" viewBox="0 0 40 40">
      <circle class="wsc-ring-bg" cx="20" cy="20" r="${_WSC_R}"/>
      <circle class="wsc-ring-fg" cx="20" cy="20" r="${_WSC_R}"
        stroke-dasharray="${_WSC_CIRC}" stroke-dashoffset="${offset}"
        transform="rotate(-90 20 20)"/>
    </svg>
  </div>`;
}

// ============================================================
function renderWeekSummaryCard() {
  const card = el('week-summary-card');
  if (!card) return;

  const monday    = weeksAgoMonday(0);
  const mondayMs  = monday.getTime();
  const sundayMs  = mondayMs + 7 * 24 * 60 * 60 * 1000; // seuraava maanantai (exclusive)

  // Tämän viikon kirjaukset (ma–su)
  const weekEntries = allEntries.filter(e => {
    const ms = e.date?.toMillis ? e.date.toMillis()
             : e.date?.seconds  ? e.date.seconds * 1000
             : 0;
    return ms >= mondayMs && ms < sundayMs;
  });

  const count    = weekEntries.length;
  const totalMin = weekEntries.reduce((s, e) => s + (e.duration || 0), 0);

  // Tehoaluejakauma minuuteissa (indeksi 0=I … 4=V)
  const perfMins = [0, 0, 0, 0, 0];
  weekEntries.forEach(e => {
    const p = e.performance;
    if (p >= 1 && p <= 5) perfMins[p - 1] += (e.duration || 0);
  });
  const perfTotal = perfMins.reduce((s, m) => s + m, 0);

  // Viikkonumero ja suunniteltu vyöhyke
  // calPlannedZone palauttaa merkkijonon ('IV', 'I–II' jne.) tai null
  const { week } = calIsoWeekData(monday);
  const zone     = typeof calPlannedZone === 'function' ? calPlannedZone(monday) : null;
  const _zoneNum  = zone ? Math.max(...parseZoneStr(zone)) : 0;
  const _zoneName = _zoneNum ? PERF_LABELS[_zoneNum].split(' – ')[1] : '';
  const weekLabel = zone
    ? (_zoneName ? `${_zoneName} · ${zone} · vk ${week}` : `${zone} · vk ${week}`)
    : `vk ${week}`;

  // Palkki ja labelit
  let barHtml   = '';
  let labelHtml = '';
  if (perfTotal > 0) {
    perfMins.forEach((mins, i) => {
      if (!mins) return;
      barHtml += `<div class="wsc-bar-seg" style="flex:${mins / perfTotal};background:${PERF_COLORS[i]}"></div>`;
    });
    perfMins.forEach((mins, i) => {
      if (!mins) return;
      const pct = Math.round(mins / perfTotal * 100);
      labelHtml += `<span class="wsc-label">
        <span class="wsc-label-dot" style="background:${PERF_COLORS[i]}"></span>
        ${['I','II','III','IV','V'][i]}&thinsp;${pct}%
      </span>`;
    });
  }

  // ── Tavoiterenkaat ──────────────────────────────────────────
  const minGoal  = userProfile?.weeklyMinutesGoal  || null;
  const sessGoal = userProfile?.weeklySessionsGoal || null;

  const goalsHtml = (minGoal || sessGoal) ? `
    <div class="wsc-goals">
      ${minGoal  ? _ringHtml(totalMin, minGoal,  'min') : ''}
      ${sessGoal ? _ringHtml(count,    sessGoal, 'krt') : ''}
    </div>` : '';

  const _zoneTag = zone
    ? `<span class="wsc-zone-inline">${escapeHtml(zone)}${_zoneName ? ` – ${escapeHtml(_zoneName)}` : ''}</span>`
    : '<span></span>';

  card.innerHTML = `
    <div class="wsc-grid">
      <span class="wsc-week">KULUVA VIIKKO</span>
      ${_zoneTag}
      <div class="wsc-count-row">
        <span class="wsc-big">${count}</span>
        <span class="wsc-meta">${count === 1 ? 'treeni' : 'treeniä'}&thinsp;·&thinsp;${totalMin}&thinsp;min</span>
      </div>
      ${goalsHtml || '<span></span>'}
    </div>
    ${perfTotal > 0 ? `
    <div class="wsc-bar-wrap">${barHtml}</div>
    <div class="wsc-labels">${labelHtml}</div>` : ''}
  `;
  card.classList.remove('hidden');
}

// Generates a past-week summary card HTML (inserted inline in the entries list)
function pastWeekSummaryHtml(docs, monday) {
  const entries  = docs.map(d => d.data());
  const count    = entries.length;
  const totalMin = entries.reduce((s, e) => s + (e.duration || 0), 0);

  const perfMins = [0, 0, 0, 0, 0];
  entries.forEach(e => {
    const p = e.performance;
    if (p >= 1 && p <= 5) perfMins[p - 1] += (e.duration || 0);
  });
  const perfTotal = perfMins.reduce((s, m) => s + m, 0);

  const { week, year } = (typeof calIsoWeekData === 'function') ? calIsoWeekData(monday) : { week: '?', year: monday.getFullYear() };
  const thisYear = new Date().getFullYear();
  const yearSuffix = year !== thisYear ? ` ${year}` : '';
  const zone = (typeof calPlannedZone === 'function') ? calPlannedZone(monday) : null;
  const _pZoneNum  = zone ? Math.max(...parseZoneStr(zone)) : 0;
  const _pZoneName = _pZoneNum ? PERF_LABELS[_pZoneNum].split(' – ')[1] : '';
  const rightLabel = zone
    ? (_pZoneName ? `${_pZoneName} · ${zone} · vk ${week}${yearSuffix}` : `${zone} · vk ${week}${yearSuffix}`)
    : `vk ${week}${yearSuffix}`;

  let barHtml = '', labelHtml = '';
  if (perfTotal > 0) {
    perfMins.forEach((mins, i) => {
      if (!mins) return;
      barHtml   += `<div class="wsc-bar-seg" style="flex:${mins / perfTotal};background:${PERF_COLORS[i]}"></div>`;
    });
    perfMins.forEach((mins, i) => {
      if (!mins) return;
      const pct = Math.round(mins / perfTotal * 100);
      labelHtml += `<span class="wsc-label"><span class="wsc-label-dot" style="background:${PERF_COLORS[i]}"></span>${['I','II','III','IV','V'][i]}&thinsp;${pct}%</span>`;
    });
  }

  const _pZoneTag = _pZoneNum
    ? `<span class="wsc-zone-inline">${escapeHtml(zone)}${_pZoneName ? ` – ${escapeHtml(_pZoneName)}` : ''}</span>`
    : '<span></span>';

  const _pMg = userProfile?.weeklyMinutesGoal  || null;
  const _pSg = userProfile?.weeklySessionsGoal || null;
  const _pGoalsHtml = (_pMg || _pSg) ? `<div class="wsc-goals">
    ${_pMg ? _ringHtml(totalMin, _pMg, 'min', true) : ''}
    ${_pSg ? _ringHtml(count,    _pSg, 'krt', true) : ''}
  </div>` : '';

  return `<div class="week-summary-card week-summary-card--past">
    <div class="wsc-grid">
      <span class="wsc-week">VK ${week}${yearSuffix}</span>
      ${_pZoneTag}
      <div class="wsc-count-row">
        <span class="wsc-big">${count}</span>
        <span class="wsc-meta">${count === 1 ? 'treeni' : 'treeniä'}&thinsp;·&thinsp;${totalMin}&thinsp;min</span>
      </div>
      ${_pGoalsHtml || '<span></span>'}
    </div>
    ${perfTotal > 0 ? `<div class="wsc-bar-wrap">${barHtml}</div><div class="wsc-labels">${labelHtml}</div>` : ''}
  </div>`;
}

function renderPage(liveDocs, extraDocs) {
  const list  = el('entries-list');
  const empty = el('empty-state');
  const allDocs = sortEntries([...liveDocs, ...extraDocs]);

  renderWeekSummaryCard();

  if (allDocs.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    hide('load-more-wrap');
    el('period-label').textContent = '';
    return;
  }

  empty.classList.add('hidden');

  // Group entries by week, insert past-week summary cards at week boundaries
  const thisWeekMs = weeksAgoMonday(0).getTime();
  const weekGroups = new Map(); // weekMondayMs -> { monday, docs[] }
  allDocs.forEach(doc => {
    const ts  = doc.data().date;
    const ms  = ts?.toMillis ? ts.toMillis() : ts?.seconds ? ts.seconds * 1000 : 0;
    const mon = weekMondayOf(new Date(ms));
    const key = mon.getTime();
    if (!weekGroups.has(key)) weekGroups.set(key, { monday: mon, docs: [] });
    weekGroups.get(key).docs.push(doc);
  });
  const sortedWeeks = [...weekGroups.entries()].sort((a, b) => b[0] - a[0]);

  let html = '';
  sortedWeeks.forEach(([weekMs, { monday, docs }]) => {
    if (weekMs < thisWeekMs) {
      html += pastWeekSummaryHtml(docs, monday);
    }
    html += docs.map(entryCardHtml).join('');
  });
  list.innerHTML = html;
  showOwnEntryReactions(allDocs); // reads from cached reactionCounts — zero Firestore reads

  // Period label
  const newest = allDocs[0].data().date;
  const oldest = allDocs[allDocs.length - 1].data().date;
  const fmt    = ts => { const d = ts?.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' }); };
  el('period-label').textContent = `Näytetään: ${fmt(oldest)} – ${fmt(newest)}`;

  // Load-more button
  if (hasMorePages) {
    show('load-more-wrap');
    hide('no-more-entries');
  } else {
    hide('load-more-wrap');
    show('no-more-entries');
  }
}

// ============================================================
// OWN ENTRY REACTIONS (read-only display — reads from reactionCounts, zero Firestore reads)
// ============================================================
function showOwnEntryReactions(allDocs) {
  allDocs.forEach(doc => {
    const counts = doc.data().reactionCounts;
    if (!counts) return;
    const slot = document.getElementById('ereact-' + doc.id);
    if (!slot) return;
    const badges = REACTION_EMOJIS
      .filter(e => (counts[e] || 0) > 0)
      .map(e => `<span class="own-reaction-badge">${e} ${counts[e]}</span>`)
      .join('');
    if (badges) slot.innerHTML = `<div class="own-reactions-row">${badges}</div>`;
  });
}

// ============================================================
// MODAL — OPEN / CLOSE
// ============================================================
el('add-btn').addEventListener('click', () => { haptic('light'); openModal(); });
el('close-modal').addEventListener('click', closeModal);
el('entry-modal').querySelector('.modal-backdrop').addEventListener('click', closeModal);
el('entry-comment').addEventListener('input', updateCommentCounter);

function openModal(entryId = null, data = null) {
  if (impersonating) return;  // read-only while viewing another user
  currentEntryId = entryId;
  // Säilytä alkuperäinen data jotta records-päivitys osaa laskea deltan editissä
  originalEntryData = entryId && data ? {
    date: data.date,
    duration: data.duration,
    type: data.type,
  } : null;
  el('modal-title').textContent = entryId ? 'Muokkaa treeniä' : 'Uusi Treeni';
  el('delete-entry-btn').classList.toggle('hidden', !entryId);

  // Date — cap at today so future dates cannot be selected
  // Use local time (not toISOString which is UTC — would be wrong date in Finland late at night)
  const today = timestampToDateStr(new Date());
  el('entry-date').max = today;
  el('entry-date').value = data?.date ? timestampToDateStr(data.date) : today;

  // Time
  const hasTime = data?.date ? checkHasTime(data.date) : false;
  el('show-time').checked = hasTime;
  el('entry-time').classList.toggle('hidden', !hasTime);
  el('entry-time').value = hasTime ? timestampToTimeStr(data.date) : '';

  // Type
  buildTypeCombobox(data?.type || '');

  // Other fields
  el('entry-duration').value  = data?.duration || 60;
  el('entry-comment').value           = data?.comment        || '';
  el('entry-private-comment').checked  = data?.privateComment ?? false;
  // Näytä "Yksityinen"-checkbox vain jos käyttäjä jakaa kommentit fiidissä
  const showPrivate = userProfile.shareActivities && userProfile.shareComments;
  el('entry-private-comment').closest('.toggle-label').classList.toggle('hidden', !showPrivate);
  updateCommentCounter();
  el('entry-distance').value  = data?.distance != null ? String(data.distance).replace('.', ',') : '';
  el('entry-heartrate').value = data?.avgHr    != null ? data.avgHr    : '';
  el('entry-maxhr').value     = data?.maxHr    != null ? data.maxHr    : '';

  // Open extra section only if editing and has extra data; otherwise close
  const extraEl = el('entry-extra');
  extraEl.open  = !!(data?.distance || data?.avgHr || data?.maxHr);

  // Stars
  setPerformance(data?.performance || 0);
  setFeeling(data?.feeling || 0);

  el('entry-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  hide('entry-modal');
  document.body.style.overflow = '';
}

// ============================================================
// ACTIVITY TYPE DROPDOWN
// ============================================================
// Build item list for the combobox (called each time modal opens for fresh recents)
function buildTypeCombobox(currentType) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const seen   = new Set();
  const recent = [];
  [...allEntries]
    .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0))
    .forEach(e => {
      const ms = e.date?.toMillis ? e.date.toMillis() : 0;
      if (ms >= cutoff && e.type && !seen.has(e.type)) { seen.add(e.type); recent.push(e.type); }
    });

  // Store grouped items for filtering
  el('entry-type-list').dataset.recent = JSON.stringify(recent);

  // Render list and set input value
  el('entry-type').value = currentType || '';
  renderComboboxList('');
}

function renderComboboxList(query) {
  const listEl  = el('entry-type-list');
  const q       = query.trim().toLowerCase();
  const recent  = JSON.parse(listEl.dataset.recent || '[]');

  const match = t => !q || t.toLowerCase().includes(q);

  const recentFiltered = recent.filter(match);
  const allFiltered    = ALL_TYPES.filter(t => match(t) && !recent.includes(t));

  let html = '';

  if (recentFiltered.length > 0) {
    html += `<li class="combobox-group">Viimeisimmät</li>`;
    recentFiltered.forEach(t => {
      html += `<li class="combobox-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (allFiltered.length > 0) {
    html += `<li class="combobox-group">Kaikki lajit</li>`;
    allFiltered.forEach(t => {
      html += `<li class="combobox-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (!html) {
    html = `<li class="combobox-empty">Ei tuloksia — tallennetaan omana lajina</li>`;
  }

  listEl.innerHTML = html;
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`
    + escapeHtml(text.slice(idx + q.length));
}

function isTouchDevice() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

// ── Desktop combobox ──────────────────────────────────────────
function openCombobox() {
  const input  = el('entry-type');
  const listEl = el('entry-type-list');
  renderComboboxList(input.value);
  listEl.classList.add('open');
  input.setAttribute('aria-expanded', 'true');
}

function closeCombobox() {
  const listEl = el('entry-type-list');
  listEl.classList.remove('open');
  el('entry-type').setAttribute('aria-expanded', 'false');
}

// ── Mobile bottom sheet ───────────────────────────────────────
function renderSheetList(query) {
  const listEl  = el('sheet-list');
  const q       = query.trim().toLowerCase();
  const recent  = JSON.parse(el('entry-type-list').dataset.recent || '[]');
  const match   = t => !q || t.toLowerCase().includes(q);

  const recentFiltered = recent.filter(match);
  const allFiltered    = ALL_TYPES.filter(t => match(t) && !recent.includes(t));

  let html = '';

  // Custom entry shortcut when query doesn't exactly match a known type
  const exactMatch = [...recent, ...ALL_TYPES].some(t => t.toLowerCase() === q);
  if (q && !exactMatch) {
    html += `<li class="sheet-item sheet-item--custom" data-value="${escapeHtml(query.trim())}">Tallenna: <strong>${escapeHtml(query.trim())}</strong></li>`;
  }

  if (recentFiltered.length > 0) {
    html += `<li class="combobox-group">Viimeisimmät</li>`;
    recentFiltered.forEach(t => {
      html += `<li class="sheet-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (allFiltered.length > 0) {
    html += `<li class="combobox-group">Kaikki lajit</li>`;
    allFiltered.forEach(t => {
      html += `<li class="sheet-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (!html) {
    html = `<li class="sheet-item" style="color:var(--text-soft);pointer-events:none">Ei tuloksia</li>`;
  }

  listEl.innerHTML = html;
}

function updateSheetForKeyboard() {
  const sheet = el('activity-sheet');
  if (!sheet || sheet.classList.contains('hidden')) return;
  const vv = window.visualViewport;
  if (!vv) return;
  // Push sheet up by exactly the keyboard height
  const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;
  sheet.style.bottom    = Math.max(0, keyboardHeight) + 'px';
  sheet.style.maxHeight = Math.round(vv.height * 0.88) + 'px';
}

function openActivitySheet() {
  const sheet  = el('activity-sheet');
  const search = el('sheet-search-input');

  search.value = el('entry-type').value || '';
  renderSheetList(search.value);

  el('activity-sheet-backdrop').classList.remove('hidden');
  sheet.classList.remove('hidden');
  sheet.style.bottom    = '';
  sheet.style.maxHeight = '';

  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('sheet-open')));

  // Track keyboard appearing / disappearing
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateSheetForKeyboard);
    window.visualViewport.addEventListener('scroll', updateSheetForKeyboard);
  }
  // Note: ei automaattista fokusta — estää iOS:n credential autofill -kehotteen
}

function closeActivitySheet() {
  const sheet = el('activity-sheet');
  sheet.classList.remove('sheet-open');
  sheet.style.bottom    = '';
  sheet.style.maxHeight = '';

  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', updateSheetForKeyboard);
    window.visualViewport.removeEventListener('scroll', updateSheetForKeyboard);
  }

  setTimeout(() => {
    sheet.classList.add('hidden');
    el('activity-sheet-backdrop').classList.add('hidden');
  }, 300);
}

function selectActivityItem(value) {
  el('entry-type').value = value;
  closeActivitySheet();
}

function initActivitySheet() {
  const search = el('sheet-search-input');

  search.addEventListener('input', () => renderSheetList(search.value));

  el('sheet-list').addEventListener('click', (e) => {
    const item = e.target.closest('.sheet-item');
    if (item?.dataset.value) selectActivityItem(item.dataset.value);
  });

  el('close-activity-sheet').addEventListener('click', closeActivitySheet);
  el('activity-sheet-backdrop').addEventListener('click', closeActivitySheet);
}

// ── Combobox init — picks desktop or mobile path ──────────────
function initTypeCombobox() {
  const input  = el('entry-type');
  const listEl = el('entry-type-list');

  if (isTouchDevice()) {
    // Mobile: input is display-only, tapping opens sheet
    input.setAttribute('readonly', '');
    input.setAttribute('inputmode', 'none');
    input.style.cursor = 'pointer';

    input.addEventListener('click', () => openActivitySheet());
    input.addEventListener('focus', () => input.blur());

    initActivitySheet();
    return;
  }

  // Desktop: full combobox
  input.addEventListener('focus', () => openCombobox());
  input.addEventListener('click', () => openCombobox());

  input.addEventListener('input', () => {
    renderComboboxList(input.value);
    listEl.classList.add('open');
  });

  input.addEventListener('keydown', (e) => {
    const items  = [...listEl.querySelectorAll('.combobox-item')];
    const active = listEl.querySelector('.combobox-item.highlighted');
    const idx    = items.indexOf(active);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[idx + 1] || items[0];
      items.forEach(i => i.classList.remove('highlighted'));
      next?.classList.add('highlighted');
      next?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[idx - 1] || items[items.length - 1];
      items.forEach(i => i.classList.remove('highlighted'));
      prev?.classList.add('highlighted');
      prev?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (active) { e.preventDefault(); input.value = active.dataset.value; closeCombobox(); }
    } else if (e.key === 'Escape') {
      closeCombobox();
    }
  });

  listEl.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combobox-item');
    if (item) { e.preventDefault(); input.value = item.dataset.value; closeCombobox(); }
  });

  document.addEventListener('click', (e) => {
    if (!el('entry-type-wrap').contains(e.target)) closeCombobox();
  });
}

// ============================================================
// TIME TOGGLE
// ============================================================
el('show-time').addEventListener('change', (e) => {
  el('entry-time').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked) el('entry-time').focus();
});

// ============================================================
// PERFORMANCE — Roman numeral buttons
// ============================================================
// Apply Polar zone color to a perf button when active
function applyPerfBtnColor(btn, zoneIndex, isActive) {
  const color       = PERF_COLORS[zoneIndex];
  const borderColor = PERF_COLORS_BORDER[zoneIndex];
  if (isActive) {
    btn.style.background  = color;
    btn.style.borderColor = color;
    btn.style.color       = 'white';
    btn.style.boxShadow   = `0 3px 10px ${color}66`;
  } else {
    btn.style.background  = '';
    btn.style.borderColor = color;
    btn.style.color       = color;
    btn.style.boxShadow   = '';
  }
}

function updateCommentCounter() {
  const textarea = el('entry-comment');
  const counter  = el('comment-char-count');
  const wrap     = counter?.closest('.char-counter');
  if (!textarea || !counter || !wrap) return;
  const len = textarea.value.length;
  counter.textContent = len;
  wrap.classList.toggle('near-limit', len >= 400 && len < 500);
  wrap.classList.toggle('at-limit',   len >= 500);
}

function setPerformance(value) {
  perfValue = value;
  const container = el('perf-stars');
  container.innerHTML = '';

  PERF_ROMAN.forEach((roman, i) => {
    const btn       = document.createElement('button');
    btn.type        = 'button';
    const isActive  = i + 1 === value;
    btn.className   = 'perf-btn' + (isActive ? ' active' : '');
    btn.textContent = roman;
    applyPerfBtnColor(btn, i, isActive);
    btn.addEventListener('click', () => setPerformance(i + 1));
    container.appendChild(btn);
  });

  el('perf-desc').textContent = value ? PERF_LABELS[value] : '';
}

// ============================================================
// EMOJI RATING (Feeling)
// ============================================================
function setFeeling(value) {
  feelValue = value;
  const container = el('feel-stars');
  container.innerHTML = '';

  FEEL_EMOJIS.slice(1).forEach((emoji, i) => {
    const btn     = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'feel-btn' + (i + 1 === value ? ' active' : '');
    btn.textContent = emoji;
    btn.title     = FEEL_LABELS[i + 1];
    btn.addEventListener('click', () => setFeeling(i + 1));
    container.appendChild(btn);
  });

  el('feel-desc').textContent = value ? FEEL_LABELS[value] : '';
}

// ============================================================
// SAVE (create / update)
// ============================================================
el('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const dateVal = el('entry-date').value;
  const timeVal = el('show-time').checked ? el('entry-time').value : '';

  if (!dateVal) { toast('Valitse päivämäärä.', 'error'); return; }

  // Prevent future dates (same day is OK regardless of time) — local time, not UTC
  const todayStr = timestampToDateStr(new Date());
  if (dateVal > todayStr) { toast('Et voi lisätä treeniä tulevaisuuteen.', 'error'); return; }

  const dateObj = timeVal
    ? new Date(`${dateVal}T${timeVal}`)
    : new Date(`${dateVal}T00:00:00`);

  const type = el('entry-type').value.trim();
  if (!type) { toast('Valitse tai kirjoita aktiviteetti.', 'error'); return; }

  const duration = parseInt(el('entry-duration').value, 10);
  if (!duration || duration < 1) { toast('Syötä keston kesto minuutteina.', 'error'); return; }

  const distRaw  = parseFloat(el('entry-distance').value.replace(',', '.'));
  const hrRaw    = parseInt(el('entry-heartrate').value, 10);
  const maxHrRaw = parseInt(el('entry-maxhr').value, 10);

  // Estä tuplatallennus — disabloi nappi heti kun validointi on mennyt läpi
  const saveBtn = el('entry-save-btn');
  if (saveBtn?.disabled) return; // jo käynnissä
  const _saveBtnText = saveBtn?.textContent || 'Tallenna';
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Tallennetaan…'; }

  const data = {
    date:        firebase.firestore.Timestamp.fromDate(dateObj),
    hasTime:     !!timeVal,
    type,
    duration,
    performance: perfValue,
    feeling:     feelValue,
    comment:        el('entry-comment').value.trim(),
    privateComment: el('entry-private-comment').checked,
    distance:    isNaN(distRaw)  ? null : distRaw,
    avgHr:       isNaN(hrRaw)    ? null : hrRaw,
    maxHr:       isNaN(maxHrRaw) ? null : maxHrRaw,
    updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    // Records-päivitys (vain jos käyttäjä on bootstrapattu)
    const recordsUpdate = recordsReady()
      ? await buildRecordsUpdate(
          currentEntryId ? 'edit' : 'add',
          originalEntryData, // null jos uusi
          data
        )
      : null;

    if (currentEntryId) {
      // EDIT: yritä batch jos records-päivitys mukana
      if (recordsUpdate && Object.keys(recordsUpdate).filter(k => !k.startsWith('_')).length) {
        const batch = db.batch();
        batch.update(getUserEntries().doc(currentEntryId), data);
        const cleanUpdates = Object.fromEntries(Object.entries(recordsUpdate).filter(([k]) => !k.startsWith('_')));
        batch.update(getUserDoc(), cleanUpdates);
        await batch.commit();
      } else {
        await getUserEntries().doc(currentEntryId).update(data);
      }
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      if (recordsUpdate && Object.keys(recordsUpdate).filter(k => !k.startsWith('_')).length) {
        const batch = db.batch();
        const newRef = getUserEntries().doc();
        batch.set(newRef, data);
        const cleanUpdates = Object.fromEntries(Object.entries(recordsUpdate).filter(([k]) => !k.startsWith('_')));
        batch.update(getUserDoc(), cleanUpdates);
        await batch.commit();
      } else {
        await getUserEntries().add(data);
      }
    }

    // Synkkaa profile-cache (records muuttui paikallisesti)
    if (recordsUpdate) syncRecordsCache();

    // Invalidate caches and re-fetch
    Cache.set(viewUid(), 'entries_' + pageWindowStart.getTime(), null);
    Cache.set(viewUid(), 'hasMore_' + pageWindowStart.getTime(), null); // pakota uudelleentarkistus
    invalidateChartCache();
    invalidateCalendarCache();
    // Vain ei-bootstrappatuille tarvitsee invalidoida ennätys-HTML-cache
    if (!recordsReady()) invalidateEnnatykset();
    else ennatyksetLoaded = false; // pakota re-render fast-pathilla
    closeModal();
    haptic('success');
    if (!navigator.onLine && !currentEntryId) {
      const cur = parseInt(localStorage.getItem('uppis_pending_count') || '0', 10);
      localStorage.setItem('uppis_pending_count', String(cur + 1));
      toast('📵 Treenikirjaus tallennettu jonoon', 'success');
    } else {
      toast(currentEntryId ? 'Treeni päivitetty.' : 'Treeni tallennettu!', 'success');
    }
    fetchEntries();
  } catch (err) {
    console.error(err);
    haptic('error');
    toast('Tallennus epäonnistui. Yritä uudelleen.', 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = _saveBtnText; }
  }
});

// ============================================================
// DELETE
// ============================================================
el('delete-entry-btn').addEventListener('click', async () => {
  const yes = await confirm('Poistetaanko tämä harjoitus? Toimintoa ei voi peruuttaa.');
  if (!yes) return;
  // Estä tuplaklikkaus poistossa
  const delBtn = el('delete-entry-btn');
  if (delBtn?.disabled) return;
  if (delBtn) { delBtn.disabled = true; delBtn.textContent = 'Poistetaan…'; }
  try {
    const recordsUpdate = recordsReady() && originalEntryData
      ? await buildRecordsUpdate('remove', originalEntryData, null)
      : null;

    if (recordsUpdate && Object.keys(recordsUpdate).filter(k => !k.startsWith('_')).length) {
      const batch = db.batch();
      batch.delete(getUserEntries().doc(currentEntryId));
      const cleanUpdates = Object.fromEntries(Object.entries(recordsUpdate).filter(([k]) => !k.startsWith('_')));
      batch.update(getUserDoc(), cleanUpdates);
      await batch.commit();
    } else {
      await getUserEntries().doc(currentEntryId).delete();
    }

    // Jos pisin tai ensimmäinen entry poistettiin → rescan (1-2 readia, harvinainen)
    if (recordsUpdate && (recordsUpdate._needsLongestRescan || recordsUpdate._needsFirstRescan)) {
      try { await rescanLongestAndFirst(); } catch (e) { console.warn('rescan failed:', e); }
    }
    if (recordsUpdate) syncRecordsCache();

    Cache.set(viewUid(), 'entries_' + pageWindowStart.getTime(), null);
    Cache.set(viewUid(), 'hasMore_' + pageWindowStart.getTime(), null); // pakota uudelleentarkistus
    invalidateChartCache();
    invalidateCalendarCache();
    if (!recordsReady()) invalidateEnnatykset();
    else ennatyksetLoaded = false;
    haptic('medium');
    closeModal();
    fetchEntries();
  } catch (err) {
    console.error(err);
    haptic('error');
    toast('Poisto epäonnistui.', 'error');
  } finally {
    if (delBtn) { delBtn.disabled = false; delBtn.textContent = 'Poista'; }
  }
});

// ============================================================
// OPEN EXISTING ENTRY FOR EDITING
// ============================================================
async function openEntry(entryId) {
  // Serve from in-memory cache (zero reads)
  const cached = allEntries.find(e => e.id === entryId);
  if (cached) { openModal(entryId, cached); return; }
  // Fallback: fetch from Firestore (entry not in current window)
  try {
    const doc = await getUserEntries().doc(entryId).get();
    if (doc.exists) openModal(entryId, doc.data());
  } catch (err) {
    console.error(err);
  }
}

el('load-more-btn').addEventListener('click', loadOlderPage);

// ============================================================
// INIT CALLS
// ============================================================
setPerformance(0);
setFeeling(0);
initTypeCombobox();
