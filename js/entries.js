// ============================================================
// ENTRIES — PAGINATED REAL-TIME LIST
// ============================================================

function getUserEntries() {
  return db.collection('users').doc(currentUser.uid).collection('entries');
}

function getUserDoc() {
  return db.collection('users').doc(currentUser.uid);
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
    comment:     d.comment     || '',
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

function loadEntries() {
  pageWindowStart = weeksAgoMonday(PAGE_WEEKS);
  olderDocs       = [];
  hasMorePages    = true;

  hide('load-more-wrap');
  hide('no-more-entries');
  el('period-label').textContent = '';

  if (unsubEntries) { unsubEntries(); unsubEntries = null; }

  const cacheKey   = 'entries_' + pageWindowStart.getTime();
  const cachedDocs = Cache.get(currentUser.uid, cacheKey);

  // ── Serve from cache instantly (zero reads) ─────────────────
  if (cachedDocs && cachedDocs.length > 0) {
    const fakeDocs = cachedDocs.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
    allEntries = cachedDocs.map(raw => ({ id: raw.id, ...deserialiseEntry(raw) }));
    refreshActiveChart();
    renderPage(fakeDocs, olderDocs);
    const cachedHasMore = Cache.get(currentUser.uid, 'hasMore_' + pageWindowStart.getTime());
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

    const snap       = await getUserEntries().orderBy('date', 'desc').where('date', '>=', windowStart).get();
    const serialised = snap.docs.map(serialiseEntry);
    const cached     = Cache.get(currentUser.uid, cacheKey) || [];

    if (Cache.fingerprint(serialised) !== Cache.fingerprint(cached)) {
      Cache.set(currentUser.uid, cacheKey, serialised);
      allEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      refreshActiveChart();
      renderPage(snap.docs, olderDocs);
    }

    // "Has more" check — only if not cached
    if (Cache.get(currentUser.uid, 'hasMore_' + pageWindowStart.getTime()) === null) {
      const check = await getUserEntries().where('date', '<', windowStart).limit(1).get();
      hasMorePages = !check.empty;
      Cache.set(currentUser.uid, 'hasMore_' + pageWindowStart.getTime(), hasMorePages);
      if (hasMorePages) show('load-more-wrap'); else hide('load-more-wrap');
    }
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
  const lsKey    = 'uppis_ch_' + currentUser.uid;

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
  try { localStorage.removeItem('uppis_ch_' + currentUser.uid); } catch {}
  allChartEntries = [];
}

async function loadOlderPage() {
  const btn = el('load-more-btn');
  btn.disabled = true;
  btn.textContent = 'Ladataan…';

  const newWindowStart = new Date(pageWindowStart);
  newWindowStart.setDate(newWindowStart.getDate() - PAGE_WEEKS * 7);

  const from     = firebase.firestore.Timestamp.fromDate(newWindowStart);
  const to       = firebase.firestore.Timestamp.fromDate(pageWindowStart);
  const cacheKey = 'entries_older_' + newWindowStart.getTime();

  try {
    // Check cache for this older window first
    const cachedOlder = Cache.get(currentUser.uid, cacheKey);
    let olderRaw;

    if (cachedOlder) {
      olderRaw = cachedOlder;
    } else {
      const snap = await getUserEntries()
        .orderBy('date', 'desc')
        .where('date', '>=', from)
        .where('date', '<',  to)
        .get();
      olderRaw = snap.docs.map(serialiseEntry);
      Cache.set(currentUser.uid, cacheKey, olderRaw);
    }

    if (olderRaw.length === 0) {
      hasMorePages = false;
      hide('load-more-wrap');
      show('no-more-entries');
    } else {
      const fakeDocs = olderRaw.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
      olderDocs = [...olderDocs, ...fakeDocs];
      pageWindowStart = newWindowStart;

      // Check for even older entries
      const oldest     = firebase.firestore.Timestamp.fromDate(newWindowStart);
      const checkSnap  = await getUserEntries().where('date', '<', oldest).limit(1).get();
      hasMorePages     = !checkSnap.empty;
      Cache.set(currentUser.uid, 'hasMore_' + newWindowStart.getTime(), hasMorePages);

      // Get live window docs from cache (already in memory via onSnapshot)
      const liveKey    = 'entries_' + weeksAgoMonday(PAGE_WEEKS).getTime();
      const liveRaw    = Cache.get(currentUser.uid, liveKey) || [];
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
  btn.textContent = 'Lataa aiemmat 4 viikkoa';
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

function renderPage(liveDocs, extraDocs) {
  const list  = el('entries-list');
  const empty = el('empty-state');
  const allDocs = sortEntries([...liveDocs, ...extraDocs]);

  if (allDocs.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    hide('load-more-wrap');
    el('period-label').textContent = '';
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = allDocs.map(entryCardHtml).join('');
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
el('add-btn').addEventListener('click', () => openModal());
el('close-modal').addEventListener('click', closeModal);
el('entry-modal').querySelector('.modal-backdrop').addEventListener('click', closeModal);
el('entry-comment').addEventListener('input', updateCommentCounter);

function openModal(entryId = null, data = null) {
  currentEntryId = entryId;
  el('modal-title').textContent = entryId ? 'Muokkaa treeniä' : 'Uusi Treeni';
  el('delete-entry-btn').classList.toggle('hidden', !entryId);

  // Date — cap at today so future dates cannot be selected
  const today = new Date().toISOString().split('T')[0];
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
  el('entry-comment').value   = data?.comment  || '';
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

function initTypeCombobox() {
  const input  = el('entry-type');
  const listEl = el('entry-type-list');

  input.addEventListener('focus', () => openCombobox());
  input.addEventListener('click', () => openCombobox());

  input.addEventListener('input', () => {
    renderComboboxList(input.value);
    listEl.classList.add('open');
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = [...listEl.querySelectorAll('.combobox-item')];
    const active = listEl.querySelector('.combobox-item.highlighted');
    const idx = items.indexOf(active);

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

  // Click on list item
  listEl.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combobox-item');
    if (item) { e.preventDefault(); input.value = item.dataset.value; closeCombobox(); }
  });

  // Touch support
  listEl.addEventListener('touchend', (e) => {
    const item = e.target.closest('.combobox-item');
    if (item) { e.preventDefault(); input.value = item.dataset.value; closeCombobox(); }
  });

  // Close on outside click
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
  const color = PERF_COLORS[zoneIndex];
  if (isActive) {
    btn.style.background   = color;
    btn.style.borderColor  = color;
    btn.style.color        = 'white';
    btn.style.boxShadow    = `0 3px 10px ${color}66`;
  } else {
    btn.style.background   = '';
    btn.style.borderColor  = '';
    btn.style.color        = '';
    btn.style.boxShadow    = '';
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

  // Prevent future dates (same day is OK regardless of time)
  const todayStr = new Date().toISOString().split('T')[0];
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

  const data = {
    date:        firebase.firestore.Timestamp.fromDate(dateObj),
    hasTime:     !!timeVal,
    type,
    duration,
    performance: perfValue,
    feeling:     feelValue,
    comment:     el('entry-comment').value.trim(),
    distance:    isNaN(distRaw)  ? null : distRaw,
    avgHr:       isNaN(hrRaw)    ? null : hrRaw,
    maxHr:       isNaN(maxHrRaw) ? null : maxHrRaw,
    updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    if (currentEntryId) {
      await getUserEntries().doc(currentEntryId).update(data);
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await getUserEntries().add(data);
    }
    // Invalidate caches and re-fetch
    Cache.set(currentUser.uid, 'entries_' + pageWindowStart.getTime(), null);
    invalidateChartCache();
    closeModal();
    fetchEntries();
  } catch (err) {
    console.error(err);
    toast('Tallennus epäonnistui. Yritä uudelleen.', 'error');
  }
});

// ============================================================
// DELETE
// ============================================================
el('delete-entry-btn').addEventListener('click', async () => {
  const yes = await confirm('Poistetaanko tämä harjoitus? Toimintoa ei voi peruuttaa.');
  if (!yes) return;
  try {
    await getUserEntries().doc(currentEntryId).delete();
    Cache.set(currentUser.uid, 'entries_' + pageWindowStart.getTime(), null);
    invalidateChartCache();
    closeModal();
    fetchEntries();
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui.', 'error');
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
