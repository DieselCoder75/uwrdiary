// ============================================================
// CHART HELPERS
// ============================================================
function destroyChart(id) {
  if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
}

function getMondayOfWeek(d) {
  const date = new Date(d);
  const day  = date.getDay();
  date.setDate(date.getDate() - day + (day === 0 ? -6 : 1));
  date.setHours(0, 0, 0, 0);
  return date;
}

function getMonthStart(d) {
  const date = new Date(d); date.setDate(1); date.setHours(0, 0, 0, 0); return date;
}

function getLastNWeeks(n) {
  const monday = getMondayOfWeek(new Date());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(monday); d.setDate(d.getDate() - (n - 1 - i) * 7); return d;
  });
}

function getLastNMonths(n) {
  const thisMonth = getMonthStart(new Date());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(thisMonth); d.setMonth(d.getMonth() - (n - 1 - i)); return d;
  });
}

function groupByWeek(entries) {
  const map = {};
  entries.forEach(e => {
    const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
    const key = getMondayOfWeek(d).getTime();
    if (!map[key]) map[key] = [];
    map[key].push(e);
  });
  return map;
}

function groupByMonth(entries) {
  const map = {};
  entries.forEach(e => {
    const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
    const key = getMonthStart(d).getTime();
    if (!map[key]) map[key] = [];
    map[key].push(e);
  });
  return map;
}

function avgField(entries, field) {
  const valid = entries.filter(e => e[field] > 0);
  return valid.length ? valid.reduce((s, e) => s + e[field], 0) / valid.length : null;
}

const chartBaseOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    x: { ticks: { font: { size: 10 }, maxRotation: 60 } },
    y: { ticks: { font: { size: 10 } } },
  },
};

// ============================================================
// VERTAILU CHARTS
// ============================================================
// ── Team comparison cache ─────────────────────────────────────
// Keyed by sorted team names + week-start. TTL = 1 hour.

function teamCacheKey(teams, weekStart) {
  return 'teamcmp_' + [...teams].sort().join('|') + '_' + weekStart;
}

function teamCacheGet(uid, key) {
  try {
    const raw = localStorage.getItem('uppis_tc_' + uid + '_' + key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > TEAM_CACHE_TTL) { localStorage.removeItem('uppis_tc_' + uid + '_' + key); return null; }
    return data;
  } catch { return null; }
}

function teamCacheSet(uid, key, data) {
  try { localStorage.setItem('uppis_tc_' + uid + '_' + key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

// ── Perf filter helper ────────────────────────────────────────
function filterByPerf(entries) {
  if (vertailuPerfFilter.length === 0) return entries;
  return entries.filter(e => vertailuPerfFilter.includes(e.performance));
}

// ── Shared perf filter UI ─────────────────────────────────────
// Just refreshes button active-states without rebuilding the DOM
function refreshPerfBtnStates(containerId) {
  const container = el(containerId);
  if (!container || container.children.length !== 5) return;
  Array.from(container.children).forEach((btn, i) => {
    const isActive = vertailuPerfFilter.includes(i + 1);
    btn.classList.toggle('active', isActive);
    applyPerfBtnColor(btn, i, isActive);
  });
}

// Builds (or refreshes) perf-filter buttons in any container.
// onChangeFn is called after state has been updated.
function initPerfFilterUI(containerId, onChangeFn) {
  const container = el(containerId);
  if (!container) return;
  // Already built — just sync active states
  if (container.children.length === 5) {
    refreshPerfBtnStates(containerId);
    return;
  }
  const labels = ['I', 'II', 'III', 'IV', 'V'];
  container.innerHTML = '';
  labels.forEach((lbl, i) => {
    const zone     = i + 1;
    const isActive = vertailuPerfFilter.includes(zone);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perf-btn' + (isActive ? ' active' : '');
    btn.textContent = lbl;
    applyPerfBtnColor(btn, i, isActive);
    btn.addEventListener('click', () => {
      const idx = vertailuPerfFilter.indexOf(zone);
      if (idx === -1) vertailuPerfFilter.push(zone);
      else            vertailuPerfFilter.splice(idx, 1);
      onChangeFn();
    });
    container.appendChild(btn);
  });
}

// ── Init perf filter buttons (called once per renderVertailuCharts) ──
function initVertailuPerfFilter() {
  initPerfFilterUI('vertailu-perf-btns', () => {
    // Keep Omat buttons in sync
    refreshPerfBtnStates('omat-perf-btns');
    // Clear team cache so filter change forces recompute
    const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
    if (myTeams.length > 0) {
      const weeks = getLastNWeeks(12);
      const cKey  = teamCacheKey(myTeams, weeks[0].getTime());
      try { localStorage.removeItem('uppis_tc_' + currentUser.uid + '_' + cKey); } catch {}
    }
    renderVertailuCharts();
  });
}

// ── KPI card renderer ─────────────────────────────────────────
function renderVertailuKPIs(ownMinData, ownSessData, teamAvgMinData, teamTopMinData,
                             teamAvgSessData, teamTopSessData, hasTeamData) {
  const weeks      = getLastNWeeks(12);
  const lastIdx    = weeks.length - 1;

  const deltaHtml = (val, ref, refLabel) => {
    if (ref === null || ref === undefined) return '';
    const diff = Math.round(val - ref);
    const cls  = diff > 0 ? 'positive' : diff < 0 ? 'negative' : 'neutral';
    const sign = diff > 0 ? '+' : '';
    return `<div class="kpi-delta ${cls}">${sign}${diff} vs ${escapeHtml(refLabel)}</div>`;
  };

  const cardHtml = (cardMetric) => {
    const isActive = vertailuMetric === cardMetric;
    const isMins   = cardMetric === 'minutes';
    const lbl      = isMins ? 'Minuutit' : 'Treenit';
    const unit     = isMins ? 'min' : 'treeniä';
    const ownVal   = (isMins ? ownMinData : ownSessData)[lastIdx] ?? 0;
    const avgVal   = (isMins ? teamAvgMinData : teamAvgSessData)[lastIdx];
    const topVal   = (isMins ? teamTopMinData : teamTopSessData)[lastIdx];

    const deltasHtml = hasTeamData
      ? `<div class="kpi-deltas">
           ${deltaHtml(ownVal, avgVal, 'joukkue ka')}
           ${deltaHtml(ownVal, topVal, 'eniten treenaava')}
         </div>`
      : `<div class="kpi-deltas"><div class="kpi-delta neutral">Ei joukkuetta</div></div>`;

    return `<div class="vertailu-kpi-card${isActive ? ' active' : ''}" data-metric="${cardMetric}">
      <div class="kpi-label">${lbl}</div>
      <div><span class="kpi-value">${ownVal}</span> <span class="kpi-unit">${unit}</span></div>
      ${deltasHtml}
    </div>`;
  };

  el('vertailu-kpi-row').innerHTML = cardHtml('minutes') + cardHtml('sessions');

  // Wire up click handlers
  el('vertailu-kpi-row').querySelectorAll('.vertailu-kpi-card').forEach(card => {
    card.addEventListener('click', () => {
      vertailuMetric = card.dataset.metric;
      renderVertailuCharts();
    });
  });
}

async function renderVertailuCharts() {
  if (!allChartEntries.length) await fetchChartEntries();

  const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
  const weeks   = getLastNWeeks(12);
  const wLabels = weeks.map(w => w.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' }));

  // Init perf filter buttons
  initVertailuPerfFilter();

  // Own weekly data — filtered by perf zone
  const filteredOwn = filterByPerf(allChartEntries);
  const myWeekMap   = groupByWeek(filteredOwn);
  const ownMinData  = weeks.map(w => {
    const weekEntries = myWeekMap[w.getTime()] || [];
    const mins = weekEntries.reduce((s, e) => s + (e.duration || 0), 0);
    return mins > 0 ? mins : null;
  });
  const ownSessData = weeks.map(w => {
    const cnt = (myWeekMap[w.getTime()] || []).length;
    return cnt > 0 ? cnt : null;
  });

  // Show/hide no-team notice
  if (myTeams.length === 0) show('vertailu-no-team'); else hide('vertailu-no-team');

  destroyChart('vertailuMinutes');

  let teamAvgMinData  = weeks.map(() => null);
  let teamTopMinData  = weeks.map(() => null);
  let teamAvgSessData = weeks.map(() => null);
  let teamTopSessData = weeks.map(() => null);
  let hasTeamData     = false;

  if (myTeams.length > 0) {
    try {
      const cKey     = teamCacheKey(myTeams, weeks[0].getTime());
      const cacheHit = teamCacheGet(currentUser.uid, cKey); // always check, regardless of filter

      if (cacheHit?.memberEntries) {
        if (vertailuPerfFilter.length === 0) {
          // ── No filter: serve fully pre-aggregated data from cache ──
          cachedTeamMemberEntries = cacheHit.memberEntries;
          teamAvgMinData  = cacheHit.avgMins;
          teamTopMinData  = cacheHit.topMins;
          teamAvgSessData = cacheHit.avgSess;
          teamTopSessData = cacheHit.topSess;
          hasTeamData     = cacheHit.hasData;
        } else if (Object.keys(cachedTeamMemberEntries).length === 0) {
          // ── Filter active: restore raw entries from cache, recompute below ──
          cachedTeamMemberEntries = cacheHit.memberEntries;
        }
      }

      // Fetch from Firestore only when raw entries are unavailable
      const haveRawEntries = Object.keys(cachedTeamMemberEntries).length > 0;
      const needFetch = !cacheHit?.memberEntries && !haveRawEntries;

      if (needFetch) {
        // ── Fetch from Firestore ──────────────────────────────
        const usersSnap = await db.collection('users')
          .where('profile.teams', 'array-contains-any', myTeams)
          .get();

        const teamMemberUids = [];
        usersSnap.forEach(doc => {
          if (doc.id !== currentUser.uid) teamMemberUids.push(doc.id);
        });

        // Seed with own entries (full 24-week set)
        cachedTeamMemberEntries[currentUser.uid] = allChartEntries;

        // Fetch other members' entries in parallel
        if (teamMemberUids.length > 0) {
          const cutoff = firebase.firestore.Timestamp.fromDate(weeks[0]);
          const nowTimestamp = firebase.firestore.Timestamp.fromDate(new Date());
          await Promise.all(teamMemberUids.map(async uid => {
            const snap = await db.collection('users').doc(uid).collection('entries')
              .where('date', '>=', cutoff).where('date', '<=', nowTimestamp).limit(500).get();
            cachedTeamMemberEntries[uid] = snap.docs.map(d => {
              const data = d.data();
              return {
                date:        data.date,
                duration:    data.duration    || 0,
                performance: data.performance || 0,
                feeling:     data.feeling     || 0,
                type:        data.type        || '',
              };
            });
          }));
        }

        hasTeamData = true;
      }

      if (hasTeamData || Object.keys(cachedTeamMemberEntries).length > 0) {
        hasTeamData = true;
        // Compute aggregated arrays from raw entries (applying perf filter)
        const allUids = Object.keys(cachedTeamMemberEntries);

        // Per-member, per-week minutes and sessions (after perf filter)
        const memberMinsByWeek  = {};
        const memberSessByWeek  = {};
        allUids.forEach(uid => {
          const entries = filterByPerf(cachedTeamMemberEntries[uid] || []);
          const wm = groupByWeek(entries);
          memberMinsByWeek[uid]  = weeks.map(w =>
            (wm[w.getTime()] || []).reduce((s, e) => s + (e.duration || 0), 0)
          );
          memberSessByWeek[uid] = weeks.map(w =>
            (wm[w.getTime()] || []).length
          );
        });

        teamAvgMinData = weeks.map((_, i) => {
          const vals = allUids.map(uid => memberMinsByWeek[uid][i]).filter(v => v > 0);
          return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
        });
        teamTopMinData = weeks.map((_, i) => {
          const vals = allUids.map(uid => memberMinsByWeek[uid][i]).filter(v => v > 0);
          return vals.length > 0 ? Math.max(...vals) : null;
        });
        teamAvgSessData = weeks.map((_, i) => {
          const vals = allUids.map(uid => memberSessByWeek[uid][i]).filter(v => v > 0);
          return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
        });
        teamTopSessData = weeks.map((_, i) => {
          const vals = allUids.map(uid => memberSessByWeek[uid][i]).filter(v => v > 0);
          return vals.length > 0 ? Math.max(...vals) : null;
        });

        // Cache raw entries + aggregated arrays (only when no perf filter active)
        if (vertailuPerfFilter.length === 0) {
          // Serialize cachedTeamMemberEntries — convert Firestore Timestamps to millis
          const serializableEntries = {};
          allUids.forEach(uid => {
            serializableEntries[uid] = (cachedTeamMemberEntries[uid] || []).map(e => ({
              date:        e.date?.toMillis ? e.date.toMillis() : (e.date instanceof Date ? e.date.getTime() : e.date),
              duration:    e.duration    || 0,
              performance: e.performance || 0,
              feeling:     e.feeling     || 0,
              type:        e.type        || '',
            }));
          });
          teamCacheSet(currentUser.uid, cKey, {
            avgMins: teamAvgMinData,
            topMins: teamTopMinData,
            avgSess: teamAvgSessData,
            topSess: teamTopSessData,
            memberEntries: serializableEntries,
            hasData: hasTeamData,
          });
        }
      }
    } catch (err) {
      console.warn('Joukkuetietojen haku epäonnistui:', err);
    }

    // Restore Timestamp-like objects in cachedTeamMemberEntries if they came from cache (millis numbers)
    Object.keys(cachedTeamMemberEntries).forEach(uid => {
      cachedTeamMemberEntries[uid] = (cachedTeamMemberEntries[uid] || []).map(e => {
        if (typeof e.date === 'number') {
          return { ...e, date: { toMillis: () => e.date, toDate: () => new Date(e.date) } };
        }
        return e;
      });
    });
  }

  // Render KPI cards
  renderVertailuKPIs(
    ownMinData, ownSessData,
    teamAvgMinData, teamTopMinData,
    teamAvgSessData, teamTopSessData,
    hasTeamData
  );

  // Determine active metric data
  const isMins  = vertailuMetric === 'minutes';
  const ownData = isMins ? ownMinData : ownSessData;
  const avgData = isMins ? teamAvgMinData : teamAvgSessData;
  const topData = isMins ? teamTopMinData : teamTopSessData;
  const yUnit   = isMins ? ' min' : ' treeniä';
  const ownLabel = isMins ? 'Omat minuutit' : 'Omat treenit';

  // Update chart title
  const titleEl = el('vertailu-chart-title');
  if (titleEl) {
    titleEl.textContent = isMins
      ? 'Minuutit – viimeiset 12 viikkoa'
      : 'Treenit – viimeiset 12 viikkoa';
  }

  // Build datasets — area charts behind, own bars in front
  const datasets = [];

  if (hasTeamData) {
    datasets.push({
      type: 'line',
      label: 'Eniten treenaava',
      data: topData,
      borderColor: 'rgba(255,140,0,1)',
      backgroundColor: 'transparent',
      pointBackgroundColor: 'rgba(255,140,0,1)',
      fill: false, tension: 0.3, spanGaps: true,
      pointRadius: 3, borderWidth: 2.5,
      order: 1,
    });
    datasets.push({
      type: 'line',
      label: 'Joukkueen keskiarvo',
      data: avgData,
      borderColor: 'rgba(160,160,160,1)',
      backgroundColor: 'transparent',
      pointBackgroundColor: 'rgba(160,160,160,1)',
      fill: false, tension: 0.3, spanGaps: true,
      pointRadius: 3, borderWidth: 2.5,
      order: 2,
    });
  }

  datasets.push({
    type: 'bar',
    label: ownLabel,
    data: ownData,
    backgroundColor: 'rgba(0,63,156,0.80)',
    borderRadius: 3,
    order: 3,
  });

  // Legend
  const legendItems = [
    { color: 'rgba(0,63,156,0.85)', label: ownLabel },
    ...(hasTeamData ? [
      { color: 'rgba(160,160,160,1)',  label: 'Joukkueen keskiarvo' },
      { color: 'rgba(255,140,0,1)',    label: 'Eniten treenaava' },
    ] : []),
  ];
  el('vertailu-legend').innerHTML = legendItems.map(item =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${item.color}"></span>${item.label}</span>`
  ).join('');

  chartInstances.vertailuMinutes = new Chart(
    el('chart-vertailu-minutes').getContext('2d'),
    {
      type: 'bar',
      data: { labels: wLabels, datasets },
      options: {
        ...chartBaseOptions,
        scales: {
          ...chartBaseOptions.scales,
          y: {
            ...chartBaseOptions.scales.y,
            min: 0,
            ticks: { font: { size: 10 }, callback: v => v + yUnit },
          },
        },
      },
    }
  );
}

// ============================================================
// TRENDIT CHARTS
// ============================================================
async function renderTrenditCharts() {
  if (!allChartEntries.length) await fetchChartEntries();

  // Show empty state if no entries at all
  const isEmpty = allChartEntries.length === 0;
  el('trendit-empty').classList.toggle('hidden', !isEmpty);
  el('trendit-charts').classList.toggle('hidden', isEmpty);
  if (isEmpty) return;

  // Init perf filter UI — synced with Vertailu
  initPerfFilterUI('omat-perf-btns', () => {
    refreshPerfBtnStates('vertailu-perf-btns');
    renderTrenditCharts();
  });

  // Apply perf filter (shared state with Vertailu)
  const filteredEntries = filterByPerf(allChartEntries);

  // Build legend
  const legendEl = el('trendit-legend');
  legendEl.innerHTML = PERF_ROMAN.map((r, i) =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${PERF_COLORS[i]}"></span>${r}</span>`
  ).join('');

  const weeks   = getLastNWeeks(12);
  const weekMap = groupByWeek(filteredEntries);
  const labels  = weeks.map(w => w.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' }));

  // Stacked minutes by performance level
  const minutesDatasets = PERF_ROMAN.map((roman, i) => ({
    label: roman,
    data: weeks.map(w => {
      const group = weekMap[w.getTime()] || [];
      return group.filter(e => e.performance === i + 1).reduce((s, e) => s + (e.duration || 0), 0) || null;
    }),
    backgroundColor: PERF_COLORS[i],
    borderRadius: 2,
  }));

  // Referenssiviiva minuuttitavoitteelle
  const minutesGoal = userProfile.weeklyMinutesGoal || null;
  if (minutesGoal) {
    minutesDatasets.push({
      type: 'line',
      label: 'Tavoite',
      data: Array(12).fill(minutesGoal),
      borderColor: 'rgba(0,0,0,0.45)',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      order: -1,
    });
  }

  destroyChart('weeklyMinutes');
  chartInstances.weeklyMinutes = new Chart(
    el('chart-weekly-minutes').getContext('2d'),
    {
      type: 'bar',
      data: { labels, datasets: minutesDatasets },
      options: {
        ...chartBaseOptions,
        scales: {
          x: { ...chartBaseOptions.scales.x, stacked: true },
          y: { ...chartBaseOptions.scales.y, stacked: true },
        },
      },
    }
  );

  // ── Stacked treenikerrat by performance level ──────────────
  const countDatasets = PERF_ROMAN.map((roman, i) => ({
    label: roman,
    data: weeks.map(w => {
      const n = (weekMap[w.getTime()] || []).filter(e => e.performance === i + 1).length;
      return n || null;
    }),
    backgroundColor: PERF_COLORS[i],
    borderRadius: 2,
  }));

  // Referenssiviiva treenikertataoitteelle
  const sessionsGoal = userProfile.weeklySessionsGoal || null;
  if (sessionsGoal) {
    countDatasets.push({
      type: 'line',
      label: 'Tavoite',
      data: Array(12).fill(sessionsGoal),
      borderColor: 'rgba(0,0,0,0.45)',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false,
      order: -1,
    });
  }

  destroyChart('weeklyCount');
  chartInstances.weeklyCount = new Chart(
    el('chart-weekly-count').getContext('2d'),
    {
      type: 'bar',
      data: { labels, datasets: countDatasets },
      options: {
        ...chartBaseOptions,
        scales: {
          x: { ...chartBaseOptions.scales.x, stacked: true },
          y: {
            ...chartBaseOptions.scales.y,
            stacked: true,
            ticks: {
              ...chartBaseOptions.scales.y.ticks,
              stepSize: 1,
              precision: 0,
            },
          },
        },
      },
    }
  );

  // Feeling area chart + monthly trend line
  const feelingData = weeks.map(w => {
    const val = avgField(weekMap[w.getTime()] || [], 'feeling');
    return val !== null ? +val.toFixed(2) : null;
  });

  // 4-week trailing rolling average ≈ kuukauden liukuva keskiarvo
  const trendData = feelingData.map((_, i) => {
    const window = feelingData.slice(Math.max(0, i - 3), i + 1).filter(v => v !== null);
    return window.length > 0 ? +(window.reduce((s, v) => s + v, 0) / window.length).toFixed(2) : null;
  });

  destroyChart('weeklyFeeling');
  chartInstances.weeklyFeeling = new Chart(
    el('chart-weekly-feeling').getContext('2d'),
    {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Fiilis (vko ka)',
            data: feelingData,
            borderColor: 'rgba(0,63,156,0.7)',
            backgroundColor: (ctx) => {
              const canvas = ctx.chart.ctx;
              const gradient = canvas.createLinearGradient(0, 0, 0, ctx.chart.height);
              gradient.addColorStop(0,   'rgba(0,63,156,0.25)');
              gradient.addColorStop(1,   'rgba(0,63,156,0.02)');
              return gradient;
            },
            fill: true,
            tension: 0.35,
            spanGaps: true,
            pointRadius: 3,
            pointHoverRadius: 5,
            pointBackgroundColor: 'rgba(0,63,156,0.85)',
            borderWidth: 2,
            order: 2,
          },
          {
            label: 'Trendi (kk ka)',
            data: trendData,
            borderColor: 'rgba(234,88,12,0.85)',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.4,
            spanGaps: true,
            pointRadius: 0,
            borderWidth: 2.5,
            order: 1,
          },
        ],
      },
      options: {
        ...chartBaseOptions,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                if (v === null) return null;
                const label = ctx.dataset.label;
                const feelLabel = FEEL_LABELS[Math.round(v)];
                return `${label}: ${v.toFixed(1)}${feelLabel ? ' – ' + feelLabel : ''}`;
              },
            },
          },
        },
        scales: {
          x: { ...chartBaseOptions.scales.x },
          y: {
            ...chartBaseOptions.scales.y,
            min: 1,
            max: 5,
            ticks: {
              stepSize: 1,
              font: { size: 10 },
              callback: v => FEEL_LABELS[v] || v,
            },
          },
        },
      },
    }
  );

  // Feeling chart legend — placed between the two charts
  el('feeling-legend').innerHTML = [
    { color: 'rgba(0,63,156,0.7)',   label: 'Fiilis (vko ka)' },
    { color: 'rgba(234,88,12,0.85)', label: 'Trendi (kk ka)' },
  ].map(item =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${item.color}"></span>${item.label}</span>`
  ).join('');

  // ── Piirakat: tehoaluejakauma 12 vk ──────────────────────────
  const totalMinByZone  = PERF_ROMAN.map((_, i) =>
    weeks.reduce((sum, w) =>
      sum + (weekMap[w.getTime()] || [])
        .filter(e => e.performance === i + 1)
        .reduce((s, e) => s + (e.duration || 0), 0), 0)
  );
  const totalCntByZone  = PERF_ROMAN.map((_, i) =>
    weeks.reduce((sum, w) =>
      sum + (weekMap[w.getTime()] || [])
        .filter(e => e.performance === i + 1).length, 0)
  );

  const buildPieLegend = (legendId, totals) => {
    const total = totals.reduce((s, v) => s + v, 0);
    el(legendId).innerHTML = PERF_ROMAN.map((roman, i) => {
      if (!totals[i]) return '';
      const pct = Math.round(totals[i] / total * 100);
      return `<div class="pie-legend-item">
        <span class="pie-legend-swatch" style="background:${PERF_COLORS[i]}"></span>
        <span class="pie-legend-label">${roman}</span>
        <span class="pie-legend-pct">${pct}%</span>
      </div>`;
    }).join('');
  };

  const buildDoughnut = (chartId, totals, unit) => {
    const total = totals.reduce((s, v) => s + v, 0);
    destroyChart(chartId);
    if (!total) return;
    chartInstances[chartId] = new Chart(
      el(chartId).getContext('2d'),
      {
        type: 'doughnut',
        data: {
          labels: PERF_ROMAN,
          datasets: [{
            data: totals.map(v => v || null),
            backgroundColor: PERF_COLORS,
            borderWidth: 0,
          }],
        },
        options: {
          cutout: '58%',
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const v = ctx.parsed;
                  const pct = Math.round(v / total * 100);
                  return ` ${ctx.label}: ${v} ${unit} (${pct}%)`;
                },
              },
            },
          },
        },
      }
    );
  };

  buildDoughnut('chart-pie-minutes', totalMinByZone,  'min');
  buildDoughnut('chart-pie-count',   totalCntByZone,  'krt');
  buildPieLegend('pie-minutes-legend', totalMinByZone);
  buildPieLegend('pie-count-legend',   totalCntByZone);
}

// ============================================================
// REFRESH ACTIVE CHART (called after own entries update)
// ============================================================
function refreshActiveChart() {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  if (activeTab !== 'trendit') return;
  // Vertailu fetches external team data — only re-render on explicit tab open, not on every own-entry refresh
  const activeSub = document.querySelector('#trendit-sub-tabs .sub-tab.active')?.dataset.subtab || 'omat';
  if (activeSub === 'omat') renderTrenditCharts();
}

// ============================================================
// EWMA TRAINING LOAD  (Kuorma-välilehti — vain admin)
// ============================================================

let kuormaAtlCtlChart = null;
let kuormaAcwrChart   = null;
let kuormaZoneChart   = null;
let kuormaZoneLoadChart = null;

// Laske sessiokohtainen kuorma (AU = arbitrary units)
function sessionLoadAU(entry) {
  const dur = entry.duration || 0;
  if (!dur) return 0;
  const perf = entry.performance;
  if (perf && perf >= 1 && perf <= 5) return ZONE_WEIGHTS[perf] * dur;
  // Ei tehoaluetta — käytä lajin oletuspainoa
  const w = SPORT_DEFAULT_WEIGHTS[entry.type] ?? SPORT_DEFAULT_WEIGHT_FALLBACK;
  return w * dur;
}

// Laskee EWMA-historian päivätasolla 84 päivää taaksepäin (12 viikkoa)
function calcEwmaHistory(entries) {
  const λa = 2 / (7  + 1);  // 0.250 — akuutti (7 pv)
  const λc = 2 / (28 + 1);  // 0.069 — krooninen (28 pv)

  // Kerää päiväkohtaiset kuormat
  const dailyLoad = {};
  entries.forEach(e => {
    const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
    const key = d.toISOString().slice(0, 10);
    dailyLoad[key] = (dailyLoad[key] || 0) + sessionLoadAU(e);
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 83); // 84 päivää = 12 viikkoa

  let atl = 0, ctl = 0;
  const history = [];

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key  = d.toISOString().slice(0, 10);
    const load = dailyLoad[key] || 0;
    atl = λa * load + (1 - λa) * atl;
    ctl = λc * load + (1 - λc) * ctl;
    history.push({ date: new Date(d), atl, ctl, load });
  }
  return history;
}

// ACWR-väri ja status-teksti
function acwrStatus(acwr) {
  if (acwr === null || acwr === 0)   return { cls: 'acwr-status--na',     label: 'Ei dataa',        color: '#9CA3AF' };
  if (acwr < 0.6)                    return { cls: 'acwr-status--low',    label: 'Alikuormitus',    color: '#3B82F6' };
  if (acwr < 0.8)                    return { cls: 'acwr-status--low',    label: 'Kevyt jakso',     color: '#3B82F6' };
  if (acwr <= 1.3)                   return { cls: 'acwr-status--ok',     label: 'Optimivyöhyke ✓', color: '#16a34a' };
  if (acwr <= 1.5)                   return { cls: 'acwr-status--warn',   label: 'Tarkkaile ⚠',    color: '#F5A623' };
  return                               { cls: 'acwr-status--danger',  label: 'Korkea kuorma 🔴', color: '#dc2626' };
}

async function renderKuormaTab() {
  // Hae chart-data tarvittaessa (esim. heti impersonoinnin jälkeen kun
  // allChartEntries on nollattu, tai jos Omat/Vertailu ei vielä käyty)
  if (!allChartEntries.length) {
    const acwrSec = el('kuorma-acwr-section');
    if (acwrSec) acwrSec.innerHTML = '<p class="loading">Lasketaan…</p>';
    await fetchChartEntries();
  }
  const entries = allChartEntries.length > 0 ? allChartEntries : [];

  // ── Datalaatu ──
  const dqSection = el('kuorma-dq-row');
  if (dqSection && entries.length > 0) {
    const withZone = entries.filter(e => e.performance >= 1).length;
    const pct = Math.round((withZone / entries.length) * 100);
    dqSection.innerHTML = `
      <span class="kuorma-dq-label">Datalaatu</span>
      <div class="kuorma-dq-bar-wrap">
        <div class="kuorma-dq-bar-fill" style="width:${pct}%"></div>
      </div>
      <span class="kuorma-dq-pct">${pct} %</span>
      <span class="kuorma-dq-label">tehoalue kirjattu (loput arvioitu lajin mukaan)</span>`;
  }

  if (entries.length === 0) {
    el('kuorma-acwr-section').innerHTML = '<p class="loading">Ei harjoitusdataa.</p>';
    return;
  }

  const history = calcEwmaHistory(entries);
  const last    = history[history.length - 1];
  // Same warm-up guard as the chart graph: suppress gauge until CTL has 28 days to stabilise
  const _gaugeFirstLoad = entries
    .filter(e => sessionLoadAU(e) > 0)
    .map(e => (e.date?.toDate ? e.date.toDate() : new Date(e.date)))
    .sort((a, b) => a - b)[0] || null;
  const _gaugeCtlReady  = _gaugeFirstLoad ? new Date(_gaugeFirstLoad.getTime() + 28 * 86400000) : null;
  const acwr    = (last.ctl > 0 && (!_gaugeCtlReady || last.date >= _gaugeCtlReady))
    ? last.atl / last.ctl : null;
  const status  = acwrStatus(acwr);

  // ── ACWR Gauge ──
  const acwrVal   = acwr !== null ? acwr.toFixed(2) : '—';
  const angleDeg  = acwr !== null ? Math.min(acwr / 2, 1) * 180 : 0; // 0–180° kaari
  const acwrSec   = el('kuorma-acwr-section');
  if (acwrSec) {
    // Värisegmenttien pituudet kaaressa (kokonaispituus 157, vastaa arvoa 0–2.0)
    // 0–0.8 sininen, 0.8–1.3 vihreä, 1.3–1.5 keltainen, 1.5–2.0 punainen
    const arcLen = 157;
    const seg = (from, to) => ({
      len: ((to - from) / 2) * arcLen,
      off: -((from / 2) * arcLen),
    });
    const sBlue   = seg(0,   0.8);
    const sGreen  = seg(0.8, 1.3);
    const sYellow = seg(1.3, 1.5);
    const sRed    = seg(1.5, 2.0);

    // Indikaattorin sijainti kaarella (ACWR 0–2 → 180°–0°)
    const v = Math.min(Math.max(acwr || 0, 0), 2);
    const theta = Math.PI * (1 - v / 2); // v=0 → π (vasen), v=2 → 0 (oikea)
    const cx = 60 + 50 * Math.cos(theta);
    const cy = 65 - 50 * Math.sin(theta);

    acwrSec.innerHTML = `
      <div class="kuorma-acwr-row">
        <div class="kuorma-gauge-wrap">
          <svg class="kuorma-gauge-svg" viewBox="0 0 120 75">
            <!-- Värisegmentit kaaressa (ACWR-vyöhykkeet) -->
            <path d="M10,65 A50,50 0 0,1 110,65" fill="none" stroke="#60a5fa" stroke-width="10"
              stroke-dasharray="${sBlue.len} ${arcLen}" stroke-dashoffset="${sBlue.off}"/>
            <path d="M10,65 A50,50 0 0,1 110,65" fill="none" stroke="#4ade80" stroke-width="10"
              stroke-dasharray="${sGreen.len} ${arcLen}" stroke-dashoffset="${sGreen.off}"/>
            <path d="M10,65 A50,50 0 0,1 110,65" fill="none" stroke="#facc15" stroke-width="10"
              stroke-dasharray="${sYellow.len} ${arcLen}" stroke-dashoffset="${sYellow.off}"/>
            <path d="M10,65 A50,50 0 0,1 110,65" fill="none" stroke="#ef4444" stroke-width="10"
              stroke-dasharray="${sRed.len} ${arcLen}" stroke-dashoffset="${sRed.off}"/>
            <!-- Nykyisen arvon indikaattori -->
            ${acwr !== null ? `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="6"
              fill="white" stroke="${status.color}" stroke-width="3"/>` : ''}
          </svg>
          <div class="kuorma-gauge-center">
            <span class="kuorma-gauge-val" style="color:${status.color}">${acwrVal}</span>
            <span class="kuorma-gauge-lbl">ACWR</span>
          </div>
        </div>
        <div class="kuorma-acwr-info">
          <span class="kuorma-status-badge ${status.cls}">${status.label}</span>
          <div class="kuorma-kpi-row">
            <div class="kuorma-kpi"><span class="kuorma-kpi-label">ATL (7 pv)</span><span class="kuorma-kpi-val">${last.atl.toFixed(0)} AU</span></div>
            <div class="kuorma-kpi"><span class="kuorma-kpi-label">CTL (28 pv)</span><span class="kuorma-kpi-val">${last.ctl.toFixed(0)} AU</span></div>
          </div>
        </div>
      </div>`;
  }

  // ── ATL/CTL -kaavio ──
  const weeks   = getLastNWeeks(12);
  const _today  = new Date(); _today.setHours(0,0,0,0);
  // Poimi yhden pisteen per viikko (viikon viimeinen päivä historiassa)
  const weekPts = weeks.map(wStart => {
    const wEnd = new Date(wStart);
    wEnd.setDate(wEnd.getDate() + 6);
    const pts = history.filter(h => h.date >= wStart && h.date <= wEnd);
    return pts.length ? pts[pts.length - 1] : null;
  });
  // Tunnista kuluva (kesken oleva) viikko: viikko jonka loppupäivä on tulevaisuudessa
  const currentWeekIdx = weeks.findIndex(wStart => {
    const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 6);
    return _today >= wStart && _today <= wEnd;
  });
  const wLabels = weeks.map(w => {
    const d = new Date(Date.UTC(w.getFullYear(), w.getMonth(), w.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return 'Vk ' + Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  });

  if (kuormaAtlCtlChart) { kuormaAtlCtlChart.destroy(); kuormaAtlCtlChart = null; }
  const atlCtlCtx = el('kuorma-atl-ctl-chart');
  if (atlCtlCtx) {
    kuormaAtlCtlChart = new Chart(atlCtlCtx, {
      data: {
        labels: wLabels,
        datasets: [
          {
            type: 'line', label: 'ATL – akuutti (7 pv)',
            data: weekPts.map(p => p ? Math.round(p.atl) : null),
            borderColor: '#003F9C', backgroundColor: 'rgba(0,63,156,0.08)',
            pointBackgroundColor: '#003F9C', pointBorderColor: '#003F9C',
            borderWidth: 2, pointRadius: 3, tension: 0.35, fill: false, spanGaps: true,
            order: 2,
            segment: { borderDash: ctx => ctx.p1DataIndex === currentWeekIdx ? [5, 4] : undefined },
          },
          {
            type: 'line', label: 'CTL – krooninen (28 pv)',
            data: weekPts.map(p => p ? Math.round(p.ctl) : null),
            borderColor: '#F5A623',
            pointBackgroundColor: '#F5A623', pointBorderColor: '#F5A623',
            borderWidth: 2, pointRadius: 3, tension: 0.35, fill: false, spanGaps: true,
            order: 1,
            segment: { borderDash: ctx => ctx.p1DataIndex === currentWeekIdx ? [5, 4] : undefined },
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 10, color: '#6B7280' } },
          tooltip: { callbacks: { label: c => c.dataset.label + ': ' + c.parsed.y + ' AU' + (c.dataIndex === currentWeekIdx ? ' (kesken)' : '') } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#9CA3AF' } },
          y: { grid: { color: '#F3F4F6' }, ticks: { font: { size: 10 }, color: '#9CA3AF' },
               title: { display: true, text: 'AU', font: { size: 10 }, color: '#9CA3AF' } },
        },
      },
    });
  }

  // ── ACWR ajan yli ──
  // CTL (28 pv EWMA) tarvitsee ~28 päivää tasaantuakseen. Sitä ennen ATL/CTL on
  // keinotekoisesti suuri → piilotetaan nuo viikot graafista automaattisesti.
  const firstLoadDate = entries
    .filter(e => sessionLoadAU(e) > 0)
    .map(e => (e.date?.toDate ? e.date.toDate() : new Date(e.date)))
    .sort((a, b) => a - b)[0] || null;
  const ctlReadyDate = firstLoadDate
    ? new Date(firstLoadDate.getTime() + 28 * 86400000)
    : null;
  // Raaka-arvo tooltipiin, leikattu (max 2.0) piirtoa varten — niin viiva pysyy graafin sisällä
  const acwrRaw = weekPts.map(p => {
    if (!p || p.ctl <= 0) return null;
    if (ctlReadyDate && p.date < ctlReadyDate) return null; // CTL ei vielä tasaantunut
    return +(p.atl / p.ctl).toFixed(2);
  });
  const acwrPts  = acwrRaw.map(v => v === null ? null : Math.min(v, 2.0));

  if (kuormaAcwrChart) { kuormaAcwrChart.destroy(); kuormaAcwrChart = null; }
  const acwrCtx = el('kuorma-acwr-chart');
  if (acwrCtx) {
    kuormaAcwrChart = new Chart(acwrCtx, {
      data: {
        labels: wLabels,
        datasets: [
          {
            type: 'line', label: 'ACWR',
            data: acwrPts,
            borderColor: '#7C3AED', backgroundColor: 'rgba(124,58,237,0.06)',
            borderWidth: 2, pointRadius: acwrPts.map(v => v !== null ? 4 : 0),
            pointBackgroundColor: acwrPts.map(v => {
              if (v === null) return 'transparent';
              return acwrStatus(v).color;
            }),
            pointBorderColor: acwrPts.map(v => {
              if (v === null) return 'transparent';
              return acwrStatus(v).color;
            }),
            pointBorderWidth: 1,
            tension: 0.35, fill: false, spanGaps: true,
            segment: { borderDash: ctx => ctx.p1DataIndex === currentWeekIdx ? [5, 4] : undefined },
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => {
            const raw = acwrRaw[c.dataIndex];
            const suffix = c.dataIndex === currentWeekIdx ? ' (kesken)' : '';
            return 'ACWR: ' + (raw !== null ? raw.toFixed(2) : '–') + suffix;
          } } },
          annotation: { /* Chart.js annotation plugin ei ole ladattu — käytetään viivoja manuaalisesti */ },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#9CA3AF' } },
          y: {
            grid: { color: '#F3F4F6' },
            ticks: { font: { size: 10 }, color: '#9CA3AF' },
            min: 0, max: 2.0,
            title: { display: true, text: 'ACWR', font: { size: 10 }, color: '#9CA3AF' },
          },
        },
      },
      plugins: [{
        // Piirrä vyöhykeväritys taustalle
        id: 'acwrZones',
        beforeDraw(chart) {
          const { ctx, chartArea: { left, right, top, bottom }, scales: { y } } = chart;
          if (!y) return;
          const toY = v => y.getPixelForValue(Math.min(v, y.max));
          // Vaaleat täyssävyt (palettimaiset) — sininen / vihreä / keltainen / punainen
          const pairs = [
            { from: 0,   to: 0.8,  color: '#DBEAFE' }, // pale blue
            { from: 0.8, to: 1.3,  color: '#DCFCE7' }, // pale green
            { from: 1.3, to: 1.5,  color: '#FEF9C3' }, // pale yellow
            { from: 1.5, to: 2.0,  color: '#FEE2E2' }, // pale red
          ];
          pairs.forEach(({ from, to, color }) => {
            const y1 = toY(to);   // ylempi y-pikseli (pienempi luku)
            const y2 = toY(from); // alempi y-pikseli (suurempi luku)
            ctx.fillStyle = color;
            ctx.fillRect(left, y1, right - left, Math.max(y2 - y1, 0));
          });
        },
      }],
    });
  }

  // ── Tehoaluejakauma (viimeiset 4 viikkoa) ──
  const cutoff4w = new Date();
  cutoff4w.setDate(cutoff4w.getDate() - 28);
  const recent = entries.filter(e => {
    const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
    return d >= cutoff4w;
  });

  const zoneMin  = [0, 0, 0, 0, 0, 0]; // indeksi 0 = ei tehoaluetta
  const zoneLoad = [0, 0, 0, 0, 0, 0];
  recent.forEach(e => {
    const z = (e.performance >= 1 && e.performance <= 5) ? e.performance : 0;
    zoneMin[z]  += (e.duration || 0);
    zoneLoad[z] += sessionLoadAU(e);
  });

  // Käytä vain tehoalueet I-V (ohitetaan "ei aluetta" -indeksi 0)
  const minByZone  = [zoneMin[1],  zoneMin[2],  zoneMin[3],  zoneMin[4],  zoneMin[5]];
  const loadByZone = [zoneLoad[1], zoneLoad[2], zoneLoad[3], zoneLoad[4], zoneLoad[5]];

  const buildKuormaLegend = (legendId, totals) => {
    const container = el(legendId);
    if (!container) return;
    const total = totals.reduce((s, v) => s + v, 0);
    container.innerHTML = PERF_ROMAN.map((roman, i) => {
      if (!totals[i]) return '';
      const pct = Math.round(totals[i] / total * 100);
      return `<div class="pie-legend-item">
        <span class="pie-legend-swatch" style="background:${PERF_COLORS[i]}"></span>
        <span class="pie-legend-label">${roman}</span>
        <span class="pie-legend-pct">${pct}%</span>
      </div>`;
    }).join('');
  };

  const buildKuormaDoughnut = (chartId, totals, unit, prevChart) => {
    if (prevChart) prevChart.destroy();
    const ctx = el(chartId);
    if (!ctx) return null;
    const total = totals.reduce((s, v) => s + v, 0);
    if (!total) return null;
    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: PERF_ROMAN,
        datasets: [{
          data: totals.map(v => v || null),
          backgroundColor: PERF_COLORS,
          borderWidth: 0,
        }],
      },
      options: {
        cutout: '58%',
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: c => {
                const v = c.parsed;
                const pct = Math.round(v / total * 100);
                return ` ${c.label}: ${v} ${unit} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  };

  kuormaZoneChart     = buildKuormaDoughnut('kuorma-zone-chart',      minByZone,  'min', kuormaZoneChart);
  kuormaZoneLoadChart = buildKuormaDoughnut('kuorma-zone-load-chart', loadByZone.map(v => Math.round(v)), 'AU', kuormaZoneLoadChart);
  buildKuormaLegend('kuorma-zone-min-legend',  minByZone);
  buildKuormaLegend('kuorma-zone-load-legend', loadByZone);
}
