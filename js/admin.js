// ============================================================
// ADMIN PORTAL
// ============================================================
let cachedAdminUsers   = null;
let cachedAdminUsersTs = 0;
const ADMIN_USERS_TTL  = 24 * 60 * 60 * 1000; // 24 h
const ADMIN_USERS_LS   = 'uppis_admin_users_';  // + uid

// ── Varmistaa että cachedAdminUsers on ladattu (LS → Firestore) ──
async function ensureAdminUsers(force = false) {
  const lsKey = ADMIN_USERS_LS + currentUser.uid;
  const stale  = Date.now() - cachedAdminUsersTs > ADMIN_USERS_TTL;

  if (cachedAdminUsers && !stale && !force) return; // in-memory tuore

  if (force) {
    try { localStorage.removeItem(lsKey); } catch {}
    cachedAdminUsers   = null;
    cachedAdminUsersTs = 0;
  }

  // Kokeile localStorage
  if (!cachedAdminUsers) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < ADMIN_USERS_TTL) {
          cachedAdminUsers   = parsed.data;
          cachedAdminUsersTs = parsed.ts;
          return;
        }
      }
    } catch {}
  }

  // Hae Firestoresta
  const snap = await db.collection('users').get();
  cachedAdminUsers = snap.docs.map(doc => ({
    uid:        doc.id,
    profile:    doc.data().profile || {},
    email:      doc.data().email   || '',
    coachOf:    doc.data().coachOf  || [],
    recentCount: -1,
  }));
  cachedAdminUsersTs = Date.now();

  // Hae 4 vk treenilasku rinnakkain (border-väriä varten)
  const cutoff = firebase.firestore.Timestamp.fromDate(
    new Date(Date.now() - 28 * 24 * 60 * 60 * 1000)
  );
  await Promise.all(cachedAdminUsers.map(async u => {
    try {
      // count()-aggregaatti: laskutetaan ~1 luku/1000 indeksimerkintää sen sijaan että
      // haettaisiin jokainen dokumentti (~95 % vähemmän lukuja). Jos SDK ei tue → catch → -1.
      const agg = await db.collection('users').doc(u.uid)
        .collection('entries').where('date', '>=', cutoff).count().get();
      u.recentCount = agg.data().count;
    } catch (err) { console.error('recentCount fetch for', u.uid, ':', err); u.recentCount = -1; }
  }));

  // Tallenna localStorage:een
  try {
    localStorage.setItem(lsKey, JSON.stringify({ ts: cachedAdminUsersTs, data: cachedAdminUsers }));
  } catch {}
}

// ── Impersonation ─────────────────────────────────────────────
function startImpersonation(uid, name, email) {
  // Haetaan joukkueet ja profiili välimuistista
  const userRecord = cachedAdminUsers?.find(u => u.uid === uid);
  const teams = userRecord?.profile?.teams || [];
  impersonating = { uid, name, email, teams, profile: userRecord?.profile || {} };
  calLoadedForUid = null; // pakota kalenterin lataus valitulle käyttäjälle
  // Nollaa profile-state-flagit (ennatyksetLoaded, testit jne.) jotta seuraava
  // profiilin avaus lataa impersonoidun pelaajan datan, ei näytä adminin cachea
  resetViewedProfileState();
  closeAdminPortal();

  // Näytä pelaajan kuva/nimikirjain profiili-ikonissa
  updateHeaderProfile(impersonating.profile);

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
  allChartEntries = []; // pakota chart-datan uudelleenhaku impersonoidulle käyttäjälle
  cachedTeamMemberEntries = {}; // ei vuoda adminin vertailudataa impersonoituun näkymään
  if (typeof resetAbsenceState === 'function') resetAbsenceState();
  loadEntries();
}

function stopImpersonation() {
  impersonating = null;
  calLoadedForUid = null; // pakota kalenterin uudelleenlataus omalle käyttäjälle
  resetViewedProfileState(); // nollaa testit/ennätykset → ei vuoda toisen pelaajan dataa omaan profiiliin
  el('impersonation-banner').classList.add('hidden');

  // Palauta oman käyttäjän kuva/nimikirjain
  updateHeaderProfile();

  // Restore FAB if on loki sub-tab
  const activeSub = document.querySelector('#treenit-sub-tabs .sub-tab.active')?.dataset.subtab;
  if (activeSub !== 'loki') el('add-btn').classList.add('hidden');
  else el('add-btn').classList.remove('hidden');

  // Avaa portaali ensin (käyttäjä näkee portaalin heti)
  openAdminPortal();

  // Lataa oma loki taustalla (ei blokkaa portaalin avautumista)
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  allChartEntries = []; // pakota chart-datan paluu omaan käyttäjään
  cachedTeamMemberEntries = {}; // ei vuoda impersonoidun pelaajan vertailudataa adminille
  if (typeof resetAbsenceState === 'function') resetAbsenceState();
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
  populateActivitySelect();
  if (isAdmin) { renderAdminTeamsList(); renderWeekPlanSection(); }

  show('admin-portal');
  document.body.style.overflow = 'hidden';

  if (isAdmin) {
    loadAdminUserListPortal();
    renderActivityReport('__all__'); // Aktiivisuus latautuu automaattisesti (ei joukkuevalintaa)
  } else if (isCoach) {
    // Auto-load first coach team in activity report
    if (coachTeams[0]) renderActivityReport(coachTeams[0]);
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

// Aktiivisuus-välilehden joukkuevalitsin: admin näkee "Kaikki pelaajat" + joukkueet,
// valmentaja vain omat joukkueensa. Oletus: admin → __all__, valmentaja → 1. joukkue.
function populateActivitySelect() {
  const sel = el('admin-report-team');
  if (!sel) return;
  const isAdmin = currentUser?.email === ADMIN_EMAIL;
  const teams = isAdmin ? TEAMS : (userProfile.coachOf || []);
  let html = isAdmin ? '<option value="__all__">Kaikki pelaajat</option>' : '';
  html += teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  sel.innerHTML = html;
  sel.value = isAdmin ? '__all__' : (teams[0] || '');
}

function populateAdminPortalSelects(teamsToShow = TEAMS, showAll = true) {
  ['admin-csv-team-portal'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    // "Kaikki" option VAIN adminille (showAll=isAdmin) → valmentaja ei pääse viemään
    // muiden joukkueiden dataa.
    const includeAll = showAll && id === 'admin-csv-team-portal';
    if (includeAll) {
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
    if (tab === 'yllapito' && typeof exportInitPanel === 'function') exportInitPanel();
  });
});

// ── User list (portal) ────────────────────────────────────────
async function loadAdminUserListPortal(force = false) {
  const listEl = el('admin-user-list-portal');
  const stale  = Date.now() - cachedAdminUsersTs > ADMIN_USERS_TTL;
  if (!cachedAdminUsers || stale || force)
    listEl.innerHTML = '<p class="loading">Ladataan käyttäjiä…</p>';
  try {
    await ensureAdminUsers(force);
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

  // "Päivitä lista" -rivi ylhäällä — tyylitelty kuten joukkuesivun toolbar
  const cacheTime = (() => {
    if (!cachedAdminUsersTs) return '';
    const d = new Date(cachedAdminUsersTs);
    return `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  })();
  const refreshRow = `<div class="admin-list-refresh-row">
    <span class="admin-list-count">${cachedAdminUsers.length} käyttäjää</span>
    <span class="joukkue-cache-ts" title="Datan ikä">${cacheTime}</span>
    <button class="refresh-btn" data-act="refresh-users" title="Päivitä lista" aria-label="Päivitä">↻</button>
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
               data-act="toggle-coach" data-uid="${escapeHtml(u.uid)}" data-team="${escapeHtml(team)}"
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
            <button class="btn-sm btn-view-sm" data-act="impersonate" data-uid="${escapeHtml(u.uid)}" data-name="${escapeHtml(displayName || email)}" data-email="${escapeHtml(email)}">Avaa loki</button>
            <button class="btn-sm btn-coach-sm" data-act="toggle-coach-panel" data-uid="${escapeHtml(u.uid)}">Valmentaja</button>
            <button class="btn-sm btn-danger-sm" data-act="delete-user" data-uid="${escapeHtml(u.uid)}" data-email="${escapeHtml(email)}">Poista</button>
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
    // Päivitä myös LS-cache jotta seuraava sivulataus ei lataa vanhentunutta dataa
    try {
      const lsKey = ADMIN_USERS_LS + currentUser.uid;
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        const entry = parsed.data?.find(u => u.uid === uid);
        if (entry) {
          entry.coachOf = user ? user.coachOf : (isCoach ? [team] : []);
          localStorage.setItem(lsKey, JSON.stringify(parsed));
        }
      }
    } catch {}
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
      <button class="admin-team-remove-btn" data-act="remove-team" data-team="${escapeHtml(team)}">Poista</button>
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
  populateActivitySelect();
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
  populateActivitySelect();
  populateAdminTeamSelect();
  toast('Joukkue poistettu.', 'success');
}

async function saveTeamsToFirestore() {
  await db.collection('settings').doc('app').set({ teams: TEAMS }, { merge: true });
  appSettingsLoaded = false; // pakota uudelleenlataus seuraavalla portaalin avauksella
}

// ── Activity report ───────────────────────────────────────────
// Joukkuevalinta: oletus "Kaikki pelaajat" (__all__), raportti latautuu valinnan mukaan.
el('admin-report-team')?.addEventListener('change', () => {
  const team = el('admin-report-team').value;
  if (team) renderActivityReport(team);
});

// Selite piiloon oletuksena, avautuu napista.
el('act-legend-toggle')?.addEventListener('click', () => {
  el('act-legend-body')?.classList.toggle('hidden');
});

const ACT_REPORT_TTL = 60 * 60 * 1000; // 1 h

async function renderActivityReport(team, force = false) {
  const container = el('admin-activity-report');
  container.innerHTML = '<p class="loading">Haetaan harjoitustietoja…</p>';

  await ensureAdminUsers();

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

  // ── Cache ──
  const actCacheKey = `uppis_act2_${currentUser.uid}_${team}_${weeks[0].getTime()}`;
  if (!force) {
    try {
      const raw = localStorage.getItem(actCacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < ACT_REPORT_TTL) {
          renderActivityReportHtml(container, parsed.data, weeks);
          return;
        }
      }
    } catch {}
  }

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
      uid:   u.uid,
      email: u.email || '',
      name: [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid,
      counts,
      total4,
      total8,
      total12,
      lastDate: lastDate ? lastDate.getTime() : null,
    };
  }));

  // Save to cache
  try {
    localStorage.setItem(actCacheKey, JSON.stringify({ ts: Date.now(), data: memberData }));
  } catch {}

  renderActivityReportHtml(container, memberData, weeks);
}

// Aktiivisuusluokka — perustuu VAIN 4 edelliseen VALMISTUNEESEEN viikkoon
// (kuluva/keskeneräinen viikko = counts:n viimeinen indeksi jätetään pois):
//  - inactive: ei yhtään treeniä näinä 4 viikkona
//  - active:   ainakin yksi treeni JOKAISENA näinä 4 viikkona
//  - moderate: jotain siltä väliltä
function activityGroup(m) {
  const completed4 = m.counts.slice(-5, -1); // indeksit 7–10 = 4 edellistä valmista viikkoa
  const sum = completed4.reduce((s, n) => s + n, 0);
  if (sum === 0) return 'inactive';
  return (completed4.length === 4 && completed4.every(n => n >= 1)) ? 'active' : 'moderate';
}

function renderActivityReportHtml(container, memberData, weeks) {
  // Restore lastDate if stored as timestamp number
  memberData.forEach(m => {
    if (m.lastDate && typeof m.lastDate === 'number') m.lastDate = new Date(m.lastDate);
  });

  // Sort: most active first
  memberData.sort((a, b) => b.total4 - a.total4 || b.total12 - a.total12);

  // Yhteenveto-hero ylös
  renderActivityHero(memberData);

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

  const cardHtml = (m, group) => {
    const squares = m.counts.map((n, i) =>
      `<div class="act-week-cell ${weekColor(n)}" title="${wHeaders[i]}: ${n} treeniä"></div>`
    ).join('');
    const lastStr = m.lastDate
      ? `viimeksi ${m.lastDate.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' })}`
      : 'ei treenejä';
    return `
      <div class="act-card act-card--${group}">
        <div class="act-card-row1">
          <span class="act-player-name">${escapeHtml(m.name)}</span>
          <span class="act-last">${lastStr}</span>
        </div>
        <div class="act-weeks">${squares}</div>
        <div class="act-pills">
          <span class="act-pill">4 vk · <strong>${m.total4}</strong></span>
          <span class="act-pill">8 vk · <strong>${m.total8}</strong></span>
          <span class="act-pill">12 vk · <strong>${m.total12}</strong></span>
          ${m.uid ? `<button class="btn-sm btn-view-sm act-open-loki" data-act="impersonate" data-uid="${escapeHtml(m.uid)}" data-name="${escapeHtml(m.name)}" data-email="${escapeHtml(m.email || '')}">Avaa loki</button>` : ''}
        </div>
      </div>`;
  };

  // Ryhmittele
  const byGroup = { active: [], moderate: [], inactive: [] };
  memberData.forEach(m => byGroup[activityGroup(m)].push(m));

  const GROUPS = [
    { key: 'active',   title: 'Aktiiviset' },
    { key: 'moderate', title: 'Kohtalaiset' },
    { key: 'inactive', title: 'Ei aktiiviset' },
  ];

  const html = GROUPS.map(g => {
    const list = byGroup[g.key];
    if (!list.length) return '';
    const n = list.length;
    return `
      <div class="act-group">
        <div class="act-group-header">
          <span class="act-status act-status--${g.key}"></span>
          <span class="act-group-title">${g.title}</span>
          <span class="act-group-count">${n} pelaaja${n === 1 ? '' : 'a'}</span>
        </div>
        <div class="act-card-list">${list.map(m => cardHtml(m, g.key)).join('')}</div>
      </div>`;
  }).join('');

  container.innerHTML = html || '<p class="loading">Ei pelaajia.</p>';
}

// Yhteenveto-hero: aktiiviset/kohtalaiset/ei-aktiiviset + keskiarvo + kolmiosainen palkki
function renderActivityHero(memberData) {
  const host = el('admin-activity-hero');
  if (!host) return;

  const total = memberData.length;
  const activeCount = memberData.filter(m => activityGroup(m) === 'active').length;
  const moderate    = memberData.filter(m => activityGroup(m) === 'moderate').length;
  const inactive    = memberData.filter(m => activityGroup(m) === 'inactive').length;
  const avgPerWeek  = total
    ? (memberData.reduce((s, m) => s + m.total4, 0) / total / 4).toFixed(1).replace('.', ',')
    : '0,0';
  const pct = n => (total ? Math.max(4, Math.round(n / total * 100)) : 0);

  host.innerHTML = `
    <div class="act-hero-label">PELAAJIEN AKTIIVISUUS · 4 VK</div>
    <div class="act-hero-stats">
      <div class="act-hero-main">
        <span class="act-hero-num">${activeCount}<small>/${total}</small></span>
        <span class="act-hero-sub">aktiivista pelaajaa</span>
      </div>
      <div class="act-hero-side">
        <span class="act-hero-num act-hero-num--sm">${avgPerWeek}</span>
        <span class="act-hero-sub">treeniä / vk keskiarvo</span>
      </div>
    </div>
    <div class="act-hero-bar">
      <div class="act-hero-bar-seg act-hero-bar-seg--active" style="flex:${pct(activeCount)}"></div>
      <div class="act-hero-bar-seg act-hero-bar-seg--moderate" style="flex:${pct(moderate)}"></div>
      <div class="act-hero-bar-seg act-hero-bar-seg--inactive" style="flex:${pct(inactive)}"></div>
    </div>`;
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

  await ensureAdminUsers();

  const members = team === '__all__'
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
        <button class="btn-primary admin-csv-btn" data-act="export-csv" data-uid="${escapeHtml(u.uid)}" data-name="${escapeHtml(name)}">Lataa CSV</button>
      </div>`;
  }).join('');
}

// ── Event delegation (korvaa inline onclick/onchange — XSS-suojaus) ──
// Käyttäjän nimet/sähköpostit luetaan data-attribuuteista .dataset:in kautta,
// jolloin niitä ei koskaan tulkita JS-koodina (vrt. vanha inline-onclick).
// Kuuntelijat kiinnitetään pysyviin containereihin → kestävät innerHTML-uudelleenrenderöinnin.
(function initAdminDelegation() {
  const onClick = (containerId, handler) => {
    const c = el(containerId);
    if (c) c.addEventListener('click', e => {
      const btn = e.target.closest('[data-act]');
      if (btn && c.contains(btn)) handler(btn.dataset.act, btn);
    });
  };

  // Käyttäjälista: klikkaukset
  onClick('admin-user-list-portal', (act, btn) => {
    const d = btn.dataset;
    if (act === 'refresh-users')      loadAdminUserListPortal(true);
    else if (act === 'impersonate')   startImpersonation(d.uid, d.name, d.email);
    else if (act === 'toggle-coach-panel') toggleCoachPanel(d.uid);
    else if (act === 'delete-user')   adminDeleteUser(d.uid, d.email);
  });
  // Käyttäjälista: valmentaja-checkboxit (change)
  const userList = el('admin-user-list-portal');
  if (userList) userList.addEventListener('change', e => {
    const cb = e.target.closest('[data-act="toggle-coach"]');
    if (cb) adminToggleCoach(cb.dataset.uid, cb.dataset.team, cb.checked);
  });

  // Joukkueiden hallinta
  onClick('admin-teams-list', (act, btn) => {
    if (act === 'remove-team') adminRemoveTeam(btn.dataset.team);
  });

  // CSV-pelaajalista
  onClick('admin-csv-player-list', (act, btn) => {
    if (act === 'export-csv') adminExportPlayerCsv(btn.dataset.uid, btn.dataset.name, btn);
  });

  // Aktiivisuus-tiilet: "Avaa loki" → impersonointi (sama kuin käyttäjälistalla)
  onClick('admin-activity-report', (act, btn) => {
    if (act === 'impersonate') startImpersonation(btn.dataset.uid, btn.dataset.name, btn.dataset.email);
  });

  // Viikkosuunnitelma
  onClick('admin-week-plan-list', (act, btn) => {
    if (act === 'edit-zone')  openZonePicker(btn.dataset.key, Number(btn.dataset.week), btn.dataset.zone);
    if (act === 'edit-voima') openVoimaPicker(btn.dataset.key, Number(btn.dataset.week), btn.dataset.voima);
  });

  // Tehoaluevalitsin
  onClick('zone-picker-buttons', (act, btn) => {
    if (act === 'select-zone') selectZone(btn.dataset.zone);
  });
})();

// ── Legacy modal (kept for backward compat) ───────────────────
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
  await ensureAdminUsers();
  const members = team === '__all__'
    ? cachedAdminUsers
    : cachedAdminUsers.filter(u => {
        const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
        return teams.includes(team);
      });

  if (members.length === 0) {
    toast(team === '__all__' ? 'Ei käyttäjiä.' : 'Ei jäseniä: ' + team, 'info');
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
  const filename = team === '__all__'
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
  const PERF = ['', 'I – Peruskunto', 'II – Kestävyys', 'III – Maksimikestävyys', 'IV – Nopeuskestävyys', 'V – Nopeus'];
  const FEEL = ['', 'Erittäin väsynyt', 'Väsynyt', 'Normaali', 'Hyvä', 'Erinomainen'];
  const headers = ['Pelaaja','Päivämäärä','Aktiviteetti','Kesto (min)','Tehoalue','Fiilis','Matka (km)','Keskisyke (bpm)','Maksimisyke (bpm)','Kommentti'];
  const esc = v => {
    if (v == null || v === '') return '';
    let s = String(v);
    // Estä CSV-kaavainjektio: =+-@ -alkuiset solut suoritetaan kaavana Excelissä → prefiksoi heittomerkillä
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  };
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
    try { localStorage.removeItem(ADMIN_USERS_LS + currentUser.uid); } catch {}
    cachedAdminUsers   = null;
    cachedAdminUsersTs = 0;
    await loadAdminUserListPortal();
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui: ' + err.message, 'error');
  }
}

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

// ── Viikkosuunnitelma ─────────────────────────────────────────
const ZONE_OPTIONS = ['I', 'I–II', 'II', 'II–III', 'III', 'III–IV', 'IV', 'I–V', 'V'];
let zonePicking = null; // { weekKey, weekNum, mode: 'zone' | 'voima' }

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

    // Tehoalue: dynaaminen suunnitelma → kovakoodattu
    let zone = '';
    if (key in dynamicWeekPlan) zone = dynamicWeekPlan[key] || '';
    else zone = WEEKLY_PLAN[year]?.[week] || '';
    const zoneSource = (key in dynamicWeekPlan) ? 'custom' : (zone ? 'default' : 'none');

    // Voimaviikko: dynaaminen → kovakoodattu → johdettu tehoalueesta
    let voima = '';
    if (key in dynamicVoimaPlan) voima = dynamicVoimaPlan[key] || '';
    else voima = (VOIMA_PLAN[year]?.[week]) || deriveVoimaFromZone(zone) || '';
    const voimaSource = (key in dynamicVoimaPlan) ? 'custom' : (voima ? 'default' : 'none');

    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const fmt = d => `${d.getDate()}.${d.getMonth() + 1}.`;
    const isCurrent = i === 0;

    const ctrl = (label, val, src, act, dataAttr) => `
      <div class="week-plan-ctrl">
        <span class="week-plan-ctrl-label">${label}</span>
        ${val
          ? `<span class="week-plan-badge week-plan-${src}">${escapeHtml(val)}</span>`
          : `<span class="week-plan-empty">—</span>`}
        <button class="btn-secondary week-plan-edit-btn"
                data-act="${act}" data-key="${escapeHtml(key)}" data-week="${week}" ${dataAttr}>Muokkaa</button>
      </div>`;

    rows.push(`
      <div class="week-plan-row${isCurrent ? ' week-plan-current' : ''}">
        <div class="week-plan-info">
          <span class="week-plan-num">Vk ${week}${isCurrent ? '<span class="week-plan-now"> ← nyt</span>' : ''}</span>
          <span class="week-plan-dates">${fmt(monday)}–${fmt(sunday)}${year}</span>
        </div>
        <div class="week-plan-controls">
          ${ctrl('Tehoalue', zone, zoneSource, 'edit-zone', `data-zone="${escapeHtml(zone)}"`)}
          ${ctrl('Voimaviikko', voima, voimaSource, 'edit-voima', `data-voima="${escapeHtml(voima)}"`)}
        </div>
      </div>`);
  }

  container.innerHTML = rows.join('');
}

function openZonePicker(weekKey, weekNum, currentZone) {
  _openPlanPicker('zone', weekKey, weekNum, currentZone);
}
function openVoimaPicker(weekKey, weekNum, currentVoima) {
  _openPlanPicker('voima', weekKey, weekNum, currentVoima);
}

function _openPlanPicker(mode, weekKey, weekNum, current) {
  zonePicking = { weekKey, weekNum, mode };
  const opts  = mode === 'voima' ? VOIMA_OPTIONS : ZONE_OPTIONS;
  el('zone-picker-title').textContent =
    `Viikko ${weekNum} — ${mode === 'voima' ? 'voimaviikko' : 'tehoalue'}`;

  el('zone-picker-buttons').innerHTML = opts.map(z => `
    <button class="zone-opt-btn${z === current ? ' active' : ''}"
            data-act="select-zone" data-zone="${escapeHtml(z)}">${escapeHtml(z)}</button>
  `).join('');

  el('zone-picker-clear').classList.toggle('hidden', !current);

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

async function selectZone(val) {
  if (!zonePicking) return;
  const { weekKey, mode } = zonePicking;
  if (mode === 'voima') dynamicVoimaPlan[weekKey] = val;
  else dynamicWeekPlan[weekKey] = val;
  closeZonePicker();
  await saveWeekPlanToFirestore();
  renderWeekPlanSection();
}

async function clearZone() {
  if (!zonePicking) return;
  const { weekKey, mode } = zonePicking;
  // Poista dynaaminen arvo — palautuu kovakoodattuun / johdettuun jos sellainen on
  if (mode === 'voima') delete dynamicVoimaPlan[weekKey];
  else delete dynamicWeekPlan[weekKey];
  closeZonePicker();
  await saveWeekPlanToFirestore();
  renderWeekPlanSection();
}

async function saveWeekPlanToFirestore() {
  try {
    await db.collection('settings').doc('app')
      .set({ weekPlan: dynamicWeekPlan, voimaPlan: dynamicVoimaPlan }, { merge: true });
    appSettingsLoaded = false;  // pakota seuraava lataus lukemaan uudet arvot
    calLoadedForUid   = null;   // pakota kalenterin uudelleenpiirto
    toast('Suunnitelma tallennettu.', 'success');
  } catch (err) {
    console.error(err);
    toast('Tallennus epäonnistui.', 'error');
  }
}

// ============================================================
// VIIKKO-OHJE — viikoittainen valmentajan ohjeistus (vain admin)
// ============================================================

const _ZONE_DATA = {
  1: {
    name: 'Peruskunto',
    intro: 'Tällä viikolla teemana on <strong>peruskunto</strong>, eli tavoitteena on <strong>kevyt aerobinen harjoittelu</strong>. Kerätään aerobista pohjaa matalalla intensiteetillä – syke rauhallisena, happoja ei tule. Palauttavat viikot ovat yhtä tärkeitä kuin kovat: keho kehittyy levossa.',
    sections: [
      {
        title: 'Peruskuntotreeni (I-alue)',
        subtitle: 'Syke 50–70 % maksimista, kaikki viikon harjoitukset',
        items: [
          '✅ Kevyt uinti rauhallisella tahdilla',
          '✅ Rauhallinen pyöräily tai hölkkä',
          '✅ Kävely tai vesijuoksu',
          '✅ Liikkuvuus ja kehonhuolto',
          '✅ Kevyt saliharjoittelu',
        ],
        postText: 'Myös pk-alueella voi lisätä muutaman alle 10 s räjähtävän spurtin hyvän lämmittelyn jälkeen – se pitää hermoston virkeänä.',
      },
    ],
  },
  2: {
    name: 'Kestävyys',
    intro: 'Tällä viikolla teemana on <strong>kestävyys</strong>, eli tavoitteena on <strong>3–4 pitkähköä, tasaista harjoitusta</strong>. Syke on hieman pk-aluetta ylempänä, mutta puhe onnistuu vielä.',
    sections: [
      {
        title: 'Kestävyysharjoitus (II-alue)',
        subtitle: 'Syke 60–75 % maksimista, 3–4 harjoitusta viikossa',
        items: [
          '✅ Uinti: pitkiä tasaisia vetoja (esim. 1500–2000 m)',
          '✅ Pyöräily tai juoksu: 40–60 min tasaisella sykkeellä',
          '✅ Hiihto, soutu tai crosstrainer',
          '✅ Pitkä lenkki tai vaellus',
        ],
        postText: 'Kestävyysviikon harjoitukset voivat tuntua helpoilta, mutta niiden kumulatiivinen vaikutus on suuri. Pidä intensiteetti kurissa – ei ylikierroksille.',
      },
    ],
  },
  3: {
    name: 'Maksimikestävyys',
    intro: 'Tällä viikolla teemana on <strong>maksimikestävyys</strong>, eli tavoitteena on tehdä <strong>2–3 III-alueen harjoitusta</strong>. Tarjolla on siis suhteellisen pitkiä (2–5 min) kovia vetoja melko lyhyillä palautuksilla (30 s–1 min). Uinti on yksi helpoimmista tavoista osua III-alueelle. Harjoitukset kehittävät maitohapon sietokykyä ja työntävät suorituskyvyn ylärajaa eteenpäin.',
    sections: [
      {
        title: 'Maksimikestävyys (III-alue)',
        subtitle: 'Syke 80–90 % maksimista, 2–3 harjoitusta viikossa',
        preText: 'Alla esimerkkejä pääsarjoista. Rinnalla voi olla myös toinen samantyyppinen tai hieman kevennetty sarja.',
        items: [
          '✅ Uinti: 5 × 200 m kovaa, 30 s palautuksella',
          '✅ Juoksu / pyöräily: 4 × 5 min kovaa, 1 min palautuksella',
          '✅ Ylämäki-/porrastreeni: 5 × 2 min nousua kovilla sykkeillä',
        ],
        postText: 'Muut viikon treenit voivat olla palauttavia pk-alueen harjoituksia tai salitreenejä. Tahdita raskaampia päiviä palauttavien harjoitusten kanssa, jotta voit tehdä kovat treenit aidosti kovalla teholla.',
      },
      {
        title: 'Peruskuntotreeni (I-alue)',
        subtitle: 'Syke 50–70 % maksimista, palauttavat harjoitukset välipäivinä',
        items: [
          '✅ Kevyt uinti',
          '✅ Rauhallinen pyöräily',
          '✅ Kävely tai kevyt hölkkä',
          '✅ Liikkuvuus ja kehonhuolto',
        ],
      },
    ],
  },
  4: {
    name: 'Nopeuskestävyys',
    intro: 'Tällä viikolla teemana on <strong>nopeuskestävyys</strong>, eli tavoitteena on tehdä <strong>2–3 IV-alueen harjoitusta</strong>. Painotus on siis lyhyissä erittäin kovissa 30–50 s suorituksissa melko lyhyillä palautuksilla (esim. 30 s). Pelinomaisen uppopallon lisäksi uinti on yksi helpoimmista tavoista osua IV-alueelle. Harjoitukset kehittävät kykyä toistaa kovia uppopallo-vaihdon mittaisia suorituksia ja palautua niistä nopeasti.',
    sections: [
      {
        title: 'Nopeuskestävyys (IV-alue)',
        subtitle: 'Syke 90–100 % maksimista, 2–3 harjoitusta viikossa',
        preText: 'Alla esimerkkejä pääsarjoista. Rinnalla voi olla myös useampi samantyyppinen tai hieman kevennetty sarja.',
        items: [
          '✅ Uinti: 10 × 25 m sukellus + 25 m uinti lähes täysillä, 30 s palautus',
          '✅ Juoksu: 2 × 4 × 100 m loivahkoon ylämäkeen kiihdyttäen 80–100 %, kävely takaisin, sarjojen välissä palauttavaa',
          '✅ Porrastreeni: 6–8 × 30–40 s täysillä, palautuksena kävely alas',
        ],
        postText: 'Muut viikon treenit voivat olla palauttavia pk-alueen harjoituksia tai salitreenejä. Tahdita raskaampia päiviä palauttavien harjoitusten kanssa, jotta voit tehdä kovat treenit aidosti kovalla teholla.',
      },
      {
        title: 'Peruskuntotreeni (I-alue)',
        subtitle: 'Syke 50–70 % maksimista, palauttavat harjoitukset välipäivinä',
        items: [
          '✅ Kevyt uinti',
          '✅ Rauhallinen pyöräily',
          '✅ Kävely tai kevyt hölkkä',
          '✅ Liikkuvuus ja kehonhuolto',
        ],
      },
    ],
  },
  // Yhdistelmä I–II (peruskunto + kestävyys). String-avain käytetään ennen yksittäistä
  // numeroa _viikkoohjeZoneHtml-resolverissa.
  'I–II': {
    name: 'Peruskunto / Kestävyys',
    intro: 'Tällä viikolla teemana on peruskunto ja kestävyys. Viikon ydin on rauhallinen, aerobinen pohjatyö. I-alueen harjoitukset tukevat palautumista ja rakentavat kestävyyspohjaa, josta kaikki kovempi harjoittelu ammentaa. II-alueen reippaammat treenit täydentävät viikkoa sopivan vireyden mukaan, mutta peruskunto on pääosassa.',
    sections: [
      {
        title: 'Peruskuntotreeni (I-alue)',
        subtitle: 'Syke 50–70 % maksimista',
        preText: 'Rauhallista, pitkäkestoista tekemistä. Syke pysyy hallinnassa. Tukee palautumista ja rakentaa aerobista pohjaa.\n\nAlla esimerkkejä I-alueen treeneistä:',
        items: [
          '✅ Kevyt uinti',
          '✅ Rauhallinen pyöräily',
          '✅ Kävely tai kevyt hölkkä',
          '✅ Liikkuvuus ja kehonhuolto',
        ],
      },
      {
        title: 'Kestävyystreeni (II-alue)',
        subtitle: 'Syke 60–80 % maksimista',
        preText: 'Yhtäjaksoista tai pidempinä vetoina tehtävää reipasta tekemistä. Syke nousee selvästi peruskuntoaluetta korkeammalle, mutta tekeminen pysyy hallittuna ja maitohapot eivät pysäytä tekemistä. Tämä kehittää kykyä tehdä pitkäkestoista suorituksia ja palautua kuormituksesta.\n\nAlla esimerkkejä II-alueen treeneistä:',
        items: [
          '✅ Uinti: pääsarja esim. 4 × 400 m (potkuja ja uintia vuorotellen reippaalla vauhdilla), 1–2 min palautus',
          '✅ Juoksu / pyöräily / melonta: vähintään 35–45 min yhtämittainen reipas lenkki tasaisella teholla',
        ],
      },
    ],
  },
  5: {
    name: 'Nopeus',
    intro: 'Tällä viikolla teemana on <strong>nopeus</strong>, eli <strong>räjähtäviä alle 10 sekunnin maksimisuorituksia</strong> erittäin pitkillä palautuksilla. Tavoitteena on <strong>1–2 laadukasta harjoitusta</strong>. Lepoa enemmän kuin normaalisti – hermosto on etusijalla.',
    sections: [
      {
        title: 'Nopeusharjoitus (V-alue)',
        subtitle: '1–2 harjoitusta viikossa, palautukset 5–10 min',
        preText: 'Alla esimerkkejä pääsarjoista.',
        items: [
          '✅ Uinti: 6–8 × 25 m täysin kovaa, 5 min palautuksella',
          '✅ Juoksu: 8–10 × 50–100 m sprinttejä, täyspalautus',
          '✅ Räjähtävät hyppelyt tai suunnanvaihdot, lyhyet sarjat',
        ],
        postText: 'V-alueen harjoituksia ei koskaan väsyneenä. Loput viikon harjoituksista ovat kevyttä pk-työtä tai kokonaan lepoa.',
      },
      {
        title: 'Peruskuntotreeni (I-alue)',
        subtitle: 'Lepoa tai kevyttä liikettä välipäivinä',
        items: [
          '✅ Kevyt uinti tai liikkuvuusharjoittelu',
          '✅ Rauhallinen kävely',
        ],
      },
    ],
  },
};

function _viikkoohjeZoneHtml(zoneStr) {
  const zones = typeof parseZoneStr === 'function' ? parseZoneStr(zoneStr) : [];
  const primaryIdx = zones.length ? Math.max(...zones) : 0;
  const data = _ZONE_DATA[zoneStr] || _ZONE_DATA[primaryIdx];
  if (!data) return `<p>Ei sisältöä tehoalueelle ${escapeHtml(zoneStr)}.</p>`;

  const _para = txt => txt.split('\n\n').map(p => `<p>${escapeHtml(p)}</p>`).join('');
  const sectionsHtml = data.sections.map(s => {
    const subtitleHtml = s.subtitle  ? `<p class="viikkoohje-subtitle">${escapeHtml(s.subtitle)}</p>` : '';
    const preHtml      = s.preText   ? _para(s.preText)   : '';
    const postHtml     = s.postText  ? _para(s.postText)  : '';
    const itemsHtml    = s.items.length
      ? `<ul>${s.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
    return `<h4>${escapeHtml(s.title)}</h4>${subtitleHtml}${preHtml}${itemsHtml}${postHtml}`;
  }).join('');

  // intro voi sisältää <strong>-tageja — sisältö on kovakoodattu, ei käyttäjädataa
  return `<p>${data.intro}</p>${sectionsHtml}`;
}

// ─── Voimaviikon ohjeistus ────────────────────────────────────
const _VOIMA_DATA = {
  'Haltuunotto': {
    label: 'Haltuunottoviikko',
    intro: 'Uuden saliohjelman haltuunotto: käydään liikkeet läpi ja opetellaan puhdas tekniikka. Valitse painot niin kevyiksi, että sarjan lopussa jaksaisit vielä 3–4 toistoa lisää — ne 3–4 jätät kuitenkin tekemättä (eli jäävät "reserviin"). Tavoite on oppia liikkeet ja löytää sopivat työskentelypainot, ei mennä äärirajoille.',
    kuorma: 'kevyt, tekniikka edellä',
    palautus: '2–3 min',
    maara: '2–3 salitreeniä',
    items: [
      '✅ Opettele jokainen liike puhtaasti ennen kuin lisäät painoa',
      '✅ Valitse kuorma, jolla lopussa jäisi vielä 3–4 toistoa reserviin',
      '✅ Kirjaa käytetyt painot ylös — ne ovat lähtötaso tuleville viikoille',
    ],
  },
  'Volyymi': {
    label: 'Volyymiviikko',
    intro: 'Teemana lihasmassa ja kuormankantokyky. Raskasta mutta hallittua: valitse kuorma, jolla sarjan lopussa jäisi vielä 1–2 toistoa reserviin.',
    kuorma: '70–80 % maksimista',
    palautus: '2–3 min',
    maara: '2–3 salitreeniä',
    items: [
      '✅ Alavartalon pääliike: esim. kyykky tai maastaveto',
      '✅ Ylävartalon pääliike: esim. leuanveto tai penkki-/pystypunnerrus',
      '✅ Tukiliikkeet ohjelman omilla toistomäärillä',
    ],
  },
  'Voima': {
    label: 'Voimaviikko',
    intro: 'Maksimivoiman viikko — kilot nousevat. Mennään lähelle rajaa: viimeisessä sarjassa saa tulla örinää, muissa jää 1–2 toistoa reserviin. Tekniikka silti edellä.',
    kuorma: '80–90 % maksimista',
    palautus: '3–4 min',
    maara: '2–3 salitreeniä',
    items: [
      '✅ Alavartalon pääliike raskaana',
      '✅ Ylävartalon pääliike raskaana',
      '✅ Uskalla lisätä painoa, mutta pidä liike puhtaana',
    ],
  },
  'Räjähtävyys': {
    label: 'Räjähtävyysviikko',
    intro: 'Vireys ylös, ei kipeytymistä. Kevyttä rautaa maksimaalisella toistonopeudella — lopeta sarja heti kun vauhti hidastuu. Yksi lyhyt treeni riittää.',
    kuorma: '50–65 % maksimista',
    palautus: '2 min',
    maara: '1 lyhyt salitreeni (30–40 min)',
    items: [
      '✅ Pääliikkeet nopeilla, räjähtävillä toistoilla',
      '✅ Hypyt ja heitot, esim. 5 × 3',
      '✅ Lopeta sarja kun toistonopeus hidastuu',
    ],
  },
  'Kevennys': {
    label: 'Kevennysviikko',
    intro: 'Kevyt paluu tai kilpailukevennys. Volyymi alas, mutta kilot ja nopeus säilyvät — tavoite on vireys, ei väsytys.',
    kuorma: '70–80 % maksimista',
    palautus: 'täysi',
    maara: '1–2 lyhyttä salitreeniä',
    items: [
      '✅ Pääliikkeet terävästi, vähän sarjoja',
      '✅ Lyhyt aktivointi 20–30 min',
      '✅ Ei maksimiyrityksiä',
    ],
  },
};

// Sama joka viikko: selventää mitä sarjat × toistot -luku koskee.
const _VOIMA_NOTE = 'Sarjat × toistot koskee pääliikkeitä (yksi alavartalon ja yksi ylävartalon liike). Tukiliikkeet tehdään ohjelman omilla toistomäärillä.';

function _viikkoohjeVoimaHtml(type, monday) {
  const data = _VOIMA_DATA[type];
  if (!data) return '';
  const { week, year } = calIsoWeekData(monday);
  const jakso  = typeof voimaJakso === 'function' ? voimaJakso(year, week) : null;
  const sarjat = typeof voimaSets  === 'function' ? voimaSets(type, jakso) : '';

  const subtitle = [
    sarjat ? `Pääliikkeet ${sarjat}` : '',
    `Kuorma ${data.kuorma}`,
    `Palautus ${data.palautus}`,
    data.maara,
  ].filter(Boolean).join(' · ');

  const itemsHtml = data.items.length
    ? `<ul>${data.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';

  return `
    <div class="viikkoohje-voima">
      <h4>Voimaharjoittelu — ${escapeHtml(data.label)}</h4>
      <p class="viikkoohje-subtitle">${escapeHtml(subtitle)}</p>
      <p>${escapeHtml(data.intro)}</p>
      ${itemsHtml}
      <p class="viikkoohje-voima-note">${escapeHtml(_VOIMA_NOTE)}</p>
    </div>`;
}

function _viikkoohjeUpcomingHtml(currentMonday) {
  const rows = [1, 2, 3].map(offset => {
    const mon = weeksAgoMonday(-offset);
    const { week } = calIsoWeekData(mon);
    const zone = calPlannedZone(mon);
    const zoneNums  = zone ? parseZoneStr(zone) : [];
    const zoneName  = zoneNums.map(z => _ZONE_DATA[z]?.name).filter(Boolean).join(' / ');
    const zoneColor = zoneNums.length ? PERF_COLORS[zoneNums[zoneNums.length - 1] - 1] : 'var(--text-muted)';
    const zoneLabel = zone
      ? `<span class="viikkoohje-upcoming-zone" style="color:${zoneColor}">${escapeHtml(zone)}${zoneName ? ` – ${escapeHtml(zoneName)}` : ''}</span>`
      : `<span class="viikkoohje-upcoming-zone viikkoohje-upcoming-empty">–</span>`;
    return `<div class="viikkoohje-upcoming-row">
      <span class="viikkoohje-upcoming-week">Vk ${week}</span>
      ${zoneLabel}
    </div>`;
  }).join('');

  return `<h4>Tulevat viikot</h4><div class="viikkoohje-upcoming">${rows}</div>`;
}

let _viikkoohjeOffset = 0; // 0 = kuluva vko, 1–3 = tulevat

function selectViikkoOhjeWeek(offset) {
  _viikkoohjeOffset = offset;
  renderViikkoOhjeTab();
}

function renderViikkoOhjeTab() {
  const container = el('viikkoohje-content');
  if (!container) return;

  // Toggle-palkki: kuluva + 3 seuraavaa viikkoa
  const toggleHtml = [0, 1, 2, 3].map(i => {
    const mon  = weeksAgoMonday(-i);
    const { week: w } = calIsoWeekData(mon);
    const z    = calPlannedZone(mon);
    const zNum = z ? parseZoneStr(z).slice(-1)[0] : 0;
    const col  = zNum ? PERF_COLORS[zNum - 1] : 'var(--border-light)';
    const isActive = i === _viikkoohjeOffset;
    const style = isActive
      ? `background:${col};border-color:${col};color:#fff`
      : `background:#fff;border-color:${col};color:var(--blue)`;
    return `<button class="viikkoohje-toggle-btn" style="${style}" onclick="selectViikkoOhjeWeek(${i})">Vk ${w}</button>`;
  }).join('');

  // Sisältö valitulle viikolle
  const monday = weeksAgoMonday(-_viikkoohjeOffset);
  const { week } = calIsoWeekData(monday);
  const zone = calPlannedZone(monday);

  const voima = typeof calVoimaType === 'function' ? calVoimaType(monday) : null;

  let bodyHtml;
  if (!zone) {
    bodyHtml = `<p>Viikolle ${week} ei ole asetettu tehoaluetta viikkosuunnitelmassa. Avaa Kalenteri-välilehti ja lisää tehoalue viikolle.</p>`;
  } else {
    bodyHtml = _viikkoohjeZoneHtml(zone);
  }
  if (voima) bodyHtml += _viikkoohjeVoimaHtml(voima, monday);

  const zoneNums  = zone ? parseZoneStr(zone) : [];
  const zoneName  = zoneNums.map(z => _ZONE_DATA[z]?.name).filter(Boolean).join(' / ');
  const voimaName = voima ? (_VOIMA_DATA[voima]?.label || `${voima}viikko`) : '';
  const titleBits = [zoneName, voimaName].filter(Boolean).join(' · ');
  const titleTail = titleBits ? ` · ${titleBits}` : '';

  container.innerHTML = `
    <div class="viikkoohje-toggle">${toggleHtml}</div>
    <div class="viikkoohje-card">
      <h4 class="viikkoohje-week-title">Viikko ${week}${titleTail}</h4>
      <div class="viikkoohje-output">${bodyHtml}</div>
    </div>
  `;
}

window.renderViikkoOhjeTab  = renderViikkoOhjeTab;
window.selectViikkoOhjeWeek = selectViikkoOhjeWeek;

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
window.openVoimaPicker         = openVoimaPicker;
window.selectZone              = selectZone;
window.clearZone               = clearZone;
