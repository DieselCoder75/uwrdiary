// ============================================================
// KALENTERI — kuukausinäkymä harjoituksista + viikkosuunnitelma
// ============================================================

// Viikkosuunnitelma 2026 (ISO viikkonumero → suunniteltu tehoalue)
const WEEKLY_PLAN = {
  2026: {
     1: 'I–II',   2: 'I–II',   3: 'III–IV', 4: 'IV',    5: 'I–II',
     6: 'IV',     7: 'I–II',   8: 'IV',     9: 'V',     10: 'I–II',
    11: 'II',    12: 'III',   13: 'I–II',  14: 'III',
    15: 'IV',    16: 'I–II',  17: 'III',   18: 'IV',
    19: 'I–II',  20: 'IV',    21: 'V',     22: 'I–II',
    23: 'III',   24: 'IV',    25: 'I–II',  26: 'I–II',
    27: 'III',   28: 'I–II',
  }
};

const CAL_ROMAN      = ['', 'I', 'II', 'III', 'IV', 'V'];
const CAL_DAY_NAMES  = ['Ma', 'Ti', 'Ke', 'To', 'Pe', 'La', 'Su'];
const CAL_MONTH_NAMES = [
  'Tammikuu','Helmikuu','Maaliskuu','Huhtikuu','Toukokuu','Kesäkuu',
  'Heinäkuu','Elokuu','Syyskuu','Lokakuu','Marraskuu','Joulukuu'
];

// Tila
let calOldestYear  = null;
let calOldestMonth = null;
let calLoadingMore = false;
let calAllLoaded   = false;
let calLoadedForUid = null; // uid jolle kalenteri on ladattu; null = ei ladattu

// "YYYY-MM-DD" → [{type, duration, performance}] (kaikki päivän treenit)
let calEntriesMap = {};

// ─── Maajoukkueen tapahtumat ──────────────────────────────────
const TEAM_EVENTS = [
  { start: '2026-01-24', end: '2026-01-25', label: 'Leiri – Seinäjoki',   dates: '24.–25.1.2026'  },
  { start: '2026-02-08', end: '2026-02-08', label: 'Leiri – Seinäjoki',   dates: '8.2.2026'        },
  { start: '2026-02-28', end: '2026-03-01', label: 'PM-Kisat – Tukholma 🥉', dates: '28.2.–1.3.2026', link: 'https://www.uppopallo.fi/uutiset/suomen-naisille-pronssia-uppopallon/' },
  { start: '2026-05-02', end: '2026-05-03', label: 'Leiri – Turku',          dates: '2.–3.5.2026',   link: 'https://www.uppopallo.fi/uutiset/naisten-avoin-maajoukkueleiri-turus-4/' },
  { start: '2026-05-16', end: '2026-05-16', label: 'Varainkeruu – Helsinki', dates: '16.5.2026', note: 'Helsinki City Run' },
  { start: '2026-06-13', end: '2026-06-14', label: 'Leiri – Leppävaara',  dates: '13.–14.6.2026', link: 'https://www.uppopallo.fi/uutiset/naisten-avoin-maajoukkueleiri-leppa-2/' },
  { start: '2026-08-15', end: '2026-08-16', label: 'Leiri – Kumpula',    dates: '15.–16.8.2026', link: 'https://www.uppopallo.fi/uutiset/naisten-avoin-maajoukkueleiri-kumpu/' },
  { start: '2026-09-05', end: '2026-09-06', label: 'Leiri – Seinäjoki',  dates: '5.–6.9.2026'    },
  { start: '2026-10-03', end: '2026-10-04', label: 'Leiri – Kokkola',     dates: '3.–4.10.2026'   },
  { start: '2027-01-23', end: '2027-01-24', label: 'SWE-FIN Camp III – Turku', dates: '23.–24.1.2027' },
  { start: '2027-05-15', end: '2027-05-22', label: 'MM-Kisat – Torremolinos', dates: '15.–22.5.2027', highlight: true },
  { start: '2025-11-09', end: '2025-11-15', label: 'EM-Kisat – Ateena 🥉', dates: '9.–15.11.2025', link: 'https://www.uppopallo.fi/uutiset/suomen-naiset-voitti-em-pronssia/' },
];

function buildTeamEventsMap() {
  const map = {};
  for (const ev of TEAM_EVENTS) {
    const [sy, sm, sd] = ev.start.split('-').map(Number);
    const [ey, em, ed] = ev.end.split('-').map(Number);
    for (let d = new Date(sy, sm - 1, sd), end = new Date(ey, em - 1, ed); d <= end; d.setDate(d.getDate() + 1)) {
      const key = calDateKey(new Date(d));
      map[key] = { ev, isFirst: key === ev.start, isLast: key === ev.end };
    }
  }
  return map;
}

// ─── Kalenterin localStorage-cache ───────────────────────────
const CAL_CACHE_TTL_CURRENT  = 4 * 60 * 60 * 1000;  // 4 h kuluva + edellinen kk
const CAL_CACHE_TTL_HISTORY  = 7 * 24 * 60 * 60 * 1000; // 7 pv historialle

function calMonthLsKey(uid, year, month) {
  return `uppis_cal2_${uid}_${year}_${month}`; // v2 = tallentaa koko entry-datan
}

function calMonthCacheTtl(year, month) {
  const now = new Date();
  const diffMonths = (now.getFullYear() - year) * 12 + (now.getMonth() - month);
  return diffMonths <= 1 ? CAL_CACHE_TTL_CURRENT : CAL_CACHE_TTL_HISTORY;
}

// Tallentaa kuukauden päivät calEntriesMap:stä localStorageen
function calSaveMonthCache(uid, year, month) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const slice  = {};
  Object.keys(calEntriesMap).forEach(k => { if (k.startsWith(prefix)) slice[k] = calEntriesMap[k]; });
  try {
    localStorage.setItem(calMonthLsKey(uid, year, month), JSON.stringify({ ts: Date.now(), data: slice }));
  } catch {}
}

// Tyhjentää kalenteri-LS-cachez nykyiselle + edelliselle kuukaudelle
function invalidateCalendarCache() {
  calLoadedForUid = null;
  if (!currentUser) return;
  const now  = new Date();
  const keys = [
    calMonthLsKey(currentUser.uid, now.getFullYear(), now.getMonth()),
    calMonthLsKey(currentUser.uid,
      now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear(),
      now.getMonth() === 0 ? 11 : now.getMonth() - 1),
  ];
  keys.forEach(k => { try { localStorage.removeItem(k); } catch {} });
}

// ─── ISO-viikkoapu ────────────────────────────────────────────
function calIsoWeekData(date) {
  const d   = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return {
    week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7),
    year: d.getUTCFullYear()
  };
}

// "YYYY-WNN" -avain viikon maanantaista
function calWeekKey(monday) {
  const { week, year } = calIsoWeekData(monday);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function calPlannedZone(monday) {
  const key = calWeekKey(monday);
  // Firestore-suunnitelma ohittaa kovakoodatun ('' = tyhjennetty)
  if (key in dynamicWeekPlan) return dynamicWeekPlan[key] || null;
  const { week, year } = calIsoWeekData(monday);
  return WEEKLY_PLAN[year]?.[week] || null;
}

function calDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ─── Tehoalueen arviointi ─────────────────────────────────────
// Parsii suunnitelman tehoalue-merkkijonon numeroiksi
// "III–IV" → [3, 4]  |  "I–II" → [1, 2]  |  "IV" → [4]
function parseZoneStr(zoneStr) {
  const map = { 'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5 };
  return zoneStr.split(/[–-]/).map(s => map[s.trim()]).filter(Boolean);
}

// Palauttaa 'ok', 'fail' tai null (ei arvioida)
function evaluateWeek(monday, weekPerfs, pZoneStr) {
  if (!pZoneStr) return null;

  // Arvioidaan vain viikot jotka ovat kokonaan menneet (sunnuntai < tänään)
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  sunday.setHours(0, 0, 0, 0);
  if (sunday >= todayMidnight) return null;

  // Arvioidaan vain viikot joilla on kirjattuja treenejä
  if (weekPerfs.length === 0) return null;

  const targetZones = parseZoneStr(pZoneStr);
  const isIOnly     = targetZones.length === 1 && targetZones[0] === 1;

  if (isIOnly) {
    // Sääntö B: I-viikolla max 2 III tai IV treeniä
    const hardCount = weekPerfs.filter(p => p === 3 || p === 4).length;
    return hardCount <= 2 ? 'ok' : 'fail';
  } else {
    // Sääntö A: vähintään 2 treeniä suunnitelluilla tehoalueilla
    const hitCount = weekPerfs.filter(p => targetZones.includes(p)).length;
    return hitCount >= 2 ? 'ok' : 'fail';
  }
}

// ─── Alustus + ensimmäinen renderi ────────────────────────────
async function renderCalendarTab() {
  if (!currentUser) return;

  // Älä lataa uudelleen jos sama käyttäjä on jo ladattu
  const viewUid = impersonating ? impersonating.uid : currentUser.uid;
  if (calLoadedForUid === viewUid) return;
  calLoadedForUid = viewUid;

  const now = new Date();
  calOldestYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  calOldestMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  calLoadingMore = false;
  calAllLoaded   = false;
  calEntriesMap  = {};

  const container = el('calendar-container');
  container.innerHTML = '<div class="cal-loading">Ladataan…</div>';
  initCalTooltip();

  await Promise.all([
    loadCalendarMonth(now.getFullYear(), now.getMonth()),
    loadCalendarMonth(calOldestYear, calOldestMonth),
  ]);

  const today   = now;
  const viewTeams = impersonating ? (impersonating.teams || []) : (userProfile.teams || []);
  const showPlan = viewTeams.includes('Naisten Maajoukkue');
  container.innerHTML =
    buildMonthHTML(now.getFullYear(), now.getMonth(), today, showPlan) +
    buildMonthHTML(calOldestYear, calOldestMonth, today, showPlan) +
    '<div id="cal-more-indicator" class="cal-more-indicator"></div>';
}

// ─── Lataa yksi kuukausi (LS-cache → Firestore) ───────────────
async function loadCalendarMonth(year, month) {
  const uid    = impersonating ? impersonating.uid : (currentUser?.uid || '');
  const lsKey  = calMonthLsKey(uid, year, month);
  const ttl    = calMonthCacheTtl(year, month);

  // Kokeile localStorage ensin
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < ttl) {
        Object.assign(calEntriesMap, parsed.data);
        return;
      }
    }
  } catch {}

  // Hae Firestoresta
  const start = new Date(year, month, 1);
  const end   = new Date(year, month + 1, 1);
  try {
    const snap = await getViewDoc()
      .collection('entries')
      .where('date', '>=', firebase.firestore.Timestamp.fromDate(start))
      .where('date', '<',  firebase.firestore.Timestamp.fromDate(end))
      .get();

    snap.forEach(doc => {
      const d  = doc.data();
      const ts = d.date?.toDate ? d.date.toDate() : null;
      if (!ts || !d.performance) return;
      const key = calDateKey(ts);
      if (!calEntriesMap[key]) calEntriesMap[key] = [];
      calEntriesMap[key].push({
        type:        d.type        || '',
        duration:    d.duration    || null,
        performance: d.performance,
      });
    });

    calSaveMonthCache(uid, year, month);
  } catch (err) {
    console.error('loadCalendarMonth:', err);
  }
}

// ─── Infinite scroll: lisää yksi kuukausi pohjalle ────────────
async function appendCalendarMonth() {
  if (calLoadingMore || calAllLoaded) return;
  calLoadingMore = true;

  const indicator = el('cal-more-indicator');
  if (indicator) indicator.textContent = 'Ladataan…';

  let m = calOldestMonth - 1;
  let y = calOldestYear;
  if (m < 0) { m = 11; y--; }

  const now = new Date();
  if (now.getFullYear() - y > 2) {
    calAllLoaded = true;
    if (indicator) indicator.remove();
    calLoadingMore = false;
    return;
  }

  calOldestMonth = m;
  calOldestYear  = y;

  await loadCalendarMonth(y, m);

  const today    = new Date();
  const viewTeams = impersonating ? (impersonating.teams || []) : (userProfile.teams || []);
  const showPlan  = viewTeams.includes('Naisten Maajoukkue');
  const monthDiv  = document.createElement('div');
  monthDiv.innerHTML = buildMonthHTML(y, m, today, showPlan);

  if (indicator) {
    indicator.before(monthDiv.firstElementChild);
    indicator.textContent = '';
  } else {
    el('calendar-container').insertAdjacentHTML('beforeend', buildMonthHTML(y, m, today, showPlan));
  }

  calLoadingMore = false;
}

// ─── Rakenna yhden kuukauden HTML ─────────────────────────────
function buildMonthHTML(year, month, today, showPlan = false) {
  const mjEventsMap = buildTeamEventsMap();
  const firstDow    = new Date(year, month, 1).getDay();
  const startOffset = (firstDow + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Tuorein viikko ylös
  const weekStarts = [];
  let day = 1 - startOffset;
  while (day <= daysInMonth) { weekStarts.push(day); day += 7; }
  weekStarts.reverse();

  let html = `
    <div class="cal-month">
      <h3 class="cal-month-header">${CAL_MONTH_NAMES[month]} ${year}</h3>
      <div class="cal-grid">
        <div class="cal-cell cal-hdr cal-wk-hdr">vk</div>
        ${CAL_DAY_NAMES.map((n, i) =>
          `<div class="cal-cell cal-hdr${i === 6 ? ' cal-sun-hdr' : ''}">${n}</div>`
        ).join('')}
  `;

  for (const day of weekStarts) {
    const monday   = new Date(year, month, day);
    const { week } = calIsoWeekData(monday);
    const pZone    = calPlannedZone(monday);

    // Kerää viikon kaikkien treenien tehoalueet (performance-numerot)
    const weekPerfs = [];
    for (let dow = 0; dow < 7; dow++) {
      const dayEntries = calEntriesMap[calDateKey(new Date(year, month, day + dow))];
      if (dayEntries) dayEntries.forEach(e => { if (e.performance) weekPerfs.push(e.performance); });
    }

    const result = evaluateWeek(monday, weekPerfs, pZone);

    const wkCls = showPlan && result === 'ok'   ? ' cal-wk-ok'
                : showPlan && result === 'fail' ? ' cal-wk-fail' : '';
    html += `
      <div class="cal-cell cal-wk-cell${wkCls}">
        <span class="cal-wk-num">${week}</span>
        ${showPlan && pZone   ? `<span class="cal-wk-plan">${pZone}</span>` : ''}
        ${showPlan && result === 'ok'   ? '<span class="cal-wk-check">✓</span>' : ''}
        ${showPlan && result === 'fail' ? '<span class="cal-wk-cross">✗</span>'  : ''}
      </div>
    `;

    for (let dow = 0; dow < 7; dow++) {
      const cellDate = new Date(year, month, day + dow);
      const inMonth  = cellDate.getMonth() === month && cellDate.getFullYear() === year;
      const isToday  = inMonth &&
        cellDate.getDate()     === today.getDate()     &&
        cellDate.getMonth()    === today.getMonth()    &&
        cellDate.getFullYear() === today.getFullYear();
      const isSun = dow === 6;

      let inner   = '';
      let cls     = 'cal-cell cal-day-cell';
      let style   = '';
      let tipAttr = '';

      if (!inMonth) {
        cls += ' cal-out';
      } else {
        const entries = calEntriesMap[calDateKey(cellDate)] || null;
        const maxPerf = entries ? Math.max(...entries.map(e => e.performance)) : null;
        const bgColor = maxPerf ? PERF_COLORS[maxPerf - 1] : null;
        const evInfo  = mjEventsMap[calDateKey(cellDate)] || null;

        // Tooltip-data päivästä
        const tipData = [];
        if (entries?.length || evInfo) {
          const dateLabel = cellDate.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
          tipData.push({ _date: true, label: dateLabel });
        }
        if (entries?.length) {
          entries.forEach(e => tipData.push({ type: e.type, duration: e.duration, perf: e.performance }));
        }
        if (evInfo) tipData.push({ _event: true, label: evInfo.ev.label, dates: evInfo.ev.dates });
        tipAttr = tipData.length
          ? ` data-cal-tip='${JSON.stringify(tipData).replace(/'/g, '&#39;')}'` : '';

        if (bgColor) {
          style  = ` style="background:${bgColor}"`;
          cls   += ' cal-day-workout';
          if (isToday) cls += ' cal-today-workout';
        } else if (isToday) {
          cls += ' cal-today';
        }
        if (evInfo) cls += ' cal-mj-event';

        inner = `
          <span class="cal-day-num${isSun && !bgColor ? ' cal-sun' : ''}">${cellDate.getDate()}</span>
          ${maxPerf ? `<span class="cal-perf">${CAL_ROMAN[maxPerf]}</span>` : ''}
        `;
      }

      html += `<div class="${cls}"${style}${tipAttr}>${inner}</div>`;
    }
  }

  html += `</div></div>`;
  return html;
}

// ─── Kalenterin tooltip ───────────────────────────────────────
let calTooltipInited = false;

function initCalTooltip() {
  if (calTooltipInited) return;
  calTooltipInited = true;

  el('calendar-container').addEventListener('click', e => {
    const cell = e.target.closest('[data-cal-tip]');
    if (cell) { showCalTooltip(cell); }
    else      { hideCalTooltip(); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#calendar-container') && !e.target.closest('#cal-tooltip')) {
      hideCalTooltip();
    }
  });
}

function showCalTooltip(cell) {
  const tt = el('cal-tooltip');
  if (!tt) return;
  const data = JSON.parse(cell.dataset.calTip || '[]');
  let html = '';
  for (const item of data) {
    if (item._date) {
      html += `<div class="cal-tip-date">${item.label}</div>`;
    } else if (item._event) {
      html += `<div class="cal-tip-event">${item.label}<br><span class="cal-tip-dates">${item.dates}</span></div>`;
    } else {
      const parts = [];
      if (item.type)     parts.push(item.type);
      if (item.perf)     parts.push(CAL_ROMAN[item.perf]);
      if (item.duration) parts.push(`${item.duration} min`);
      html += `<div class="cal-tip-entry">${parts.join(' · ')}</div>`;
    }
  }
  el('cal-tooltip-content').innerHTML = html;
  const rect = cell.getBoundingClientRect();
  const ttW  = 180;
  let   left = rect.left + rect.width / 2 - ttW / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - ttW - 8));
  tt.style.left = left + 'px';
  tt.style.top  = (rect.bottom + 6) + 'px';
  tt.classList.remove('hidden');
}

function hideCalTooltip() {
  const tt = el('cal-tooltip');
  if (tt) tt.classList.add('hidden');
}

// ─── Tapahtumat-välilehti ─────────────────────────────────────
function renderTapahtumatTab() {
  const container = el('tapahtumat-content');
  if (!container) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const upcoming = [];
  const past     = [];

  for (const ev of TEAM_EVENTS) {
    const [ey, em, ed] = ev.end.split('-').map(Number);
    const endDate = new Date(ey, em - 1, ed);
    (endDate >= today ? upcoming : past).push(ev);
  }

  // Tulevat: kaukaisin ensin
  upcoming.sort((a, b) => b.start.localeCompare(a.start));
  // Menneet: viimeisin ensin
  past.sort((a, b) => b.start.localeCompare(a.start));

  function evRow(ev) {
    const [tapahtuma, paikka] = ev.label.split(' – ');
    const nameHtml = paikka
      ? `${tapahtuma} <span class="tapahtumat-place">· ${paikka}</span>`
      : (tapahtuma || ev.label);
    const noteHtml = ev.note ? `<span class="tapahtumat-note">${ev.note}</span>` : '';
    const linkHtml = ev.link ? `<a class="tapahtumat-link" href="${ev.link}" target="_blank" rel="noopener">Lue lisää →</a>` : '';
    return `
      <div class="tapahtumat-row">
        <span class="tapahtumat-date">${ev.dates}</span>
        <span class="tapahtumat-name">${nameHtml}${noteHtml}${linkHtml}</span>
      </div>`;
  }

  // Laskuri: seuraava highlight-tapahtuma joka on vielä tuleva
  const highlighted = upcoming.find(ev => ev.highlight);
  let countdownHtml = '';
  if (highlighted) {
    const [hy, hm, hd] = highlighted.start.split('-').map(Number);
    const targetDate = new Date(hy, hm - 1, hd);
    targetDate.setHours(0, 0, 0, 0);
    const diffMs   = targetDate - today;
    const diffDays = Math.ceil(diffMs / 86400000);
    const [tapahtuma, paikka] = highlighted.label.split(' – ');
    countdownHtml = `
      <div class="tapahtumat-countdown">
        <div class="tapahtumat-countdown-days">${diffDays}</div>
        <div class="tapahtumat-countdown-text">
          <div class="tapahtumat-countdown-label">päivää · ${tapahtuma}</div>
          <div class="tapahtumat-countdown-sub">${paikka} · ${highlighted.dates}</div>
        </div>
      </div>`;
  }

  let html = '';
  if (countdownHtml) html += countdownHtml;
  if (upcoming.length) {
    html += `<div class="tapahtumat-section">
      <h3 class="tapahtumat-hdr">Tulevat</h3>
      ${upcoming.map(evRow).join('')}
    </div>`;
  }
  if (upcoming.length && past.length) {
    const todayLabel = today.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
    html += `<div class="tapahtumat-today-divider">
      <span class="tapahtumat-today-label">TÄNÄÄN – ${todayLabel}</span>
    </div>`;
  }
  if (past.length) {
    html += `<div class="tapahtumat-section tapahtumat-section-past">
      <h3 class="tapahtumat-hdr">Menneet</h3>
      ${past.map(evRow).join('')}
    </div>`;
  }
  if (!upcoming.length && !past.length) {
    html = `<p class="tapahtumat-empty">Ei tapahtumia.</p>`;
  }

  container.innerHTML = html;
}

window.renderTapahtumatTab    = renderTapahtumatTab;
window.invalidateCalendarCache = invalidateCalendarCache;
