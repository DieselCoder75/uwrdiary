// ============================================================
// PROFILE — load, display, modal
// ============================================================
async function loadProfile() {
  try {
    const snap = await getUserDoc().get();
    const remoteProfile = snap.exists ? (snap.data().profile || {}) : {};
    const remoteEmail   = snap.exists ? snap.data().email : null;
    // coachOf and records live at root of user doc (not inside profile)
    const remoteCoachOf = snap.exists ? (snap.data().coachOf || []) : [];
    const remoteRecords = snap.exists ? (snap.data().records || null) : null;

    // Only write email to Firestore if it's missing or changed (saves a write on most logins)
    if (remoteEmail !== currentUser.email) {
      getUserDoc().set({ email: currentUser.email }, { merge: true });
    }

    // Update cache only if profile data actually changed
    const cached = Cache.get(currentUser.uid, 'profile');
    if (Cache.fingerprint(remoteProfile) !== Cache.fingerprint(cached?.coachOf !== undefined ? Object.fromEntries(Object.entries(cached).filter(([k]) => k !== 'coachOf' && k !== 'records')) : cached)) {
      Cache.set(currentUser.uid, 'profile', { ...remoteProfile, coachOf: remoteCoachOf, records: remoteRecords });
    }

    userProfile = { ...remoteProfile, coachOf: remoteCoachOf, records: remoteRecords };

    // Cache firstName for splash-screen greeting (auth.js lukee tämän heti)
    const greetName = remoteProfile.nickname || remoteProfile.firstName || '';
    if (greetName) localStorage.setItem('uppis_firstname', greetName);

    // Restore Kuorma-disclaimer collapse state from profile.uiPrefs
    applyKuormaDisclaimerState();
  } catch (err) {
    console.error('loadProfile failed:', err);
    if (!userProfile || !Object.keys(userProfile).length) userProfile = {};
  }
  updateHeaderProfile();
  updateAdminShortcut();
}

// Nollaa katseltavan käyttäjän profiilidatan välimuistit (testit, ennätykset).
// Kutsutaan kun katseltava käyttäjä vaihtuu: impersonointiin mentäessä JA
// siitä poistuttaessa — muuten admin näkisi toisen pelaajan testit omassa
// profiilissaan kunnes sivu ladataan uudelleen.
function resetViewedProfileState() {
  ennatyksetLoaded = false;
  testit = null;
  maxSpeedTests = null;
  lihasTests = null;
}

// Apply saved Kuorma-disclaimer open/closed state, attach one-time toggle listener.
function applyKuormaDisclaimerState() {
  const d = document.getElementById('kuorma-disclaimer');
  if (!d) return;
  const saved = userProfile?.uiPrefs?.kuormaDisclaimerOpen;
  d.open = saved !== false; // default open
  if (!d.dataset.toggleBound) {
    d.dataset.toggleBound = '1';
    d.addEventListener('toggle', () => {
      userProfile.uiPrefs = { ...(userProfile.uiPrefs || {}), kuormaDisclaimerOpen: d.open };
      getUserDoc().set(
        { profile: { uiPrefs: { kuormaDisclaimerOpen: d.open } } },
        { merge: true }
      ).catch(err => console.error('Save kuormaDisclaimerOpen failed:', err));
    });
  }
}

// Show/hide the ⚙ admin shortcut in the header (admin or coach)
function updateAdminShortcut() {
  const isAdmin = currentUser?.email === ADMIN_EMAIL;
  const isCoach = (userProfile.coachOf || []).length > 0;
  el('admin-shortcut-btn')?.classList.toggle('hidden', !isAdmin && !isCoach);
  // Kuorma-välilehti näkyy kaikille käyttäjille
  el('kuorma-sub-tab-btn')?.classList.remove('hidden');
  // AI Coach -välilehti: profiilin täpän mukaan (oletus tietyille käyttäjille päällä)
  el('aicoach-sub-tab-btn')?.classList.toggle('hidden', !aiCoachEnabledForCurrentUser());
  // Viikko-ohje -välilehti: näkyy kaikille
  el('viikkoohje-sub-tab-btn')?.classList.remove('hidden');
}

// Onko AI Coach käytössä nykyiselle käyttäjälle?
// Profiilin tallennettu arvo voittaa; muuten oletus sähköpostin perusteella.
function aiCoachEnabledForCurrentUser() {
  if (typeof userProfile?.aiCoachEnabled === 'boolean') return userProfile.aiCoachEnabled;
  return AICOACH_DEFAULT_ON_EMAILS.includes(currentUser?.email);
}

function updateHeaderProfile(overrideProfile) {
  const p = overrideProfile || userProfile;
  const displayName = p.nickname || p.firstName || '';
  el('header-firstname').textContent = displayName;

  const avatarImg  = el('header-avatar');
  const initialsEl = el('header-initials');

  if (p.photoURL) {
    avatarImg.src = p.photoURL;
    avatarImg.classList.remove('hidden');
    initialsEl.textContent = '';
  } else if (displayName) {
    avatarImg.classList.add('hidden');
    initialsEl.textContent = displayName.charAt(0).toUpperCase();
  } else {
    avatarImg.classList.add('hidden');
    initialsEl.textContent = '👤';
  }
}

// Help modal tab switching
const HELP_TABS = ['kaytto', 'tietoturva', 'versiot'];

const LIHAS_EXERCISES = [
  { key: 'toesToBar',             label: 'Toes to Bar',              unit: 'toistot 30s',    color: '#003F9C' },
  { key: 'kneesToChest',          label: 'Knees to Chest',           unit: 'toistot 30s',    color: '#4FC3D0' },
  { key: 'leuanveto',             label: 'Leuanveto',                unit: 'maksimitoistot', color: '#7DC83A' },
  { key: 'pituushyppy',           label: 'Vauhditon pituushyppy',    unit: 'cm',             color: '#F5A623' },
  { key: 'punnerrus',             label: 'Punnerrus',                unit: 'toistot 30s',    color: '#E84040' },
  { key: 'punnerrusPolvetMaassa', label: 'Punnerrus polvet maassa',  unit: 'toistot 30s',    color: '#C0392B' },
];
document.querySelectorAll('.help-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.helpTab;
    document.querySelectorAll('.help-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    HELP_TABS.forEach(t => {
      const panel = el('help-tab-' + t);
      if (panel) panel.classList.toggle('hidden', t !== tab);
    });
  });
});

el('help-btn').addEventListener('click', () => {
  // Populate version bar dynamically
  const vMatch = document.querySelector('link[href*="styles.css"]')
    ?.getAttribute('href')?.match(/v=(\d+)/);
  const build = vMatch ? vMatch[1] : '—';
  const updated = new Date(document.lastModified)
    .toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  el('help-version-text').textContent  = `Versio 1.7 (build ${build})`;
  el('help-updated-text').textContent  = `Päivitetty ${updated}`;

  // Nollaa aina Käyttöohje-välilehdelle
  document.querySelectorAll('.help-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.helpTab === 'kaytto'));
  HELP_TABS.forEach(t => {
    const panel = el('help-tab-' + t);
    if (panel) panel.classList.toggle('hidden', t !== 'kaytto');
  });

  show('help-modal');
  document.body.style.overflow = 'hidden';
});
el('close-help').addEventListener('click', () => {
  hide('help-modal');
  document.body.style.overflow = '';
});
el('help-backdrop').addEventListener('click', () => {
  hide('help-modal');
  document.body.style.overflow = '';
});

el('profile-btn').addEventListener('click', openProfileModal);
el('joukkue-open-profile-btn').addEventListener('click', openProfileModal);
el('close-profile').addEventListener('click', closeProfileModal);
el('profile-backdrop').addEventListener('click', closeProfileModal);

// ── Profiiliportaalin välilehtien vaihto ──────────────────────
document.querySelectorAll('.profile-portal-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.profileTab;
    document.querySelectorAll('.profile-portal-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.profile-portal-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    el('profile-tab-' + target).classList.remove('hidden');
    if (target === 'ennatykset') renderEnnatykset();
    if (target === 'testit') renderTestit();
  });
});

// ── Testit-alivalilehdet (10×100m / Lihaskunto / Max Nopeus) ──
document.querySelectorAll('.testit-sub-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.testit-sub-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.testit-sub-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    el('testit-sub-' + btn.dataset.testitTab).classList.remove('hidden');
    if (btn.dataset.testitTab === 'lihaskunto') renderLihaskunto();
    if (btn.dataset.testitTab === 'maxnopeus') renderMaxNopeus();
  });
});

function openProfileModal() {
  if (impersonating) { openImpersonatedProfileView(); return; }
  pendingAvatarDataUrl = null;
  el('avatar-size-hint').textContent = '';

  // Nollaa aina Tiedot-välilehdelle
  document.querySelectorAll('.profile-portal-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.profile-portal-panel').forEach(p => p.classList.add('hidden'));
  document.querySelector('[data-profile-tab="tiedot"]').classList.add('active');
  el('profile-tab-tiedot').classList.remove('hidden');

  // Show email as username
  el('profile-username-display').textContent = currentUser?.email || '';

  el('profile-nickname').value  = userProfile.nickname  || '';
  el('profile-firstname').value = userProfile.firstName || '';
  el('profile-lastname').value  = userProfile.lastName  || '';
  el('profile-gender').value    = userProfile.gender    || '';
  el('profile-birthday').value  = userProfile.birthday || '';
  const savedTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
  renderTeamCheckboxes('profile-team-group', 'profile-team', savedTeams);
  el('profile-share-activities').checked = userProfile.shareActivities === true;
  el('profile-share-comments').checked   = userProfile.shareComments   === true;
  el('profile-aicoach-enabled').checked  = aiCoachEnabledForCurrentUser();
  syncShareCommentsState();
  updateAgeDisplay(userProfile.birthday || '');

  // Tavoitteet
  el('goal-weekly-minutes').value  = userProfile.weeklyMinutesGoal  || '';
  el('goal-weekly-sessions').value = userProfile.weeklySessionsGoal || '';
  el('goals-save-status').classList.add('hidden');

  const previewImg      = el('avatar-preview');
  const previewInitials = el('avatar-preview-initials');
  const removeBtn       = el('remove-avatar-btn');

  if (userProfile.photoURL) {
    previewImg.src = userProfile.photoURL;
    previewImg.classList.remove('hidden');
    previewInitials.textContent = '';
    removeBtn.classList.remove('hidden');
  } else {
    previewImg.classList.add('hidden');
    previewInitials.textContent = '👤';
    removeBtn.classList.add('hidden');
  }

  el('profile-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeProfileModal() {
  hide('profile-modal');
  document.body.style.overflow = '';
  pendingAvatarDataUrl = null;
  // Palauta normaali tila jos oltiin viewing-moodissa
  el('profile-modal').classList.remove('profile-modal--viewing');
  el('profile-modal-title').textContent = 'Profiili';
}

// ── Impersonation profile view ────────────────────────────────
function openImpersonatedProfileView() {
  const p    = impersonating.profile || {};
  const name = impersonating.name || impersonating.email || '';

  // Otsikko
  el('profile-modal-title').textContent = name;

  // Nollaa välilehdet → Tiedot
  document.querySelectorAll('.profile-portal-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.profile-portal-panel').forEach(panel => panel.classList.add('hidden'));
  document.querySelector('[data-profile-tab="tiedot"]').classList.add('active');
  el('profile-tab-tiedot').classList.remove('hidden');

  // Täytä kenttä pelaajan datalla
  el('profile-username-display').textContent = impersonating.email || '';
  el('profile-nickname').value  = p.nickname  || '';
  el('profile-firstname').value = p.firstName || '';
  el('profile-lastname').value  = p.lastName  || '';
  el('profile-gender').value    = p.gender    || '';
  el('profile-birthday').value  = p.birthday  || '';
  const savedTeams = p.teams || (p.team ? [p.team] : []);
  renderTeamCheckboxes('profile-team-group', 'profile-team', savedTeams);
  el('profile-share-activities').checked = p.shareActivities === true;
  el('profile-share-comments').checked   = p.shareComments   === true;
  el('profile-aicoach-enabled').checked  = (typeof p.aiCoachEnabled === 'boolean')
    ? p.aiCoachEnabled
    : AICOACH_DEFAULT_ON_EMAILS.includes(impersonating?.email);
  updateAgeDisplay(p.birthday || '');

  // Avatar
  const previewImg      = el('avatar-preview');
  const previewInitials = el('avatar-preview-initials');
  const removeBtn       = el('remove-avatar-btn');
  removeBtn.classList.add('hidden');
  if (p.photoURL) {
    previewImg.src = p.photoURL;
    previewImg.classList.remove('hidden');
    previewInitials.textContent = '';
  } else {
    previewImg.classList.add('hidden');
    previewInitials.textContent = name ? name.charAt(0).toUpperCase() : '👤';
  }

  // Pakota Saavutukset ja Testit latautumaan uudelleen oikealle käyttäjälle
  resetViewedProfileState();

  // Viewing-moodi piilottaa muokkaus-elementit CSS:n kautta
  el('profile-modal').classList.add('profile-modal--viewing');

  show('profile-modal');
  document.body.style.overflow = 'hidden';
}

// Avatar file picker
el('avatar-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';

  const MAX_BYTES = 100 * 1024; // 100 KB

  const compressed = await compressImage(file);
  const compressedBytes = Math.round((compressed.length * 3) / 4); // base64 → bytes estimate

  if (compressedBytes > MAX_BYTES) {
    toast(`Pakattu kuva on ${Math.round(compressedBytes / 1024)} KB — yli 100 KB rajan. Valitse pienempi tai neliönmuotoinen (1:1) kuva.`, 'error');
    return;
  }

  pendingAvatarDataUrl = compressed;
  const previewImg = el('avatar-preview');
  previewImg.src = compressed;
  previewImg.classList.remove('hidden');
  el('avatar-preview-initials').textContent = '';
  el('remove-avatar-btn').classList.remove('hidden');
  el('avatar-size-hint').textContent = `✓ ${Math.round(compressedBytes / 1024)} KB`;
});

el('remove-avatar-btn').addEventListener('click', async () => {
  const yes = await confirm('Poistetaanko profiilikuva?');
  if (!yes) return;
  pendingAvatarDataUrl = '';  // empty string = remove
  el('avatar-preview').classList.add('hidden');
  el('avatar-preview-initials').textContent = '👤';
  el('remove-avatar-btn').classList.add('hidden');
});

// Save profile
el('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (impersonating) return;

  const updated = {
    nickname:  el('profile-nickname').value.trim(),
    firstName: el('profile-firstname').value.trim(),
    lastName:  el('profile-lastname').value.trim(),
    gender:    el('profile-gender').value,
    birthday:  el('profile-birthday').value || '',
    teams:            Array.from(document.querySelectorAll('input[name="profile-team"]:checked')).map(cb => cb.value),
    shareActivities:  el('profile-share-activities').checked,
    shareComments:    el('profile-share-comments').checked,
    aiCoachEnabled:   el('profile-aicoach-enabled').checked,
  };

  if (pendingAvatarDataUrl !== null) {
    updated.photoURL = pendingAvatarDataUrl;  // '' means removed
  } else {
    updated.photoURL = userProfile.photoURL || '';
  }

  try {
    // Päivitä kentät yksitellen dot-notaatiolla → ei korvaa koko profile-objektia
    // (muuten esim. weeklyMinutesGoal, onboardingDone, uiPrefs katoaisivat)
    const fieldUpdate = {};
    Object.entries(updated).forEach(([k, v]) => { fieldUpdate[`profile.${k}`] = v; });
    await getUserDoc().update(fieldUpdate);
  } catch (err) {
    if (err.code === 'not-found') {
      await getUserDoc().set({ email: currentUser.email, profile: updated }, { merge: true });
    } else {
      console.error('Profile save failed:', err);
      toast('Profiilin tallennus epäonnistui: ' + err.message, 'error');
      return;
    }
  }
  userProfile = { ...userProfile, ...updated };
  Cache.set(currentUser.uid, 'profile', userProfile);
  updateHeaderProfile();
  updateAdminShortcut();   // päivitä AI Coach -välilehden näkyvyys heti
  closeProfileModal();
  toast('Profiili tallennettu.', 'success');
});

// Age calculation
function calcAge(birthdayStr) {
  if (!birthdayStr) return null;
  const birth = new Date(birthdayStr);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const notYet = today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (notYet) age--;
  return age >= 0 ? age : null;
}

function updateAgeDisplay(birthdayStr) {
  const age = calcAge(birthdayStr);
  el('profile-age-display').textContent = age !== null ? `${age} vuotta` : '';
}

el('profile-birthday').addEventListener('change', (e) => updateAgeDisplay(e.target.value));

function syncShareCommentsState() {
  const activitiesOn = el('profile-share-activities').checked;
  const commentsEl   = el('profile-share-comments');
  commentsEl.disabled = !activitiesOn;
  if (!activitiesOn) commentsEl.checked = false;
  commentsEl.closest('label').classList.toggle('checkbox-disabled', !activitiesOn);
}

el('profile-share-activities').addEventListener('change', syncShareCommentsState);

// Image compression — crops to square centre, max 240px, targets < 100KB
function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const size    = Math.min(img.width, img.height, 240);
      const canvas  = document.createElement('canvas');
      canvas.width  = size;
      canvas.height = size;
      const ctx     = canvas.getContext('2d');
      // Centre-crop to square
      const sx = (img.width  - Math.min(img.width, img.height)) / 2;
      const sy = (img.height - Math.min(img.width, img.height)) / 2;
      const sq = Math.min(img.width, img.height);
      ctx.drawImage(img, sx, sy, sq, sq, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', 0.70));
    };
    img.src = url;
  });
}

// ============================================================
// DELETE USER DATA UTILITY
// ============================================================
async function deleteAllUserData(uid) {
  const userRef  = db.collection('users').doc(uid);
  const inc      = firebase.firestore.FieldValue.increment;
  const fdel     = firebase.firestore.FieldValue.delete;

  // 1. Read user's own reactions to clean them up from other users' entries
  const userSnap    = await userRef.get();
  const myReactions = userSnap.exists ? (userSnap.data().myReactions || {}) : {};

  // 2. Remove each reaction doc + decrement reactionCounts in the target entry
  //    Split into batches of 100 to stay well under Firestore's 500-op limit
  const reactionEntries = Object.entries(myReactions);
  for (let i = 0; i < reactionEntries.length; i += 100) {
    const batch = db.batch();
    reactionEntries.slice(i, i + 100).forEach(([key, emoji]) => {
      const sep      = key.indexOf('_');
      const ownerUid = key.slice(0, sep);
      const entryId  = key.slice(sep + 1);
      const entryRef    = db.collection('users').doc(ownerUid).collection('entries').doc(entryId);
      const reactionRef = entryRef.collection('reactions').doc(uid);
      batch.delete(reactionRef);
      if (emoji) batch.update(entryRef, { [`reactionCounts.${emoji}`]: inc(-1) });
    });
    await batch.commit();
  }

  // 3. Delete own entries in chunks of 499 (Firestore batch limit = 500)
  const entriesSnap = await userRef.collection('entries').get();
  const entryDocs   = entriesSnap.docs;
  const CHUNK = 499;
  for (let i = 0; i < entryDocs.length; i += CHUNK) {
    const chunk = entryDocs.slice(i, i + CHUNK);
    const b = db.batch();
    chunk.forEach(d => b.delete(d.ref));
    await b.commit();
  }
  // 4. Delete the user document itself
  await userRef.delete();
}

// ============================================================
// CHANGE PASSWORD
// ============================================================
el('change-password-btn').addEventListener('click', () => {
  el('change-password-form').classList.toggle('hidden');
  el('cp-current').value = '';
  el('cp-new').value     = '';
  el('cp-confirm').value = '';
  el('cp-error').classList.add('hidden');
  if (!el('change-password-form').classList.contains('hidden')) {
    el('cp-current').focus();
  }
});

el('cp-cancel-btn').addEventListener('click', () => {
  el('change-password-form').classList.add('hidden');
});

el('cp-save-btn').addEventListener('click', async () => {
  const current  = el('cp-current').value;
  const newPw    = el('cp-new').value;
  const confirm  = el('cp-confirm').value;
  const errorEl  = el('cp-error');

  const showErr = msg => {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  };

  errorEl.classList.add('hidden');

  if (!current)               return showErr('Syötä nykyinen salasana.');
  if (newPw.length < 6)       return showErr('Uuden salasanan on oltava vähintään 6 merkkiä.');
  if (newPw !== confirm)      return showErr('Salasanat eivät täsmää.');
  if (newPw === current)      return showErr('Uusi salasana on sama kuin nykyinen.');

  const btn = el('cp-save-btn');
  btn.disabled = true;
  btn.textContent = 'Tallennetaan…';

  try {
    // Re-authenticate (Firebase requires this for sensitive operations)
    const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, current);
    await currentUser.reauthenticateWithCredential(credential);
    await currentUser.updatePassword(newPw);
    el('change-password-form').classList.add('hidden');
    toast('Salasana vaihdettu.', 'success');
  } catch (err) {
    if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
      showErr('Nykyinen salasana on väärä.');
    } else {
      showErr('Virhe: ' + err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Tallenna';
  }
});

// ============================================================
// TAVOITTEET — tallenna viikkokohtaiset tavoitteet
// ============================================================
el('save-goals-btn').addEventListener('click', async () => {
  const minVal  = parseInt(el('goal-weekly-minutes').value,  10);
  const sessVal = parseInt(el('goal-weekly-sessions').value, 10);

  const update = {
    weeklyMinutesGoal:  isNaN(minVal)  || minVal  <= 0 ? null : minVal,
    weeklySessionsGoal: isNaN(sessVal) || sessVal <= 0 ? null : sessVal,
  };

  try {
    await getUserDoc().update({
      'profile.weeklyMinutesGoal':  update.weeklyMinutesGoal,
      'profile.weeklySessionsGoal': update.weeklySessionsGoal,
    });
    userProfile = { ...userProfile, ...update };

    // Piirrä kaaviot uudelleen jos Trendit-Omat on auki (tavoiteviiva päivittyy)
    if (document.getElementById('subtab-omat') &&
        !document.getElementById('subtab-omat').classList.contains('hidden')) {
      renderTrenditCharts();
    }

    const statusEl = el('goals-save-status');
    statusEl.textContent = 'Tallennettu ✓';
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 2500);
  } catch (err) {
    console.error('saveGoals:', err);
    toast('Tallentaminen epäonnistui', 'error');
  }
});

// ============================================================
// ENNÄTYKSET — henkilökohtaiset ennätykset koko historiasta
// ============================================================
let ennatyksetLoaded = false; // ladataan vain kerran per sessio

// Renderöi Saavutukset-välilehden valmiista records-aggregaateista (0 entry-readia)
function renderEnnatyksetFromRecords(container, r) {
  if (!r.totalEntries) {
    container.innerHTML = '<div class="profile-coming-soon"><div class="profile-coming-soon-icon">🏆</div><p class="profile-coming-soon-desc">Ei vielä yhtään kirjattua treeniä.</p></div>';
    return;
  }
  const weeks = Object.entries(r.weeks || {}).map(([key, v]) => {
    const m = key.match(/^(\d{4})-W(\d{2})$/);
    return { key, year: +m[1], week: +m[2], sessions: v.sessions||0, minutes: v.minutes||0, uppoMinutes: v.uppoMinutes||0 };
  });
  const bestSessions = weeks.reduce((b, w) => !b || w.sessions > b.sessions ? w : b, null);
  const bestMinutes  = weeks.reduce((b, w) => !b || w.minutes  > b.minutes  ? w : b, null);
  const bestUppo     = weeks.filter(w => w.uppoMinutes > 0).reduce((b, w) => !b || w.uppoMinutes > b.uppoMinutes ? w : b, null);
  const longestEntry = r.longestEntry;
  const firstDate    = r.firstEntryDate?.toDate ? r.firstEntryDate.toDate() : (r.firstEntryDate ? new Date(r.firstEntryDate) : null);

  const fmtWeek = w  => `Viikko ${w.week} / ${w.year}`;
  const fmtDate = dt => dt.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  const longDate = longestEntry?.date?.toDate ? longestEntry.date.toDate() : (longestEntry?.date ? new Date(longestEntry.date) : null);

  container.innerHTML = `
    <div class="ennatykset-list">
      <div class="ennätys-card">
        <div class="ennätys-icon">📊</div>
        <div class="ennätys-body">
          <div class="ennätys-label">Treenihistoria</div>
          <div class="ennätys-stats-row">
            <div><div class="ennätys-value">${r.totalEntries.toLocaleString('fi-FI')} <span class="ennätys-unit">treeniä</span></div></div>
            <div><div class="ennätys-value">${r.totalMinutes.toLocaleString('fi-FI')} <span class="ennätys-unit">min</span></div></div>
          </div>
          ${firstDate ? `<div class="ennätys-week">Aloitettu ${fmtDate(firstDate)}</div>` : ''}
        </div>
      </div>
      ${bestUppo ? `
      <div class="ennätys-card">
        <div class="ennätys-icon">🤿</div>
        <div class="ennätys-body">
          <div class="ennätys-label">Eniten uppopalloa viikossa</div>
          <div class="ennätys-value">${bestUppo.uppoMinutes} <span class="ennätys-unit">min</span></div>
          <div class="ennätys-week">${fmtWeek(bestUppo)}</div>
        </div>
      </div>` : ''}
      ${bestSessions ? `
      <div class="ennätys-card">
        <div class="ennätys-icon">🏅</div>
        <div class="ennätys-body">
          <div class="ennätys-label">Eniten treenejä viikossa</div>
          <div class="ennätys-value">${bestSessions.sessions} <span class="ennätys-unit">kertaa</span></div>
          <div class="ennätys-week">${fmtWeek(bestSessions)}</div>
        </div>
      </div>` : ''}
      ${bestMinutes ? `
      <div class="ennätys-card">
        <div class="ennätys-icon">⏱</div>
        <div class="ennätys-body">
          <div class="ennätys-label">Eniten treeniminuutteja viikossa</div>
          <div class="ennätys-value">${bestMinutes.minutes} <span class="ennätys-unit">min</span></div>
          <div class="ennätys-week">${fmtWeek(bestMinutes)}</div>
        </div>
      </div>` : ''}
      ${longestEntry && longDate ? `
      <div class="ennätys-card">
        <div class="ennätys-icon">🕐</div>
        <div class="ennätys-body">
          <div class="ennätys-label">Pisin yksittäinen treeni</div>
          <div class="ennätys-value">${longestEntry.duration} <span class="ennätys-unit">min</span></div>
          <div class="ennätys-week">${longestEntry.type ? escapeHtml(longestEntry.type) + ' · ' : ''}${fmtDate(longDate)}</div>
        </div>
      </div>` : ''}
    </div>
  `;
}

async function renderEnnatykset() {
  if (ennatyksetLoaded) return;

  const container = el('ennatykset-container');
  const RECORDS_TTL = 24 * 60 * 60 * 1000; // 24 h
  const lsKey = 'uppis_records_' + (currentUser?.uid || '');

  // ── FAST PATH: jos käyttäjä on bootstrapattu, käytä valmiita aggregaatteja ─
  // Ei Firestore-lukua, ei localStorage-cachea — userProfile on jo muistissa.
  if (!impersonating && userProfile?.records?.bootstrapped) {
    try {
      renderEnnatyksetFromRecords(container, userProfile.records);
      ennatyksetLoaded = true;
      return;
    } catch (err) {
      console.warn('Fast path failed, falling back to full read:', err);
      // jatka vanhaan polkuun
    }
  }
  // Impersonointi: lue kohdekäyttäjän records jos saatavilla (1 read)
  if (impersonating) {
    try {
      const doc = await getViewDoc().get();
      const r = doc.data()?.records;
      if (r?.bootstrapped) {
        renderEnnatyksetFromRecords(container, r);
        ennatyksetLoaded = true;
        return;
      }
    } catch (err) {
      console.warn('Impersonated records fetch failed:', err);
    }
  }

  // Kokeile localStorage ensin — ei välimuistia impersonoinnin aikana
  if (!impersonating) {
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.ts < RECORDS_TTL) {
          container.innerHTML = parsed.html;
          ennatyksetLoaded = true;
          return;
        }
      }
    } catch {}
  }

  try {
    // Hae kaikki entryt (koko historia, ei aikarajoitusta)
    const snap = await getUserEntries().orderBy('date', 'asc').get();
    const entries = snap.docs.map(d => {
      const data = d.data();
      const date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
      return { date, duration: data.duration || 0, performance: data.performance || null, type: data.type || '' };
    });

    if (!entries.length) {
      container.innerHTML = '<div class="profile-coming-soon"><div class="profile-coming-soon-icon">🏆</div><p class="profile-coming-soon-desc">Ei vielä yhtään kirjattua treeniä.</p></div>';
      ennatyksetLoaded = true; // älä lataa uudelleen vaikka historia on tyhjä
      return;
    }

    // ── Kokonaistilastot ─────────────────────────────────────
    const totalEntries = entries.length;
    const totalMinutes = entries.reduce((sum, e) => sum + e.duration, 0);
    const firstEntry   = entries[0]; // järjestyksessä asc → vanhin ensin

    // ── Ryhmittele ISO-viikon mukaan ──────────────────────────
    const weekMap = {};
    entries.forEach(e => {
      const d   = new Date(Date.UTC(e.date.getFullYear(), e.date.getMonth(), e.date.getDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
      const year = d.getUTCFullYear();
      const key  = `${year}-W${String(week).padStart(2, '0')}`;
      if (!weekMap[key]) weekMap[key] = { week, year, sessions: 0, minutes: 0 };
      weekMap[key].sessions += 1;
      weekMap[key].minutes  += e.duration;
    });

    const weeks = Object.values(weekMap);

    // ── Uppopallo viikkoennätys ────────────────────────────────
    const uppoWeekMap = {};
    entries.filter(e => e.type === 'Uppopallo').forEach(e => {
      const d   = new Date(Date.UTC(e.date.getFullYear(), e.date.getMonth(), e.date.getDate()));
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
      const year = d.getUTCFullYear();
      const key  = `${year}-W${String(week).padStart(2, '0')}`;
      if (!uppoWeekMap[key]) uppoWeekMap[key] = { week, year, minutes: 0 };
      uppoWeekMap[key].minutes += e.duration;
    });
    const uppoWeeks   = Object.values(uppoWeekMap);
    const bestUppo    = uppoWeeks.length ? uppoWeeks.reduce((best, w) => w.minutes >= best.minutes ? w : best, uppoWeeks[0]) : null;

    // ── Löydä ennätysviikot ja pisin yksittäinen treeni ─────────
    const bestSessions = weeks.reduce((best, w) => w.sessions >= best.sessions ? w : best, weeks[0]);
    const bestMinutes  = weeks.reduce((best, w) => w.minutes  >= best.minutes  ? w : best, weeks[0]);
    const longestEntry = entries.reduce((best, e) => e.duration >= (best?.duration || 0) ? e : best, null);

    const fmtWeek = w  => `Viikko ${w.week} / ${w.year}`;
    const fmtDate = dt => dt.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });

    // ── Renderöi ──────────────────────────────────────────────
    container.innerHTML = `
      <div class="ennatykset-list">
        <div class="ennätys-card">
          <div class="ennätys-icon">📊</div>
          <div class="ennätys-body">
            <div class="ennätys-label">Treenihistoria</div>
            <div class="ennätys-stats-row">
              <div>
                <div class="ennätys-value">${totalEntries.toLocaleString('fi-FI')} <span class="ennätys-unit">treeniä</span></div>
              </div>
              <div>
                <div class="ennätys-value">${totalMinutes.toLocaleString('fi-FI')} <span class="ennätys-unit">min</span></div>
              </div>
            </div>
            <div class="ennätys-week">Aloitettu ${fmtDate(firstEntry.date)}</div>
          </div>
        </div>
        ${bestUppo ? `
        <div class="ennätys-card">
          <div class="ennätys-icon">🤿</div>
          <div class="ennätys-body">
            <div class="ennätys-label">Eniten uppopalloa viikossa</div>
            <div class="ennätys-value">${bestUppo.minutes} <span class="ennätys-unit">min</span></div>
            <div class="ennätys-week">${fmtWeek(bestUppo)}</div>
          </div>
        </div>` : ''}
        <div class="ennätys-card">
          <div class="ennätys-icon">🏅</div>
          <div class="ennätys-body">
            <div class="ennätys-label">Eniten treenejä viikossa</div>
            <div class="ennätys-value">${bestSessions.sessions} <span class="ennätys-unit">kertaa</span></div>
            <div class="ennätys-week">${fmtWeek(bestSessions)}</div>
          </div>
        </div>
        <div class="ennätys-card">
          <div class="ennätys-icon">⏱</div>
          <div class="ennätys-body">
            <div class="ennätys-label">Eniten treeniminuutteja viikossa</div>
            <div class="ennätys-value">${bestMinutes.minutes} <span class="ennätys-unit">min</span></div>
            <div class="ennätys-week">${fmtWeek(bestMinutes)}</div>
          </div>
        </div>
        ${longestEntry ? `
        <div class="ennätys-card">
          <div class="ennätys-icon">🕐</div>
          <div class="ennätys-body">
            <div class="ennätys-label">Pisin yksittäinen treeni</div>
            <div class="ennätys-value">${longestEntry.duration} <span class="ennätys-unit">min</span></div>
            <div class="ennätys-week">${longestEntry.type ? escapeHtml(longestEntry.type) + ' · ' : ''}${fmtDate(longestEntry.date)}</div>
          </div>
        </div>` : ''}
      </div>
    `;
    ennatyksetLoaded = true;
    if (!impersonating) { try { localStorage.setItem(lsKey, JSON.stringify({ ts: Date.now(), html: container.innerHTML })); } catch {} }

  } catch (err) {
    console.error('renderEnnatykset:', err);
    container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Lataus epäonnistui.</p></div>';
  }
}

// ============================================================
// TESTIT — 10×100m räpyläpotkutesti
// ============================================================
let testit = null; // null = ei ladattu

async function renderTestit() {
  const container = el('testit-container');
  if (!container) return;

  if (!testit) {
    container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Ladataan…</p></div>';
    try {
      const snap = await getViewDoc().collection('fitTests').orderBy('date', 'asc').get();
      testit = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('renderTestit:', err);
      container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Lataus epäonnistui.</p></div>';
      return;
    }
  }

  if (!testit.length) {
    container.innerHTML = `
      <div class="profile-coming-soon">
        <div class="profile-coming-soon-icon">🏋️</div>
        <p class="profile-coming-soon-title">Ei vielä testejä</p>
        <p class="profile-coming-soon-desc">${impersonating ? 'Ei testejä kirjattuna.' : 'Lisää ensimmäinen 10×100m räpyläpotkutesti.'}</p>
      </div>
      ${!impersonating ? `<div style="padding:0 1rem 1rem">
        <button class="btn-primary" style="width:100%" onclick="openTestitSheet()">+ Lisää testi</button>
      </div>` : ''}`;
    return;
  }

  buildTestitCharts(testit);
}

// Generoi n väriä vanhimmasta (vaalea) uusimpaan (tumma sininen)
function fitTestColors(n) {
  return Array.from({ length: n }, (_, i) => {
    if (n === 1) return '#003F9C';
    const t = i / (n - 1);           // 0 = vanhin, 1 = uusin
    const r = Math.round(155 * (1 - t));
    const g = Math.round(184 - t * 121);
    const b = Math.round(224 - t * 68);
    return `rgb(${r},${g},${b})`;
  });
}

function buildTestitCharts(tests) {
  // Tuhoa vanhat instanssit
  ['testitTime', 'testitHr'].forEach(id => {
    if (chartInstances[id]) { chartInstances[id].destroy(); delete chartInstances[id]; }
  });

  const container = el('testit-container');
  const labels = ['1','2','3','4','5','6','7','8','9','10'];
  const colors = fitTestColors(tests.length);
  const fmtDate = ts => {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  };

  container.innerHTML = `
    <p class="testit-sub-desc">Räpyläpotkuja · Lähtö 2 min<br>Syke 1 heti · Syke 2 tauko 30 s</p>
    <p class="testit-chart-label" style="padding-top:0.5rem">Aika (sekuntia)</p>
    <div class="chart-wrap"><canvas id="chart-testit-time"></canvas></div>
    <p class="testit-chart-label" style="margin-top:1.25rem">Syke (bpm)</p>
    <div class="chart-wrap"><canvas id="chart-testit-hr"></canvas></div>
    <div class="testit-legend">
      <span class="testit-legend-dot"></span>
      <span class="testit-legend-text">Mahdollinen mittavirhe</span>
    </div>
    ${!impersonating ? `<div style="padding:0.75rem 1rem 0">
      <button class="btn-primary" style="width:100%" onclick="openTestitSheet()">+ Lisää testi</button>
    </div>` : ''}
    <div class="testit-delete-section">
      <p class="testit-delete-title">${impersonating ? 'Testit' : 'Poista testi'}</p>
      ${[...tests].reverse().map((t, j) => {
        const color = colors[tests.length - 1 - j];
        return `
        <div class="testit-delete-row">
          <span class="testit-delete-dot" style="background:${color}"></span>
          <span class="testit-delete-date">${fmtDate(t.date)}</span>
          <button class="btn-primary testit-delete-btn" onclick="viewTestitById('${t.id}')">Näytä</button>
          ${!impersonating ? `<button class="btn-danger-outline testit-delete-btn" onclick="deleteTestitById('${t.id}', '${fmtDate(t.date)}')">Poista</button>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;

  const baseLineOpts = {
    type: 'line',
    options: {
      ...chartBaseOptions,
      scales: {
        x: { ...chartBaseOptions.scales.x },
        y: { ...chartBaseOptions.scales.y },
      },
    },
  };

  // ── Aikakaavio ──────────────────────────────────────────────
  chartInstances.testitTime = new Chart(
    el('chart-testit-time').getContext('2d'), {
      ...baseLineOpts,
      data: {
        labels,
        datasets: tests.map((t, i) => ({
          label: fmtDate(t.date),
          data: t.measurements.map(m => m.time ?? null),
          borderColor: colors[i],
          backgroundColor: 'transparent',
          pointBackgroundColor: colors[i],
          borderWidth: i === tests.length - 1 ? 2.5 : 1.5,
          pointRadius: 3,
          tension: 0.2,
          spanGaps: true,
          order: tests.length - 1 - i, // uusin (i=n-1) → order 0 = päällimmäisenä
        })),
      },
    }
  );

  // ── Sykekaavio — syke 1, tooltip näyttää syke 2 ja eron ──────
  chartInstances.testitHr = new Chart(
    el('chart-testit-hr').getContext('2d'), {
      type: 'line',
      options: {
        ...chartBaseOptions,
        scales: {
          x: { ...chartBaseOptions.scales.x },
          y: { ...chartBaseOptions.scales.y },
        },
        plugins: {
          ...chartBaseOptions.plugins,
          tooltip: {
            callbacks: {
              label: ctx => {
                const m = ctx.dataset.measurements?.[ctx.dataIndex];
                if (!m || m.hr1 == null) return `${ctx.dataset.label}: –`;
                return `Syke 1: ${m.hr1} bpm${m.error ? '  ⚠ mittavirhe' : ''}`;
              },
              afterLabel: ctx => {
                const m = ctx.dataset.measurements?.[ctx.dataIndex];
                if (!m) return [];
                const lines = [];
                if (m.hr2 != null) lines.push(`Syke 2: ${m.hr2} bpm${m.error ? '  ⚠' : ''}`);
                if (m.hr1 != null && m.hr2 != null) lines.push(`Ero: ${m.hr1 - m.hr2} bpm`);
                return lines;
              },
              labelColor: ctx => {
                const m = ctx.dataset.measurements?.[ctx.dataIndex];
                const c = m?.error ? '#F5A623' : ctx.dataset.borderColor;
                return { backgroundColor: c, borderColor: c };
              },
            },
          },
        },
      },
      data: {
        labels,
        datasets: tests.map((t, i) => {
          const ptColors = t.measurements.map(m => m.error ? '#F5A623' : colors[i]);
          return {
            label: fmtDate(t.date),
            data: t.measurements.map(m => m.hr1 ?? null),
            measurements: t.measurements,
            borderColor: colors[i],
            backgroundColor: 'transparent',
            pointBackgroundColor: ptColors,
            pointBorderColor: ptColors,
            borderWidth: i === tests.length - 1 ? 2.5 : 1.5,
            pointRadius: 3,
            tension: 0.2,
            spanGaps: true,
            order: tests.length - 1 - i,
          };
        }),
      },
    }
  );
}

// ── Poista testi ──────────────────────────────────────────────
async function deleteTestitById(id, dateStr) {
  const ok = await confirm(`Poistetaanko testi ${dateStr}? Toimintoa ei voi peruuttaa.`);
  if (!ok) return;
  try {
    await getUserDoc().collection('fitTests').doc(id).delete();
    testit = null;
    await renderTestit();
    toast('Testi poistettu.', 'success');
  } catch (err) {
    console.error('deleteTestit:', err);
    toast('Poisto epäonnistui.', 'error');
  }
}

// ── Lisää / Näytä testi -sheet ────────────────────────────────
function viewTestitById(id) {
  const test = testit?.find(t => t.id === id);
  if (test) openTestitSheet(test);
}

function openTestitSheet(viewTest = null) {
  const isView = viewTest !== null;
  const dateInput = el('testit-date');

  if (isView) {
    dateInput.value = timestampToDateStr(viewTest.date);
  } else {
    dateInput.value = timestampToDateStr(new Date());
  }
  dateInput.disabled = isView;

  el('testit-rows').innerHTML = Array.from({ length: 10 }, (_, i) => {
    const m = isView ? (viewTest.measurements[i] || {}) : {};
    const dis = isView ? 'disabled' : '';
    const chk = isView && m.error ? 'checked' : '';
    const tVal = isView && m.time != null ? m.time : '';
    const h1Val = isView && m.hr1 != null ? m.hr1 : '';
    const h2Val = isView && m.hr2 != null ? m.hr2 : '';
    return `
    <div class="testit-row">
      <span class="testit-row-num">${i + 1}</span>
      <input type="number" step="0.1" class="testit-input" id="ti-t${i}" placeholder="s" value="${tVal}" ${dis}>
      <input type="number" class="testit-input" id="ti-h1-${i}" placeholder="bpm" value="${h1Val}" ${dis}>
      <input type="number" class="testit-input" id="ti-h2-${i}" placeholder="bpm" value="${h2Val}" ${dis}>
      <input type="checkbox" id="ti-e${i}" class="testit-checkbox" ${chk} ${dis}>
    </div>`;
  }).join('');

  el('testit-sheet-title').textContent = isView ? 'Räpyläpotkutesti' : 'Uusi kuntotesti';
  el('testit-save-btn').classList.toggle('hidden', isView);

  el('testit-sheet-backdrop').classList.remove('hidden');
  const sheet = el('testit-sheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('sheet-open'));
}

function closeTestitSheet() {
  const sheet = el('testit-sheet');
  sheet.classList.remove('sheet-open');
  sheet.addEventListener('transitionend', () => {
    sheet.classList.add('hidden');
    el('testit-sheet-backdrop').classList.add('hidden');
  }, { once: true });
}

el('testit-sheet-close').addEventListener('click', closeTestitSheet);
el('testit-sheet-backdrop').addEventListener('click', closeTestitSheet);

el('testit-save-btn').addEventListener('click', async () => {
  const dateVal = el('testit-date').value;
  if (!dateVal) { toast('Valitse päivämäärä.', 'error'); return; }

  const measurements = Array.from({ length: 10 }, (_, i) => ({
    time:  parseFloat(el('ti-t' + i)?.value)  || null,
    hr1:   parseInt(el('ti-h1-' + i)?.value)  || null,
    hr2:   parseInt(el('ti-h2-' + i)?.value)  || null,
    error: el('ti-e' + i)?.checked || false,
  }));

  if (!measurements.some(m => m.time !== null)) {
    toast('Syötä vähintään yksi aika-arvo.', 'error'); return;
  }

  const btn = el('testit-save-btn');
  btn.disabled = true; btn.textContent = 'Tallennetaan…';

  try {
    const [y, mo, d] = dateVal.split('-').map(Number);
    const date = firebase.firestore.Timestamp.fromDate(new Date(y, mo - 1, d));
    await getUserDoc().collection('fitTests').add({ date, measurements });
    testit = null; // pakota uudelleenlataus
    closeTestitSheet();
    await renderTestit();
    toast('Testi tallennettu!', 'success');
  } catch (err) {
    console.error('saveTest:', err);
    toast('Tallennus epäonnistui.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Tallenna testi';
  }
});

// ============================================================
// MAX NOPEUS — 25m sukellus max-nopeudella
// ============================================================
let maxSpeedTests = null; // null = ei ladattu
let maxNopeusViewId = null; // näytä/muokkaa-tila

async function renderMaxNopeus() {
  const container = el('maxnopeus-container');
  if (!container) return;

  if (!maxSpeedTests) {
    container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Ladataan…</p></div>';
    try {
      const snap = await getViewDoc().collection('maxSpeedTests').orderBy('date', 'asc').get();
      maxSpeedTests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('renderMaxNopeus:', err);
      container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Lataus epäonnistui.</p></div>';
      return;
    }
  }

  if (!maxSpeedTests.length) {
    container.innerHTML = `
      <p class="testit-sub-desc">25m sukellus max-nopeudella</p>
      <div class="profile-coming-soon">
        <div class="profile-coming-soon-icon">⚡</div>
        <p class="profile-coming-soon-title">Ei vielä tuloksia</p>
        <p class="profile-coming-soon-desc">Lisää ensimmäinen Max Nopeus -tulos.</p>
      </div>
      ${!impersonating ? `<div style="padding:0 1rem 1rem">
        <button class="btn-primary" style="width:100%" onclick="openMaxNopeusSheet()">+ Lisää tulos</button>
      </div>` : ''}`;
    return;
  }

  buildMaxNopeusChart(maxSpeedTests);
}

function buildMaxNopeusChart(tests) {
  if (chartInstances['maxNopeus']) {
    chartInstances['maxNopeus'].destroy();
    delete chartInstances['maxNopeus'];
  }

  const container = el('maxnopeus-container');
  const fmtDate = ts => {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  };

  const labels = tests.map(t => fmtDate(t.date));
  const times  = tests.map(t => typeof t.time === 'object' ? t.time?.doubleValue ?? t.time?.integerValue ?? null : t.time);

  container.innerHTML = `
    <p class="testit-sub-desc">25m sukellus max-nopeudella</p>
    <p class="testit-chart-label" style="padding-top:0.5rem">Aika (sekuntia) — pienempi on parempi</p>
    <div class="chart-wrap"><canvas id="chart-maxnopeus"></canvas></div>
    ${!impersonating ? `<div style="padding:0.75rem 1rem 0">
      <button class="btn-primary" style="width:100%" onclick="openMaxNopeusSheet()">+ Lisää tulos</button>
    </div>` : ''}
    <div class="testit-delete-section">
      <p class="testit-delete-title">Tulokset</p>
      ${[...tests].reverse().map(t => `
        <div class="testit-delete-row">
          <span class="testit-delete-date">${fmtDate(t.date)}</span>
          <span class="testit-delete-date" style="font-weight:700;color:var(--blue-deep)">${typeof t.time === 'object' ? (t.time?.doubleValue ?? t.time?.integerValue) : t.time} s</span>
          ${!impersonating ? `<button class="btn-danger-outline testit-delete-btn" onclick="deleteMaxNopeusById('${t.id}', '${fmtDate(t.date)}')">Poista</button>` : ''}
        </div>`).join('')}
    </div>
  `;

  const ctx = document.getElementById('chart-maxnopeus')?.getContext('2d');
  if (!ctx) return;

  chartInstances['maxNopeus'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: times,
        borderColor: '#003F9C',
        backgroundColor: 'rgba(0,63,156,0.08)',
        borderWidth: 2.5,
        pointRadius: 5,
        pointHoverRadius: 7,
        pointBackgroundColor: '#003F9C',
        fill: true,
        tension: 0.3,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${(+ctx.parsed.y).toFixed(1)} s`,
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 } }
        },
        y: {
          title: { display: false },
          ticks: { font: { size: 11 }, callback: v => (+v).toFixed(1) + ' s' },
          grid: { color: 'rgba(0,0,0,0.06)' }
        }
      }
    }
  });
}

// ============================================================
// LIHASKUNTOTESTI
// ============================================================
let lihasTests = null; // null = ei ladattu

async function renderLihaskunto() {
  const container = el('lihaskunto-container');
  if (!container) return;

  if (!lihasTests) {
    container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Ladataan…</p></div>';
    try {
      const snap = await getViewDoc().collection('muscleTests').orderBy('date', 'asc').get();
      lihasTests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.error('renderLihaskunto:', err);
      container.innerHTML = '<div class="profile-coming-soon"><p class="profile-coming-soon-desc">Lataus epäonnistui.</p></div>';
      return;
    }
  }

  if (!lihasTests.length) {
    container.innerHTML = `
      <div class="profile-coming-soon">
        <div class="profile-coming-soon-icon">💪</div>
        <p class="profile-coming-soon-title">Ei vielä tuloksia</p>
        <p class="profile-coming-soon-desc">
          Lihaskuntotesti mittaa kehonpainolla tehtävien liikkeiden toistomäärät:<br><br>
          Toes to Bar · Knees to Chest · Leuanveto · Vauhditon pituushyppy · Punnerrus<br><br>
          ${!impersonating ? 'Lisää ensimmäinen testi alla olevasta napista.' : 'Ei kirjattuja testejä.'}
        </p>
      </div>
      ${!impersonating ? `<div style="padding:0 1rem 1rem">
        <button class="btn-primary" style="width:100%" onclick="openLihasSheet()">+ Lisää testi</button>
      </div>` : ''}`;
    return;
  }

  const teamData = await loadLihasTeamData();
  buildLihaskuntoCharts(lihasTests, teamData);
}

// ── Joukkueen lihaskuntodatan haku (välimuistitettu 4 h) ──────
const LIHAS_TEAM_CACHE_VERSION = 2; // bump to force cache invalidation
async function loadLihasTeamData() {
  const uid = impersonating ? impersonating.uid : currentUser.uid;
  const cacheKey = `uppis_lihas_team_${uid}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && cached.v === LIHAS_TEAM_CACHE_VERSION && Date.now() - cached.ts < 8 * 3600 * 1000) return cached.data;
  } catch {}

  const myTeams = (impersonating ? impersonating.profile?.teams : userProfile?.teams) || [];
  if (!myTeams.length) return null;

  try {
    const usersSnap = await db.collection('users')
      .where('profile.teams', 'array-contains-any', myTeams.slice(0, 10))
      .get();

    const memberDocs = usersSnap.docs.filter(d => d.id !== uid);

    const latestTests = (await Promise.all(
      memberDocs.map(async userDoc => {
        try {
          const snap = await db.collection('users').doc(userDoc.id)
            .collection('muscleTests').orderBy('date', 'desc').limit(1).get();
          return snap.empty ? null : snap.docs[0].data();
        } catch { return null; }
      })
    )).filter(Boolean);

    const agg = {};
    LIHAS_EXERCISES.forEach(ex => {
      const vals = latestTests
        .map(t => t[ex.key] != null ? Number(t[ex.key]) : null)
        .filter(v => v !== null);
      agg[ex.key] = vals.length ? {
        min: Math.min(...vals),
        max: Math.max(...vals),
        avg: Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10,
      } : null;
    });

    try { localStorage.setItem(cacheKey, JSON.stringify({ v: LIHAS_TEAM_CACHE_VERSION, ts: Date.now(), data: agg })); } catch {}
    return agg;
  } catch (err) {
    console.error('loadLihasTeamData:', err);
    return null;
  }
}

function buildLihaskuntoCharts(tests, teamData) {
  // Destroy old chart instances
  LIHAS_EXERCISES.forEach(ex => {
    const key = 'lihas_' + ex.key;
    if (chartInstances[key]) { chartInstances[key].destroy(); delete chartInstances[key]; }
  });

  const container = el('lihaskunto-container');
  const fmtDate = ts => {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  };

  const dateLabels = tests.map(t => fmtDate(t.date));
  const hasTeam = !!teamData;

  // Build chart HTML for each exercise that has at least one non-null value
  let chartsHtml = '<p class="testit-sub-desc">Kehonpainoliikkeet · Toistojen lukumäärä</p>';
  if (hasTeam) {
    chartsHtml += `<div class="lihas-legend">
      <span class="lihas-legend-item"><span class="lihas-legend-dash lihas-legend-dash--dot" style="border-color:#F5A623"></span>Paras tulos</span>
    </div>`;
  }
  LIHAS_EXERCISES.forEach(ex => {
    const values = tests.map(t => {
      const v = t[ex.key];
      return (v === null || v === undefined) ? null : Number(v);
    });
    const hasData = values.some(v => v !== null);
    if (!hasData) return;
    chartsHtml += `
      <p class="testit-chart-label" style="padding-top:0.75rem;color:${ex.color}">${ex.label} <span style="font-weight:400;color:var(--text-muted)">(${ex.unit})</span></p>
      <div class="chart-wrap"><canvas id="chart-lihas-${ex.key}"></canvas></div>`;
  });

  // Sessions list
  chartsHtml += `
    ${!impersonating ? `<div style="padding:0.75rem 1rem 0">
      <button class="btn-primary" style="width:100%" onclick="openLihasSheet()">+ Lisää testi</button>
    </div>` : ''}
    <div class="testit-delete-section">
      <p class="testit-delete-title">${impersonating ? 'Testit' : 'Poista testi'}</p>
      ${[...tests].reverse().map(t => `
        <div class="testit-delete-row">
          <span class="testit-delete-date">${fmtDate(t.date)}</span>
          ${!impersonating ? `<button class="btn-danger-outline testit-delete-btn" onclick="deleteLihasById('${t.id}', '${fmtDate(t.date)}')">Poista</button>` : ''}
        </div>`).join('')}
    </div>`;

  container.innerHTML = chartsHtml;

  // Build Chart.js charts
  LIHAS_EXERCISES.forEach(ex => {
    const canvas = document.getElementById('chart-lihas-' + ex.key);
    if (!canvas) return;
    const values = tests.map(t => {
      const v = t[ex.key];
      return (v === null || v === undefined) ? null : Number(v);
    });
    const hasData = values.some(v => v !== null);
    if (!hasData) return;

    const team = teamData?.[ex.key] || null;
    const ownVals = values.filter(v => v !== null);
    // Y-axis min driven by team's worst result (or own min if no team data)
    const scaleMin = team ? Math.min(team.min, ...ownVals) : Math.min(...ownVals);
    const scaleMax = team ? Math.max(team.max, ...ownVals) : Math.max(...ownVals);
    const pad = Math.max((scaleMax - scaleMin) * 0.15, 1);

    const datasets = [{
      label: 'Oma',
      data: values,
      borderColor: ex.color,
      backgroundColor: ex.color + '14',
      borderWidth: 2.5,
      pointRadius: 5,
      pointHoverRadius: 7,
      pointBackgroundColor: ex.color,
      fill: true,
      tension: 0.3,
      spanGaps: true,
      order: 1,
    }];

    if (team) {
      datasets.push({
        label: 'Paras tulos',
        data: dateLabels.map(() => team.max),
        borderColor: '#F5A623',
        borderWidth: 1.5,
        borderDash: [2, 3],
        pointRadius: 0,
        fill: false,
        tension: 0,
        order: 2,
      });
    }

    chartInstances['lihas_' + ex.key] = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: dateLabels, datasets },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const v = ctx.parsed.y;
                if (v === null) return '–';
                return `${ctx.dataset.label}: ${v} ${ex.unit}`;
              },
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: {
            ticks: { font: { size: 11 }, callback: v => v + (ex.unit === 'cm' ? ' cm' : '') },
            grid: { color: 'rgba(0,0,0,0.06)' },
            suggestedMin: Math.max(0, scaleMin - pad),
            suggestedMax: scaleMax + pad,
          }
        }
      }
    });
  });
}

window.deleteLihasById = async function(id, dateStr) {
  const yes = await confirm(`Poistetaanko testi ${dateStr}?`);
  if (!yes) return;
  try {
    await getUserDoc().collection('muscleTests').doc(id).delete();
    lihasTests = null;
    try { localStorage.removeItem(`uppis_lihas_team_${currentUser.uid}`); } catch {}
    renderLihaskunto();
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui.', 'error');
  }
};

function openLihasSheet() {
  el('lihas-date').value = timestampToDateStr(new Date());
  ['toesToBar','kneesToChest','leuanveto','pituushyppy','punnerrus','punnerrusPolvetMaassa'].forEach(k => {
    el('lihas-' + k).value = '';
  });
  el('lihas-sheet-backdrop').classList.remove('hidden');
  const sheet = el('lihas-sheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('sheet-open'));
}

function closeLihasSheet() {
  const sheet = el('lihas-sheet');
  sheet.classList.remove('sheet-open');
  sheet.addEventListener('transitionend', () => {
    sheet.classList.add('hidden');
    el('lihas-sheet-backdrop').classList.add('hidden');
  }, { once: true });
}

el('lihas-sheet-close').addEventListener('click', closeLihasSheet);
el('lihas-sheet-backdrop').addEventListener('click', closeLihasSheet);

el('lihas-save-btn').addEventListener('click', async () => {
  const dateVal = el('lihas-date').value;
  if (!dateVal) { toast('Valitse päivämäärä.', 'error'); return; }
  const parse = id => {
    const v = parseFloat(el(id).value);
    return isNaN(v) ? null : v;
  };
  const data = {
    date: new Date(dateVal + 'T12:00:00'),
    toesToBar:             parse('lihas-toesToBar'),
    kneesToChest:          parse('lihas-kneesToChest'),
    leuanveto:             parse('lihas-leuanveto'),
    pituushyppy:           parse('lihas-pituushyppy'),
    punnerrus:             parse('lihas-punnerrus'),
    punnerrusPolvetMaassa: parse('lihas-punnerrusPolvetMaassa'),
  };
  const btn = el('lihas-save-btn');
  btn.disabled = true;
  try {
    await getUserDoc().collection('muscleTests').add(data);
    lihasTests = null;
    // Invalidate team cache so reference lines refresh with new data
    try { localStorage.removeItem(`uppis_lihas_team_${currentUser.uid}`); } catch {}
    closeLihasSheet();
    haptic('success');
    toast('Lihaskuntotesti tallennettu!', 'success');
    renderLihaskunto();
  } catch (err) {
    console.error(err);
    haptic('error');
    toast('Tallennus epäonnistui.', 'error');
  } finally {
    btn.disabled = false;
  }
});

function openMaxNopeusSheet() {
  el('maxnopeus-date').value = timestampToDateStr(new Date());
  el('maxnopeus-time').value = '';
  el('maxnopeus-sheet-title').textContent = 'Uusi tulos';
  el('maxnopeus-sheet-backdrop').classList.remove('hidden');
  const sheet = el('maxnopeus-sheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('sheet-open'));
}

function closeMaxNopeusSheet() {
  const sheet = el('maxnopeus-sheet');
  sheet.classList.remove('sheet-open');
  sheet.addEventListener('transitionend', () => {
    sheet.classList.add('hidden');
    el('maxnopeus-sheet-backdrop').classList.add('hidden');
  }, { once: true });
}

async function deleteMaxNopeusById(id, dateStr) {
  const yes = await dangerConfirm(`Poistetaanko tulos ${dateStr} pysyvästi?`);
  if (!yes) return;
  try {
    await getUserDoc().collection('maxSpeedTests').doc(id).delete();
    maxSpeedTests = null;
    await renderMaxNopeus();
    toast('Tulos poistettu.', 'success');
  } catch (err) {
    console.error(err);
    toast('Poisto epäonnistui.', 'error');
  }
}

el('maxnopeus-sheet-close').addEventListener('click', closeMaxNopeusSheet);
el('maxnopeus-sheet-backdrop').addEventListener('click', closeMaxNopeusSheet);

el('maxnopeus-save-btn').addEventListener('click', async () => {
  const dateVal = el('maxnopeus-date').value;
  const timeVal = parseFloat(el('maxnopeus-time').value);
  if (!dateVal) { toast('Valitse päivämäärä.', 'error'); return; }
  if (isNaN(timeVal) || timeVal <= 0) { toast('Syötä kelvollinen aika.', 'error'); return; }

  const btn = el('maxnopeus-save-btn');
  btn.disabled = true; btn.textContent = 'Tallennetaan…';

  try {
    const [y, mo, d] = dateVal.split('-').map(Number);
    const date = firebase.firestore.Timestamp.fromDate(new Date(y, mo - 1, d));
    await getUserDoc().collection('maxSpeedTests').add({ date, time: timeVal });
    maxSpeedTests = null;
    closeMaxNopeusSheet();
    await renderMaxNopeus();
    toast('Tulos tallennettu!', 'success');
  } catch (err) {
    console.error('saveMaxNopeus:', err);
    toast('Tallennus epäonnistui.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Tallenna tulos';
  }
});

// Nollaa ennätyscache kun entryjä muutetaan (entries.js kutsuu tätä)
function invalidateEnnatykset() {
  ennatyksetLoaded = false;
  if (!currentUser) return;
  try { localStorage.removeItem('uppis_records_' + currentUser.uid); } catch {}
}

// ============================================================
// EXPORT DATA
// ============================================================
el('export-data-btn').addEventListener('click', async () => {
  try {
    toast('Valmistellaan vientitiedostoa…', 'info');
    const uid = currentUser.uid;

    // Fetch all entries
    const snap = await db.collection('users').doc(uid).collection('entries')
      .orderBy('date', 'desc').get();

    const fmtDate = ts => {
      if (!ts) return '';
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      return d.toLocaleDateString('fi-FI', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    const PERF_LABELS_CSV = ['', 'I Peruskunto', 'II Kestävyys', 'III Maksimikestävyys', 'IV Nopeuskestävyys', 'V Nopeus'];
    const FEEL_LABELS_CSV = ['', 'Erittäin väsynyt', 'Väsynyt', 'Normaali', 'Hyvä', 'Erinomainen'];

    const headers = ['Päivämäärä','Laji','Kesto (min)','Tehoalue','Fiilis','Matka (km)','Keskisyke','Maksimisyke','Kommentti'];
    const rows = snap.docs.map(doc => {
      const d = doc.data();
      const escape = v => v != null ? `"${String(v).replace(/"/g, '""')}"` : '';
      return [
        fmtDate(d.date),
        escape(d.type || ''),
        d.duration != null ? d.duration : '',
        escape(PERF_LABELS_CSV[d.performance] || ''),
        escape(FEEL_LABELS_CSV[d.feeling] || ''),
        d.distance != null ? String(d.distance).replace('.', ',') : '',
        d.avgHr != null ? d.avgHr : '',
        d.maxHr != null ? d.maxHr : '',
        escape(d.comment || ''),
      ].join(';');
    });

    const bom = '﻿'; // UTF-8 BOM for Excel
    const csv = bom + headers.join(';') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const name = userProfile?.nickname || userProfile?.firstName || 'treenit';
    a.href     = url;
    a.download = `uwr-diary-${name.toLowerCase()}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`${snap.size} treeniä viety CSV-tiedostoon.`, 'success');
  } catch (err) {
    console.error('Export error:', err);
    toast('Vienti epäonnistui.', 'error');
  }
});

// DELETE OWN ACCOUNT
// ============================================================
el('delete-own-account-btn').addEventListener('click', async () => {
  const yes = await dangerConfirm('Poistetaanko tilisi ja kaikki harjoitustiedot pysyvästi?');
  if (!yes) return;
  try {
    const uid = currentUser.uid;
    await deleteAllUserData(uid);
    await currentUser.delete();
    closeProfileModal();
  } catch (err) {
    console.error(err);
    if (err.code === 'auth/requires-recent-login') {
      toast('Kirjaudu ulos ja uudelleen sisään, sitten yritä uudelleen.', 'error');
    } else {
      toast('Poisto epäonnistui: ' + err.message, 'error');
    }
  }
});
