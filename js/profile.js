// ============================================================
// PROFILE — load, display, modal
// ============================================================
async function loadProfile() {
  try {
    const snap = await getUserDoc().get();
    const remoteProfile = snap.exists ? (snap.data().profile || {}) : {};
    const remoteEmail   = snap.exists ? snap.data().email : null;
    // coachOf lives at root of user doc (not inside profile)
    const remoteCoachOf = snap.exists ? (snap.data().coachOf || []) : [];

    // Only write email to Firestore if it's missing or changed (saves a write on most logins)
    if (remoteEmail !== currentUser.email) {
      getUserDoc().set({ email: currentUser.email }, { merge: true });
    }

    // Update cache only if data actually changed
    const cached = Cache.get(currentUser.uid, 'profile');
    if (Cache.fingerprint(remoteProfile) !== Cache.fingerprint(cached)) {
      Cache.set(currentUser.uid, 'profile', remoteProfile);
    }

    userProfile = { ...remoteProfile, coachOf: remoteCoachOf };
  } catch (err) {
    console.error('loadProfile failed:', err);
    if (!userProfile || !Object.keys(userProfile).length) userProfile = {};
  }
  updateHeaderProfile();
  updateAdminShortcut();
}

// Show/hide the ⚙ admin shortcut in the header (admin or coach)
function updateAdminShortcut() {
  const isAdmin = currentUser?.email === ADMIN_EMAIL;
  const isCoach = (userProfile.coachOf || []).length > 0;
  el('admin-shortcut-btn')?.classList.toggle('hidden', !isAdmin && !isCoach);
}

function updateHeaderProfile() {
  const displayName = userProfile.nickname || userProfile.firstName || '';
  el('header-firstname').textContent = displayName;

  const avatarImg  = el('header-avatar');
  const initialsEl = el('header-initials');

  if (userProfile.photoURL) {
    avatarImg.src = userProfile.photoURL;
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

el('help-btn').addEventListener('click', () => {
  // Populate version bar dynamically
  const vMatch = document.querySelector('link[href*="styles.css"]')
    ?.getAttribute('href')?.match(/v=(\d+)/);
  const build = vMatch ? vMatch[1] : '—';
  const updated = new Date(document.lastModified)
    .toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  el('help-version-text').textContent  = `Versio 1.3 (build ${build})`;
  el('help-updated-text').textContent  = `Päivitetty ${updated}`;

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

function openProfileModal() {
  pendingAvatarDataUrl = null;
  el('avatar-size-hint').textContent = '';

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
  syncShareCommentsState();
  updateAgeDisplay(userProfile.birthday || '');

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

  const updated = {
    nickname:  el('profile-nickname').value.trim(),
    firstName: el('profile-firstname').value.trim(),
    lastName:  el('profile-lastname').value.trim(),
    gender:    el('profile-gender').value,
    birthday:  el('profile-birthday').value || '',
    teams:            Array.from(document.querySelectorAll('input[name="profile-team"]:checked')).map(cb => cb.value),
    shareActivities:  el('profile-share-activities').checked,
    shareComments:    el('profile-share-comments').checked,
  };

  if (pendingAvatarDataUrl !== null) {
    updated.photoURL = pendingAvatarDataUrl;  // '' means removed
  } else {
    updated.photoURL = userProfile.photoURL || '';
  }

  try {
    await getUserDoc().update({ profile: updated });
  } catch (err) {
    if (err.code === 'not-found') {
      await getUserDoc().set({ email: currentUser.email, profile: updated });
    } else {
      console.error('Profile save failed:', err);
      toast('Profiilin tallennus epäonnistui: ' + err.message, 'error');
      return;
    }
  }
  Cache.set(currentUser.uid, 'profile', updated);
  userProfile = updated;
  updateHeaderProfile();
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

  // 3. Delete own entries and user document
  const entriesSnap = await userRef.collection('entries').get();
  const batch = db.batch();
  entriesSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(userRef);
  await batch.commit();
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
