// ============================================================
// ADMIN PANEL
// ============================================================
el('admin-panel-btn').addEventListener('click', openAdminModal);
el('close-admin').addEventListener('click', closeAdminModal);
el('admin-backdrop').addEventListener('click', closeAdminModal);

function openAdminModal() {
  show('admin-modal');
  document.body.style.overflow = 'hidden';
  populateAdminTeamSelect();
  loadAdminUserList();
}

function closeAdminModal() {
  hide('admin-modal');
  document.body.style.overflow = 'hidden'; // profile modal still open
}

async function loadAdminUserList() {
  const listEl = el('admin-user-list');
  listEl.innerHTML = '<p class="loading">Ladataan käyttäjiä…</p>';

  try {
    const snap = await db.collection('users').get();
    if (snap.empty) {
      listEl.innerHTML = '<p class="loading">Ei käyttäjiä.</p>';
      return;
    }

    // Fetch all user docs
    const users = snap.docs.map(doc => ({
      uid:     doc.id,
      profile: doc.data().profile || {},
      email:   doc.data().email   || '',
    }));

    // Store emails in user docs when they log in — we need to persist email
    listEl.innerHTML = users.map(u => {
      const name  = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || '—';
      const email = u.email || u.uid;
      return `
        <div class="admin-user-item">
          <div class="admin-user-info">
            <span class="admin-user-email">${escapeHtml(email)}</span>
            <span class="admin-user-name">${escapeHtml(name)}</span>
          </div>
          <div class="admin-user-actions">
            <button class="btn-csv-sm" onclick="adminExportPlayerCsv('${u.uid}', '${escapeHtml(name || email)}')">CSV</button>
            <button class="btn-danger-solid" onclick="adminDeleteUser('${u.uid}', '${escapeHtml(email)}')">Poista</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    console.error(err);
    listEl.innerHTML = '<p class="loading">Lataus epäonnistui.</p>';
  }
}

// ── CSV helpers ────────────────────────────────────────────────

el('admin-csv-team-btn').addEventListener('click', async () => {
  const team = el('admin-csv-team').value;
  if (!team) { toast('Valitse ensin joukkue.', 'error'); return; }
  const btn = el('admin-csv-team-btn');
  btn.disabled = true;
  btn.textContent = 'Ladataan…';
  try {
    await adminExportTeamCsv(team);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lataa CSV';
  }
});

async function adminExportTeamCsv(team) {
  const snap = await db.collection('users').get();
  const allUsers = snap.docs.map(d => ({ uid: d.id, profile: d.data().profile || {}, email: d.data().email || '' }));

  const members = team === '__ALL__'
    ? allUsers
    : allUsers.filter(u => {
        const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
        return teams.includes(team);
      });

  if (members.length === 0) {
    toast(team === '__ALL__' ? 'Ei käyttäjiä.' : 'Ei jäseniä joukkueessa: ' + team, 'info');
    return;
  }

  const rows = [];
  await Promise.all(members.map(async u => {
    const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid;
    const eSnap = await db.collection('users').doc(u.uid).collection('entries')
      .orderBy('date', 'asc').get();
    eSnap.docs.forEach(d => rows.push({ playerName: name, ...d.data() }));
  }));

  rows.sort((a, b) => {
    const ta = a.date?.toMillis ? a.date.toMillis() : 0;
    const tb = b.date?.toMillis ? b.date.toMillis() : 0;
    return ta - tb;
  });

  const filename = team === '__ALL__'
    ? `kaikki_pelaajat_harjoitukset.csv`
    : `${team.replace(/\s+/g, '_')}_harjoitukset.csv`;
  downloadCsv(rows, filename);
}

async function adminExportPlayerCsv(uid, playerName) {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    const snap = await db.collection('users').doc(uid).collection('entries')
      .orderBy('date', 'asc').get();
    const rows = snap.docs.map(d => ({ playerName, ...d.data() }));
    const filename = `${playerName.replace(/\s+/g, '_')}_harjoitukset.csv`;
    downloadCsv(rows, filename);
  } finally {
    btn.disabled = false;
    btn.textContent = 'CSV';
  }
}

function downloadCsv(rows, filename) {
  const PERF_LABELS_SHORT = ['', 'I – Peruskestävyys', 'II – Kestävyys', 'III – Vauhti', 'IV – Maksimi', 'V – Kilpailu'];
  const FEEL_LABELS_SHORT = ['', 'Erinomainen', 'Hyvä', 'Ok', 'Väsynyt', 'Todella väsynyt'];

  const headers = [
    'Pelaaja', 'Päivämäärä', 'Aktiviteetti', 'Kesto (min)',
    'Tehoalue', 'Fiilis', 'Matka (km)', 'Keskisyke (bpm)', 'Maksimisyke (bpm)', 'Kommentti'
  ];

  const escape = v => {
    if (v == null || v === '') return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  rows.forEach(r => {
    const dateStr = r.date?.toDate ? r.date.toDate().toLocaleDateString('fi-FI') : '';
    const cells = [
      escape(r.playerName),
      escape(dateStr),
      escape(r.type),
      escape(r.duration),
      escape(r.performance ? PERF_LABELS_SHORT[r.performance] : ''),
      escape(r.feeling ? FEEL_LABELS_SHORT[r.feeling] : ''),
      escape(r.distance ?? ''),
      escape(r.avgHr ?? ''),
      escape(r.maxHr ?? ''),
      escape(r.comment ?? ''),
    ];
    lines.push(cells.join(','));
  });

  const bom = '\uFEFF'; // UTF-8 BOM so Excel opens Finnish chars correctly
  const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function adminDeleteUser(uid, email) {
  const yes = await dangerConfirm(`Poistetaanko käyttäjä ${email} ja kaikki heidän harjoitustietonsa?`);
  if (!yes) return;
  try {
    await deleteAllUserData(uid);
    await loadAdminUserList(); // refresh list
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui: ' + err.message, 'error');
  }
}

// Expose for onclick in HTML
window.adminExportPlayerCsv = adminExportPlayerCsv;
window.adminDeleteUser = adminDeleteUser;
