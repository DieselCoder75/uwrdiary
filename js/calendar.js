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

// "YYYY-MM-DD" → päivän korkein tehoalue (1-5)
let calEntriesMap = {};

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

// ─── Lataa yksi kuukausi Firestoresta ─────────────────────────
async function loadCalendarMonth(year, month) {
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
      if (!calEntriesMap[key] || d.performance > calEntriesMap[key]) {
        calEntriesMap[key] = d.performance;
      }
    });
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

    // Kerää viikon päiväkohtaiset maksimitehoalueet (yksi per päivä)
    const weekPerfs = [];
    for (let dow = 0; dow < 7; dow++) {
      const perf = calEntriesMap[calDateKey(new Date(year, month, day + dow))];
      if (perf) weekPerfs.push(perf);
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

      let inner = '';
      let cls   = 'cal-cell cal-day-cell';
      let style = '';

      if (!inMonth) {
        cls += ' cal-out';
      } else {
        const maxPerf = calEntriesMap[calDateKey(cellDate)] || null;
        const bgColor = maxPerf ? PERF_COLORS[maxPerf - 1] : null;

        if (bgColor) {
          style  = ` style="background:${bgColor}"`;
          cls   += ' cal-day-workout';
          if (isToday) cls += ' cal-today-workout';
        } else if (isToday) {
          cls += ' cal-today';
        }

        inner = `
          <span class="cal-day-num${isSun && !bgColor ? ' cal-sun' : ''}">${cellDate.getDate()}</span>
          ${maxPerf ? `<span class="cal-perf">${CAL_ROMAN[maxPerf]}</span>` : ''}
        `;
      }

      html += `<div class="${cls}"${style}>${inner}</div>`;
    }
  }

  html += `</div></div>`;
  return html;
}
