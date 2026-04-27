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
      const cKey = teamCacheKey(myTeams, weeks[0].getTime());

      // When perf filter is active, skip cache and recompute from stored raw entries
      const useCache = vertailuPerfFilter.length === 0;
      const cached   = useCache ? teamCacheGet(currentUser.uid, cKey) : null;

      if (cached && cached.memberEntries) {
        // ── Served from cache (includes raw entries) ──────────
        cachedTeamMemberEntries = cached.memberEntries;
        teamAvgMinData  = cached.avgMins;
        teamTopMinData  = cached.topMins;
        teamAvgSessData = cached.avgSess;
        teamTopSessData = cached.topSess;
        hasTeamData     = cached.hasData;
      } else if (useCache && cached && !cached.memberEntries) {
        // ── Legacy cache format (no raw entries) — treat as miss ──
        // Fall through to fetch below
        cachedTeamMemberEntries = {};
      }

      // Need to fetch: either no cache hit, or perf filter active but no raw entries in memory
      const needFetch = !cached || !cached.memberEntries;
      const haveRawEntries = Object.keys(cachedTeamMemberEntries).length > 0;

      if (needFetch && !haveRawEntries) {
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
      } else if (cached && cached.memberEntries) {
        // already handled above
        hasTeamData = cached.hasData;
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
      borderColor: 'rgba(220,38,38,0.75)',
      backgroundColor: 'transparent',
      fill: false, tension: 0.3, spanGaps: true,
      pointRadius: 2, borderWidth: 2, borderDash: [4, 3],
      order: 1,
    });
    datasets.push({
      type: 'line',
      label: 'Joukkueen keskiarvo',
      data: avgData,
      borderColor: 'rgba(16,185,129,0.9)',
      backgroundColor: 'rgba(16,185,129,0.15)',
      fill: true, tension: 0.3, spanGaps: true,
      pointRadius: 2, borderWidth: 2,
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
      { color: 'rgba(16,185,129,0.9)', label: 'Joukkueen keskiarvo' },
      { color: 'rgba(220,38,38,0.75)', label: 'Eniten treenaava' },
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
}

// ============================================================
// REFRESH ACTIVE CHART (called after own entries update)
// ============================================================
function refreshActiveChart() {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  // Vertailu fetches external team data — only re-render on explicit tab open, not on every own-entry refresh
  if (activeTab === 'trendit') renderTrenditCharts();
}
