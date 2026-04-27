// ============================================================
// ADMIN PORTAL
// ============================================================
let cachedAdminUsers   = null;
let cachedAdminUsersTs = 0;   // aikaleima millisekunteina
const ADMIN_USERS_TTL  = 5 * 60 * 1000; // 5 min

// ── Impersonation ─────────────────────────────────────────────
function startImpersonation(uid, name, email) {
  // Haetaan joukkueet välimuistista — ei välitetä JSON:na onclick-attribuutista (lainausmerkkiongelma)
  const userRecord = cachedAdminUsers?.find(u => u.uid === uid);
  const teams = userRecord?.profile?.teams || [];
  impersonating = { uid, name, email, teams };
  calLoadedForUid = null; // pakota kalenterin lataus valitulle käyttäjälle
  closeAdminPortal();

  // Show banner
  el('impersonation-banner').classList.remove('hidden');
  el('impersonation-banner-name').textContent = name || email;

  // Hide FAB (read-only view)
  el('add-btn').classList.add('hidden');

  // Navigate to Treenit → Loki
  const treeniBtn = document.querySelector('#app-view [data-tab="treenit"]');
  if (treeniBtn && !treeniBtn.classList.contains('active')) treeniBtn.click();
  const lokiBtn = document.querySelector('#treenit-sub-tabs [data-subtab="loki"]');
  if (lokiBtn && !lokiBtn.classList.contains('active')) lokiBtn.click();

  // Reload entries for the viewed user
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  loadEntries();
}

function stopImpersonation() {
  impersonating = null;
  calLoadedForUid = null; // pakota kalenterin uudelleenlataus omalle käyttäjälle
  el('impersonation-banner').classList.add('hidden');

  // Restore FAB if on loki sub-tab
  const activeSub = document.querySelector('#treenit-sub-tabs .sub-tab.active')?.dataset.subtab;
  if (activeSub !== 'loki') el('add-btn').classList.add('hidden');
  else el('add-btn').classList.remove('hidden');

  // Avaa portaali ensin (käyttäjä näkee portaalin heti)
  openAdminPortal();

  // Lataa oma loki taustalla (ei blokkaa portaalin avautumista)
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  loadEntries();
}

// ── Open / close ──────────────────────────────────────────────
el('zone-picker-close').addEventListener('click', closeZonePicker);
el('zone-picker-backdrop').addEventListener('click', closeZonePicker);

el('admin-shortcut-btn').addEventListener('click', () => {
  if (impersonating) stopImpersonation();
  else openAdminPortal();
});
el('impersonation-exit-btn').addEventListener('click', stopImpersonation);
el('admin-portal-close').addEventListener('click', closeAdminPortal);

async function openAdminPortal() {
  hide('profile-modal');
  document.body.style.overflow = '';

  // Refresh TEAMS from Firestore
  await loadAppSettings();

  const isAdmin   = currentUser?.email === ADMIN_EMAIL;
  const coachTeams = userProfile.coachOf || [];
  const isCoach    = coachTeams.length > 0;

  // Tab visibility: admin sees all 4; coach-only sees aktiivisuus + csv
  document.querySelectorAll('[data-admin-tab]').forEach(btn => {
    const tab = btn.dataset.adminTab;
    const adminOnly = tab === 'kayttajat' || tab === 'yllapito';
    btn.classList.toggle('hidden', adminOnly && !isAdmin);
  });

  // Ensure first visible tab is active
  const firstVisible = document.querySelector('[data-admin-tab]:not(.hidden)');
  if (firstVisible) {
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.remove('active'));
    firstVisible.classList.add('active');
    ['aktiivisuus', 'kayttajat', 'csv', 'yllapito'].forEach(t =>
      el('admin-tab-' + t)?.classList.toggle('hidden', t !== firstVisible.dataset.adminTab)
    );
  }

  // Team selectors: admin sees all + "Kaikki"; coach-only sees only their teams
  const teamsForSelects = isAdmin ? TEAMS : coachTeams;
  populateAdminTeamSelect();
  populateAdminPortalSelects(teamsForSelects, isAdmin);
  if (isAdmin) { renderAdminTeamsList(); renderWeekPlanSection(); }

  show('admin-portal');
  document.body.style.overflow = 'hidden';

  if (isAdmin) {
    loadAdminUserListPortal();
    const reportSel = el('admin-report-team');
    if (reportSel) { reportSel.value = '__all__'; renderActivityReport('__all__'); }
  } else if (isCoach) {
    // Auto-load first coach team in activity report
    const reportSel = el('admin-report-team');
    if (reportSel && coachTeams[0]) {
      reportSel.value = coachTeams[0];
      renderActivityReport(coachTeams[0]);
    }
    // Populate CSV player list for first team
    const csvSel = el('admin-csv-team-portal');
    if (csvSel && coachTeams[0]) {
      csvSel.value = coachTeams[0];
      renderCsvPlayerList(coachTeams[0]);
    }
  }
}

function closeAdminPortal() {
  hide('admin-portal');
  document.body.style.overflow = '';
}

function populateAdminPortalSelects(teamsToShow = TEAMS, showAll = true) {
  ['admin-report-team', 'admin-csv-team-portal'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    // "Kaikki" option only for admins in the activity selector
    if (id === 'admin-report-team' && showAll) {
      const allOpt = document.createElement('option');
      allOpt.value = '__all__';
      allOpt.textContent = 'Kaikki';
      sel.appendChild(allOpt);
    }
    teamsToShow.forEach(team => {
      const opt = document.createElement('option');
      opt.value = team;
      opt.textContent = team;
      sel.appendChild(opt);
    });
  });
}

// ── Admin portal nav tabs ─────────────────────────────────────
document.querySelectorAll('[data-admin-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.adminTab;
    ['aktiivisuus', 'kayttajat', 'csv', 'yllapito'].forEach(t => {
      el('admin-tab-' + t).classList.toggle('hidden', t !== tab);
    });
    if (tab === 'kayttajat') loadAdminUserListPortal();
  });
});

// ── User list (portal) ────────────────────────────────────────
async function loadAdminUserListPortal(force = false) {
  const listEl = el('admin-user-list-portal');
  const stale  = Date.now() - cachedAdminUsersTs > ADMIN_USERS_TTL;
  try {
    if (!cachedAdminUsers || stale || force) {
      listEl.innerHTML = '<p class="loading">Ladataan käyttäjiä…</p>';
      const snap = await db.collection('users').get();
      if (snap.empty) { listEl.innerHTML = '<p class="loading">Ei käyttäjiä.</p>'; return; }
      cachedAdminUsers = snap.docs.map(doc => ({
        uid:     doc.id,
        profile: doc.data().profile || {},
        email:   doc.data().email   || '',
        coachOf: doc.data().coachOf  || [],
        recentCount: -1, // ladataan alla
      }));
      cachedAdminUsersTs = Date.now();

      // Hae 4 viikon treenilasku rinnakkain (border-väri = sama kuin act-status)
      const cutoff = firebase.firestore.Timestamp.fromDate(
        new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
      );
      await Promise.all(cachedAdminUsers.map(async u => {
        try {
          const es = await db.collection('users').doc(u.uid)
            .collection('entries').where('date', '>=', cutoff).get();
          u.recentCount = es.size;
        } catch (err) { console.error('recentCount fetch for', u.uid, ':', err); u.recentCount = -1; }
      }));
    }
    renderAdminUserListPortal();
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p class="loading">Lataus epäonnistui.</p>';
  }
}

function formatUserName(profile) {
  const parts = [];
  if (profile.firstName) parts.push(profile.firstName);
  if (profile.nickname)  parts.push(`"${profile.nickname}"`);
  if (profile.lastName)  parts.push(profile.lastName);
  return parts.join(' ') || null;
}

function renderAdminUserListPortal() {
  const listEl = el('admin-user-list-portal');

  // Muista mitkä valmentajapaneelit ovat auki ennen renderöintiä (kohta 10)
  const openPanels = new Set(
    [...document.querySelectorAll('.coach-panel:not(.hidden)')].map(p => {
      const m = p.id.match(/^coach-panel-(.+)$/);
      return m ? m[1] : null;
    }).filter(Boolean)
  );

  // Lajittele aakkosjärjestykseen suomeksi (kohta 6)
  const sorted = [...cachedAdminUsers].sort((a, b) => {
    const na = [a.profile.firstName, a.profile.lastName].filter(Boolean).join(' ').toLowerCase();
    const nb = [b.profile.firstName, b.profile.lastName].filter(Boolean).join(' ').toLowerCase();
    return na.localeCompare(nb, 'fi');
  });

  // "Päivitä lista" -nappi ylhäällä (kohta 2)
  const refreshRow = `<div class="admin-list-refresh-row">
    <span class="admin-list-count">${cachedAdminUsers.length} käyttäjää</span>
    <button class="btn-secondary admin-list-refresh-btn" onclick="loadAdminUserListPortal(true)">↻ Päivitä</button>
  </div>`;

  // Borderin väri = sama kuin act-status pallukka Aktiivisuus-välilehdellä
  const activityBorder = count => {
    if (count >= 2) return 'var(--blue)';   // act-status--active
    if (count === 1) return '#f59e0b';       // act-status--moderate
    if (count === 0) return '#ef4444';       // act-status--inactive
    return 'var(--border-light)';            // tuntematon (fetch epäonnistui)
  };

  const userAvatar = (profile, email, count) => {
    const initial     = (profile.firstName?.[0] || email?.[0] || '?').toUpperCase();
    const borderColor = activityBorder(count);
    const content     = profile.photoURL
      ? `<img src="${escapeHtml(profile.photoURL)}" alt="">`
      : escapeHtml(initial);
    return `<div class="admin-user-avatar" style="border:2px solid ${borderColor}">${content}</div>`;
  };

  listEl.innerHTML = refreshRow + sorted.map(u => {
    const displayName = formatUserName(u.profile);
    const email       = u.email || u.uid;
    const teams       = (u.profile.teams || (u.profile.team ? [u.profile.team] : [])).join(', ');
    const coachOf     = u.coachOf || [];

    // Row 1: name (+ teams if any)
    const namePart  = displayName ? escapeHtml(displayName) : '<em style="color:var(--text-muted)">—</em>';
    const teamsPart = teams ? ` <span class="admin-user-teams">${escapeHtml(teams)}</span>` : '';

    const coachBadge = coachOf.length > 0
      ? `<span class="coach-badge">Valmentaja: ${escapeHtml(coachOf.join(', '))}</span>`
      : '';
    const coachCheckboxes = TEAMS.map(team => `
      <label class="coach-team-check">
        <input type="checkbox"
               onchange="adminToggleCoach('${u.uid}', '${escapeHtml(team)}', this.checked)"
               ${coachOf.includes(team) ? 'checked' : ''}>
        <span>${escapeHtml(team)}</span>
      </label>`).join('');

    return `
      <div class="admin-user-item">
        ${userAvatar(u.profile, email, u.recentCount)}
        <div class="admin-user-main">
          <div class="admin-user-info">
            <span class="admin-user-name">${namePart}${teamsPart}</span>
            <span class="admin-user-email">${escapeHtml(email)}</span>
            ${coachBadge}
          </div>
          <div class="admin-user-actions">
            <button class="btn-sm btn-view-sm" onclick="startImpersonation('${u.uid}', '${escapeHtml(displayName || email)}', '${escapeHtml(email)}')">Avaa loki</button>
            <button class="btn-sm btn-coach-sm" onclick="toggleCoachPanel('${u.uid}')">Valmentaja</button>
            <button class="btn-sm btn-danger-sm" onclick="adminDeleteUser('${u.uid}', '${escapeHtml(email)}')">Poista</button>
          </div>
        </div>
        <div class="coach-panel hidden" id="coach-panel-${u.uid}">
          <p class="coach-panel-label">Valmentaja joukkueille:</p>
          ${coachCheckboxes}
        </div>
      </div>`;
  }).join('');

  // Palauta aiemmin avatut valmentajapaneelit (kohta 10)
  openPanels.forEach(uid => {
    const panel = el('coach-panel-' + uid);
    if (panel) panel.classList.remove('hidden');
  });
}

function toggleCoachPanel(uid) {
  const panel = el('coach-panel-' + uid);
  if (panel) panel.classList.toggle('hidden');
}

async function adminToggleCoach(uid, team, isCoach) {
  try {
    const updateVal = isCoach
      ? firebase.firestore.FieldValue.arrayUnion(team)
      : firebase.firestore.FieldValue.arrayRemove(team);
    await db.collection('users').doc(uid).update({ coachOf: updateVal });
    // Update local cache
    const user = cachedAdminUsers.find(u => u.uid === uid);
    if (user) {
      if (isCoach) {
        user.coachOf = [...new Set([...(user.coachOf || []), team])];
      } else {
        user.coachOf = (user.coachOf || []).filter(t => t !== team);
      }
      // Refresh badge in DOM
      const item = document.querySelector(`#coach-panel-${uid}`)?.closest('.admin-user-item');
      if (item) {
        const infoEl = item.querySelector('.admin-user-info');
        const existing = infoEl.querySelector('.coach-badge');
        if (existing) existing.remove();
        if (user.coachOf.length > 0) {
          const badge = document.createElement('span');
          badge.className = 'coach-badge';
          badge.textContent = 'Valmentaja: ' + user.coachOf.join(', ');
          infoEl.appendChild(badge);
        }
      }
    }
    toast(isCoach ? `${team}: valmentaja lisätty` : `${team}: valmentaja poistettu`, 'success');
  } catch (err) {
    console.error(err);
    toast('Virhe: ' + err.message, 'error');
  }
}

// ── Team management ───────────────────────────────────────────
function renderAdminTeamsList() {
  const listEl = el('admin-teams-list');
  if (!listEl) return;
  if (TEAMS.length === 0) {
    listEl.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">Ei joukkueita.</p>';
    return;
  }
  listEl.innerHTML = TEAMS.map(team => `
    <div class="admin-team-item">
      <span class="admin-team-name">${escapeHtml(team)}</span>
      <button class="admin-team-remove-btn" onclick="adminRemoveTeam('${escapeHtml(team)}')">Poista</button>
    </div>`).join('');
}

async function adminAddTeam() {
  const input = el('admin-new-team-input');
  const name  = (input?.value || '').trim();
  if (!name) { toast('Syötä joukkueen nimi.', 'error'); return; }
  if (TEAMS.includes(name)) { toast('Joukkue on jo olemassa.', 'error'); return; }
  TEAMS = [...TEAMS, name];
  await saveTeamsToFirestore();
  if (input) input.value = '';
  renderAdminTeamsList();
  populateAdminPortalSelects();
  populateAdminTeamSelect();
  toast('Joukkue lisätty.', 'success');
}

async function adminRemoveTeam(team) {
  const yes = await dangerConfirm(
    `Poistetaanko joukkue "${team}"?\n\nKäyttäjien joukkuejäsenyyksiä ei poisteta.`
  );
  if (!yes) return;
  TEAMS = TEAMS.filter(t => t !== team);
  await saveTeamsToFirestore();
  renderAdminTeamsList();
  populateAdminPortalSelects();
  populateAdminTeamSelect();
  toast('Joukkue poistettu.', 'success');
}

async function saveTeamsToFirestore() {
  await db.collection('settings').doc('app').set({ teams: TEAMS }, { merge: true });
  appSettingsLoaded = false; // pakota uudelleenlataus seuraavalla portaalin avauksella
}

// ── Activity report ───────────────────────────────────────────
el('admin-report-btn').addEventListener('click', async () => {
  const team = el('admin-report-team').value;
  if (!team) { toast('Valitse ensin joukkue.', 'error'); return; }
  // __all__ = näytä kaikki käyttäjät
  const btn = el('admin-report-btn');
  btn.disabled = true;
  btn.textContent = 'Ladataan…';
  try {
    await renderActivityReport(team);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lataa';
  }
});

async function renderActivityReport(team) {
  const container = el('admin-activity-report');
  container.innerHTML = '<p class="loading">Haetaan harjoitustietoja…</p>';

  if (!cachedAdminUsers) {
    const snap = await db.collection('users').get();
    cachedAdminUsers = snap.docs.map(d => ({
      uid: d.id, profile: d.data().profile || {}, email: d.data().email || '', coachOf: d.data().coachOf || [],
    }));
    cachedAdminUsersTs = Date.now();
  }

  const members = team === '__all__'
    ? cachedAdminUsers
    : cachedAdminUsers.filter(u => {
        const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
        return teams.includes(team);
      });

  if (members.length === 0) {
    container.innerHTML = '<p class="loading">Ei jäseniä joukkueessa.</p>';
    return;
  }

  // Last 12 weeks (reuse charts.js helpers — loaded before admin.js)
  const weeks  = getLastNWeeks(12);
  const cutoff = firebase.firestore.Timestamp.fromDate(weeks[0]);
  const now    = firebase.firestore.Timestamp.fromDate(new Date());

  // Fetch entries for all members in parallel
  const memberData = await Promise.all(members.map(async u => {
    const snap = await db.collection('users').doc(u.uid)
      .collection('entries')
      .where('date', '>=', cutoff)
      .where('date', '<=', now)
      .get();

    // Count per week
    const byWeek = {};
    weeks.forEach(w => { byWeek[w.getTime()] = 0; });

    let lastDate = null;
    snap.docs.forEach(d => {
      const date = d.data().date?.toDate?.() || new Date(d.data().date);
      const key  = getMondayOfWeek(date).getTime();
      if (key in byWeek) byWeek[key]++;
      if (!lastDate || date > lastDate) lastDate = date;
    });

    const counts = weeks.map(w => byWeek[w.getTime()]);
    const total12 = counts.reduce((s, v) => s + v, 0);
    const total8  = counts.slice(4).reduce((s, v) => s + v, 0);
    const total4  = counts.slice(8).reduce((s, v) => s + v, 0);

    return {
      name: [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid,
      counts,
      total4,
      total8,
      total12,
      lastDate,
    };
  }));

  // Sort: most active first
  memberData.sort((a, b) => b.total4 - a.total4 || b.total12 - a.total12);

  // Week label headers (dd.mm)
  const wHeaders = weeks.map(w =>
    w.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' })
  );

  const weekColor = n => {
    if (n === 0) return 'act-week-0';
    if (n === 1) return 'act-week-1';
    if (n === 2) return 'act-week-2';
    return 'act-week-3';
  };

  const statusClass = total4 => {
    if (total4 >= 2) return 'act-status--active';
    if (total4 >= 1) return 'act-status--moderate';
    return 'act-status--inactive';
  };

  const rows = memberData.map(m => {
    const squares = m.counts.map((n, i) =>
      `<div class="act-week-cell ${weekColor(n)}" title="${wHeaders[i]}: ${n} treeniä"></div>`
    ).join('');
    const lastStr = m.lastDate
      ? m.lastDate.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' })
      : '—';
    return `
      <div class="act-card">
        <div class="act-card-row1">
          <span class="act-status ${statusClass(m.total4)}"></span>
          <span class="act-player-name">${escapeHtml(m.name)}</span>
          <span class="act-last">${lastStr}</span>
          <span class="act-count-label">4vk <strong>${m.total4}</strong></span>
          <span class="act-count-label">8vk <strong>${m.total8}</strong></span>
          <span class="act-count-label">12vk <strong>${m.total12}</strong></span>
        </div>
        <div class="act-card-row2">
          <div class="act-weeks">${squares}</div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="act-card-list">${rows}</div>`;
}

// ── CSV (portal) ──────────────────────────────────────────────
el('admin-csv-team-btn-portal').addEventListener('click', async () => {
  const team = el('admin-csv-team-portal').value;
  if (!team) { toast('Valitse ensin joukkue.', 'error'); return; }
  const btn = el('admin-csv-team-btn-portal');
  btn.disabled = true; btn.textContent = 'Ladataan…';
  try {
    await adminExportTeamCsv(team);
    renderCsvPlayerList(team);
  } finally {
    btn.disabled = false; btn.textContent = 'Lataa CSV';
  }
});

// Update player list when team selector changes
el('admin-csv-team-portal').addEventListener('change', () => {
  const team = el('admin-csv-team-portal').value;
  if (team) renderCsvPlayerList(team);
});

async function renderCsvPlayerList(team) {
  const container = el('admin-csv-player-list');
  if (!container) return;

  // Ensure users are loaded
  if (!cachedAdminUsers) {
    container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">Ladataan…</p>';
    const snap = await db.collection('users').get();
    cachedAdminUsers = snap.docs.map(d => ({
      uid: d.id, profile: d.data().profile || {}, email: d.data().email || '', coachOf: d.data().coachOf || [],
    }));
    cachedAdminUsersTs = Date.now();
  }

  const members = team === '__ALL__'
    ? cachedAdminUsers
    : cachedAdminUsers.filter(u => {
        const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
        return teams.includes(team);
      });

  if (members.length === 0) {
    container.innerHTML = '<p style="font-size:0.85rem;color:var(--text-muted)">Ei pelaajia joukkueessa.</p>';
    return;
  }

  container.innerHTML = members.map(u => {
    const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid;
    return `
      <div class="csv-player-item">
        <span class="csv-player-name">${escapeHtml(name)}</span>
        <button class="btn-primary admin-csv-btn" onclick="adminExportPlayerCsv('${u.uid}', '${escapeHtml(name)}', this)">Lataa CSV</button>
      </div>`;
  }).join('');
}

// ── Legacy modal (kept for backward compat) ───────────────────
el('admin-panel-btn') // already wired above
el('close-admin').addEventListener('click', closeAdminModal);
el('admin-backdrop').addEventListener('click', closeAdminModal);

function openAdminModal() { /* legacy — now opens portal */ openAdminPortal(); }
function closeAdminModal() { hide('admin-modal'); document.body.style.overflow = ''; }

el('admin-csv-team-btn').addEventListener('click', async () => {
  const team = el('admin-csv-team').value;
  if (!team) { toast('Valitse ensin joukkue.', 'error'); return; }
  const btn = el('admin-csv-team-btn');
  btn.disabled = true; btn.textContent = 'Ladataan…';
  try { await adminExportTeamCsv(team); }
  finally { btn.disabled = false; btn.textContent = 'Lataa CSV'; }
});

async function adminExportTeamCsv(team) {
  if (!cachedAdminUsers) {
    const snap = await db.collection('users').get();
    cachedAdminUsers = snap.docs.map(d => ({
      uid: d.id, profile: d.data().profile || {}, email: d.data().email || '', coachOf: d.data().coachOf || [],
    }));
    cachedAdminUsersTs = Date.now();
  }
  const members = team === '__ALL__'
    ? cachedAdminUsers
    : cachedAdminUsers.filter(u => {
        const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
        return teams.includes(team);
      });

  if (members.length === 0) {
    toast(team === '__ALL__' ? 'Ei käyttäjiä.' : 'Ei jäseniä: ' + team, 'info');
    return;
  }

  const rows = [];
  await Promise.all(members.map(async u => {
    const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid;
    const eSnap = await db.collection('users').doc(u.uid).collection('entries')
      .orderBy('date', 'asc').get();
    eSnap.docs.forEach(d => rows.push({ playerName: name, ...d.data() }));
  }));

  rows.sort((a, b) => (a.date?.toMillis?.() || 0) - (b.date?.toMillis?.() || 0));
  const filename = team === '__ALL__'
    ? 'kaikki_pelaajat_harjoitukset.csv'
    : `${team.replace(/\s+/g, '_')}_harjoitukset.csv`;
  downloadCsv(rows, filename);
}

async function adminExportPlayerCsv(uid, playerName, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    const snap = await db.collection('users').doc(uid).collection('entries')
      .orderBy('date', 'asc').get();
    downloadCsv(snap.docs.map(d => ({ playerName, ...d.data() })),
      `${playerName.replace(/\s+/g, '_')}_harjoitukset.csv`);
  } finally { btn.disabled = false; btn.textContent = 'CSV'; }
}

function downloadCsv(rows, filename) {
  const PERF = ['', 'I – Peruskestävyys', 'II – Kestävyys', 'III – Vauhti', 'IV – Maksimi', 'V – Kilpailu'];
  const FEEL = ['', 'Erinomainen', 'Hyvä', 'Ok', 'Väsynyt', 'Todella väsynyt'];
  const headers = ['Pelaaja','Päivämäärä','Aktiviteetti','Kesto (min)','Tehoalue','Fiilis','Matka (km)','Keskisyke (bpm)','Maksimisyke (bpm)','Kommentti'];
  const esc = v => { if (v == null || v === '') return ''; const s = String(v); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s; };
  const lines = [headers.join(',')];
  rows.forEach(r => {
    lines.push([
      esc(r.playerName),
      esc(r.date?.toDate ? r.date.toDate().toLocaleDateString('fi-FI') : ''),
      esc(r.type), esc(r.duration),
      esc(r.performance ? PERF[r.performance] : ''),
      esc(r.feeling    ? FEEL[r.feeling]    : ''),
      esc(r.distance ?? ''), esc(r.avgHr ?? ''), esc(r.maxHr ?? ''), esc(r.comment ?? ''),
    ].join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

async function adminDeleteUser(uid, email) {
  const yes = await dangerConfirm(`Poistetaanko käyttäjä ${email} ja kaikki heidän harjoitustietonsa?`);
  if (!yes) return;
  try {
    await deleteAllUserData(uid);
    cachedAdminUsers = null;
    cachedAdminUsersTs = 0;
    await loadAdminUserListPortal();
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui: ' + err.message, 'error');
  }
}

// ── Reaction data migration ───────────────────────────────────
el('fix-reactions-btn').addEventListener('click', async () => {
  const btn = el('fix-reactions-btn');
  const log = el('fix-reactions-log');

  const yes = await dangerConfirm(
    'Korjataan reaktiodata?\n\n' +
    '• reactionCounts rakennetaan uudelleen reactions-alikollektiosta\n' +
    '• Jokaisen reaktorin myReactions kirjoitetaan heidän omaan käyttäjädokumenttiinsa',
    'Korjaa'
  );
  if (!yes) return;

  btn.disabled = true;
  btn.textContent = 'Korjataan…';
  log.innerHTML = '';

  const addLog = (msg, color) => {
    const div = document.createElement('div');
    div.textContent = msg;
    if (color) div.style.color = color;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  };

  try {
    addLog('Haetaan käyttäjät…');
    const usersSnap = await db.collection('users').get();

    // Kerätään jokaisen reaktorin reaktiot: { reactorUid: { "ownerUid_entryId": emoji } }
    const reactorMap = {};
    let totalEntries = 0, totalEntryFixed = 0, totalErrors = 0;

    for (const userDoc of usersSnap.docs) {
      const ownerUid = userDoc.id;
      const email    = userDoc.data().email || ownerUid;

      const entriesSnap = await db.collection('users').doc(ownerUid)
        .collection('entries').get();

      for (const entryDoc of entriesSnap.docs) {
        totalEntries++;
        const entry = entryDoc.data();

        // reactions-alikollektio on lähde totuudesta
        const reactionsSnap = await db.collection('users').doc(ownerUid)
          .collection('entries').doc(entryDoc.id)
          .collection('reactions').get();

        if (reactionsSnap.empty) continue;

        // Rakenna oikeat reactionCounts alikollektiosta
        const reactionCounts = {};
        reactionsSnap.docs.forEach(rDoc => {
          const reactorUid = rDoc.id;
          const emoji      = rDoc.data().emoji;
          if (!emoji) return;
          reactionCounts[emoji] = (reactionCounts[emoji] || 0) + 1;
          // Kerää reaktorin oma reaktio talteen omaan dokumenttiin kirjoitettavaksi
          if (!reactorMap[reactorUid]) reactorMap[reactorUid] = {};
          reactorMap[reactorUid][`${ownerUid}_${entryDoc.id}`] = emoji;
        });

        // Päivitä reactionCounts entryyn jos muuttunut
        const curCounts = entry.reactionCounts || {};
        if (JSON.stringify(reactionCounts) !== JSON.stringify(curCounts)) {
          try {
            await entryDoc.ref.update({ reactionCounts });
            totalEntryFixed++;
            addLog(`✓ ${email} · ${entryDoc.id.slice(0,8)}… — laskurit korjattu`, 'var(--green)');
          } catch (err) {
            totalErrors++;
            addLog(`✗ ${email} · ${entryDoc.id.slice(0,8)}… — ${err.message}`, 'var(--red)');
          }
        }
      }
    }

    // Kirjoita myReactions jokaisen reaktorin omaan dokumenttiin (admin-oikeus sallii tämän)
    addLog(`\nKirjoitetaan myReactions ${Object.keys(reactorMap).length} käyttäjälle…`);
    let reactorFixed = 0;
    for (const [reactorUid, reactions] of Object.entries(reactorMap)) {
      try {
        await db.collection('users').doc(reactorUid).update({ myReactions: reactions });
        reactorFixed++;
        addLog(`✓ reaktori ${reactorUid.slice(0,8)}… — ${Object.keys(reactions).length} reaktiota`, 'var(--green)');
      } catch (err) {
        totalErrors++;
        addLog(`✗ reaktori ${reactorUid.slice(0,8)}… — ${err.message}`, 'var(--red)');
      }
    }

    addLog(
      `\nValmis! Tarkistettu ${totalEntries} treeniä · korjattu ${totalEntryFixed} laskuria · ` +
      `myReactions päivitetty ${reactorFixed}/${Object.keys(reactorMap).length} käyttäjälle · virheitä ${totalErrors}.`,
      totalErrors > 0 ? 'var(--red)' : 'var(--green)'
    );

  } catch (err) {
    console.error('fixReactionData:', err);
    addLog('Kriittinen virhe: ' + err.message, 'var(--red)');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Korjaa reaktiodata';
  }
});

// ── Full JSON backup ──────────────────────────────────────────
el('backup-btn').addEventListener('click', async () => {
  const btn    = el('backup-btn');
  const status = el('backup-status');

  btn.disabled = true;
  btn.textContent = 'Ladataan…';
  status.textContent = '';

  try {
    status.textContent = 'Haetaan käyttäjät…';
    const usersSnap = await db.collection('users').get();
    const backup = {
      exportedAt: new Date().toISOString(),
      appVersion: document.querySelector('link[href*="styles.css"]')
        ?.getAttribute('href')?.match(/v=(\d+)/)?.[1] ?? '?',
      userCount:  usersSnap.size,
      users: [],
    };

    let entryCount = 0, reactionCount = 0;

    for (const userDoc of usersSnap.docs) {
      status.textContent = `Haetaan entryt: ${userDoc.data().email || userDoc.id}…`;

      const userData = {
        uid:     userDoc.id,
        ...userDoc.data(),
        entries: [],
      };

      // Entries + reactions subcollection
      const entriesSnap = await db.collection('users').doc(userDoc.id)
        .collection('entries').get();

      for (const entryDoc of entriesSnap.docs) {
        entryCount++;
        const entryData = { id: entryDoc.id, ...entryDoc.data() };

        // Convert Firestore Timestamps to ISO strings
        if (entryData.date?.toDate)      entryData.date      = entryData.date.toDate().toISOString();
        if (entryData.updatedAt?.toDate) entryData.updatedAt = entryData.updatedAt.toDate().toISOString();

        // Reactions subcollection
        const reactionsSnap = await db.collection('users').doc(userDoc.id)
          .collection('entries').doc(entryDoc.id)
          .collection('reactions').get();

        entryData.reactions = {};
        reactionsSnap.docs.forEach(r => {
          reactionCount++;
          const rd = r.data();
          entryData.reactions[r.id] = {
            emoji: rd.emoji,
            timestamp: rd.timestamp?.toDate?.()?.toISOString() ?? null,
          };
        });

        userData.entries.push(entryData);
      }

      backup.users.push(userData);
    }

    backup.entryCount    = entryCount;
    backup.reactionCount = reactionCount;

    // Download as JSON file
    const json     = JSON.stringify(backup, null, 2);
    const blob     = new Blob([json], { type: 'application/json' });
    const dateStr  = new Date().toISOString().slice(0, 10);
    const filename = `uwrdiary-backup-${dateStr}.json`;
    const a        = document.createElement('a');
    a.href         = URL.createObjectURL(blob);
    a.download     = filename;
    a.click();
    URL.revokeObjectURL(a.href);

    const sizeKb = Math.round(json.length / 1024);
    status.textContent =
      `✓ ${filename} ladattu — ${backup.userCount} käyttäjää, ` +
      `${entryCount} treeniä, ${reactionCount} reaktiota, ${sizeKb} KB`;
    status.style.color = 'var(--green)';

  } catch (err) {
    console.error('Backup error:', err);
    status.textContent = '✗ Virhe: ' + err.message;
    status.style.color = 'var(--red)';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lataa varmuuskopio';
  }
});

// ── Orphan reaction purge ─────────────────────────────────────
el('purge-orphan-reactions-btn').addEventListener('click', async () => {
  const btn = el('purge-orphan-reactions-btn');
  const log = el('purge-reactions-log');

  const yes = await dangerConfirm(
    'Korjataan reaktiodata poistamalla orporeaktiot?\n\n' +
    'Toiminto poistaa reaktiodokumentit joiden tekijää ei enää ole käyttäjissä ja korjaa reactionCounts.',
    'Korjaa'
  );
  if (!yes) return;

  btn.disabled = true;
  btn.textContent = 'Poistetaan…';
  log.innerHTML = '';

  const addLog = (msg, color) => {
    const div = document.createElement('div');
    div.textContent = msg;
    if (color) div.style.color = color;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  };

  try {
    // 1. Kerää kaikki nykyiset käyttäjä-UIdit
    addLog('Haetaan käyttäjät…');
    const usersSnap = await db.collection('users').get();
    const validUids = new Set(usersSnap.docs.map(d => d.id));
    addLog(`Löydettiin ${validUids.size} käyttäjää.`);

    let totalScanned = 0, totalDeleted = 0, totalFixed = 0, totalErrors = 0;

    // 2. Käy läpi jokaisen käyttäjän jokainen entry
    for (const userDoc of usersSnap.docs) {
      const ownerUid = userDoc.id;
      const email    = userDoc.data().email || ownerUid;

      const entriesSnap = await db.collection('users').doc(ownerUid)
        .collection('entries').get();

      for (const entryDoc of entriesSnap.docs) {
        const reactionsSnap = await db.collection('users').doc(ownerUid)
          .collection('entries').doc(entryDoc.id)
          .collection('reactions').get();

        if (reactionsSnap.empty) continue;
        totalScanned++;

        // 3. Etsi orporeaktiot (reactorUid ei löydy validUids:stä)
        const orphans = reactionsSnap.docs.filter(r => !validUids.has(r.id));
        if (orphans.length === 0) continue;

        // 4. Poista orporeaktiot ja laske jäljelle jäävät counts
        const remainingCounts = {};
        reactionsSnap.docs.forEach(r => {
          if (validUids.has(r.id) && r.data().emoji) {
            const e = r.data().emoji;
            remainingCounts[e] = (remainingCounts[e] || 0) + 1;
          }
        });

        try {
          const batch = db.batch();
          orphans.forEach(r => batch.delete(r.ref));
          batch.update(entryDoc.ref, { reactionCounts: remainingCounts });
          await batch.commit();

          totalDeleted += orphans.length;
          totalFixed++;
          const orphanUids = orphans.map(r => r.id.slice(0, 8) + '…').join(', ');
          addLog(
            `✓ ${email} · ${entryDoc.id.slice(0,8)}… — poistettu ${orphans.length} orphan (${orphanUids})`,
            'var(--green)'
          );
        } catch (err) {
          totalErrors++;
          addLog(`✗ ${email} · ${entryDoc.id.slice(0,8)}… — ${err.message}`, 'var(--red)');
        }
      }
    }

    addLog(
      `\nValmis! Tarkistettu ${totalScanned} treeniä reaktioineen · poistettu ${totalDeleted} orphania · ` +
      `korjattu ${totalFixed} entryn laskurit · virheitä ${totalErrors}.`,
      totalErrors > 0 ? 'var(--red)' : 'var(--green)'
    );

  } catch (err) {
    console.error('purgeOrphanReactions:', err);
    addLog('Kriittinen virhe: ' + err.message, 'var(--red)');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Poista orporeaktiot';
  }
});

// ── Viikkosuunnitelma ─────────────────────────────────────────
const ZONE_OPTIONS = ['I', 'I–II', 'II', 'II–III', 'III', 'III–IV', 'IV', 'I–V', 'V'];
let zonePicking = null; // { weekKey, weekNum }

function renderWeekPlanSection() {
  const container = el('admin-week-plan-list');
  if (!container) return;

  const today = new Date();
  // Tämän viikon maanantai
  const thisMon = new Date(today.getFullYear(), today.getMonth(),
    today.getDate() - ((today.getDay() + 6) % 7));

  const rows = [];
  for (let i = 0; i < 16; i++) {
    const monday = new Date(thisMon.getFullYear(), thisMon.getMonth(),
      thisMon.getDate() + i * 7);
    const { week, year } = calIsoWeekData(monday);
    const key = `${year}-W${String(week).padStart(2, '0')}`;

    // Käytä dynaamista suunnitelmaa, fallback kovakoodattuun
    let zone = '';
    if (key in dynamicWeekPlan) zone = dynamicWeekPlan[key] || '';
    else zone = WEEKLY_PLAN[year]?.[week] || '';

    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const fmt = d => `${d.getDate()}.${d.getMonth() + 1}.`;
    const isCurrent = i === 0;
    const source = (key in dynamicWeekPlan) ? 'custom' : (zone ? 'default' : 'none');

    rows.push(`
      <div class="week-plan-row${isCurrent ? ' week-plan-current' : ''}">
        <div class="week-plan-info">
          <span class="week-plan-num">Vk ${week}${isCurrent ? '<span class="week-plan-now"> ← nyt</span>' : ''}</span>
          <span class="week-plan-dates">${fmt(monday)}–${fmt(sunday)}${year}</span>
        </div>
        <div class="week-plan-zone-col">
          ${zone
            ? `<span class="week-plan-badge week-plan-${source}">${zone}</span>`
            : `<span class="week-plan-empty">—</span>`}
        </div>
        <button class="btn-secondary week-plan-edit-btn"
                onclick="openZonePicker('${key}', ${week}, '${zone}')">Muokkaa</button>
      </div>`);
  }

  container.innerHTML = rows.join('');
}

function openZonePicker(weekKey, weekNum, currentZone) {
  zonePicking = { weekKey, weekNum };
  el('zone-picker-title').textContent = `Viikko ${weekNum} — tehoalue`;

  el('zone-picker-buttons').innerHTML = ZONE_OPTIONS.map(z => `
    <button class="zone-opt-btn${z === currentZone ? ' active' : ''}"
            onclick="selectZone('${z}')">${z}</button>
  `).join('');

  el('zone-picker-clear').classList.toggle('hidden', !currentZone);

  el('zone-picker-backdrop').classList.remove('hidden');
  const sheet = el('zone-picker-sheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('sheet-open'));
}

function closeZonePicker() {
  const sheet = el('zone-picker-sheet');
  sheet.classList.remove('sheet-open');
  sheet.addEventListener('transitionend', () => {
    sheet.classList.add('hidden');
    el('zone-picker-backdrop').classList.add('hidden');
  }, { once: true });
  zonePicking = null;
}

async function selectZone(zone) {
  if (!zonePicking) return;
  dynamicWeekPlan[zonePicking.weekKey] = zone;
  closeZonePicker();
  await saveWeekPlanToFirestore();
  renderWeekPlanSection();
}

async function clearZone() {
  if (!zonePicking) return;
  // Poista dynaaminen arvo — palautuu kovakoodattuun jos sellainen on
  delete dynamicWeekPlan[zonePicking.weekKey];
  closeZonePicker();
  await saveWeekPlanToFirestore();
  renderWeekPlanSection();
}

async function saveWeekPlanToFirestore() {
  try {
    await db.collection('settings').doc('app').set({ weekPlan: dynamicWeekPlan }, { merge: true });
    appSettingsLoaded = false;  // pakota seuraava lataus lukemaan uudet arvot
    calLoadedForUid   = null;   // pakota kalenterin uudelleenpiirto
    toast('Suunnitelma tallennettu.', 'success');
  } catch (err) {
    console.error(err);
    toast('Tallennus epäonnistui.', 'error');
  }
}

// Expose for HTML onclick
window.adminExportPlayerCsv    = adminExportPlayerCsv;
window.adminDeleteUser         = adminDeleteUser;
window.startImpersonation      = startImpersonation;
window.stopImpersonation       = stopImpersonation;
window.toggleCoachPanel        = toggleCoachPanel;
window.adminToggleCoach        = adminToggleCoach;
window.adminAddTeam            = adminAddTeam;
window.adminRemoveTeam         = adminRemoveTeam;
window.renderCsvPlayerList     = renderCsvPlayerList;
window.loadAdminUserListPortal = loadAdminUserListPortal;
window.openZonePicker          = openZonePicker;
window.selectZone              = selectZone;
window.clearZone               = clearZone;
