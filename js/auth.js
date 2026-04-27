// ============================================================
// AUTH VIEW
// ============================================================

// Render onboarding team checkboxes from TEAMS constant
renderTeamCheckboxes('ob-team-group', 'ob-team');

// Show forgot-password link only in login mode
function updateForgotVisibility() {
  const wrap = el('forgot-wrap');
  if (wrap) wrap.style.display = isLoginMode ? '' : 'none';
}

el('login-tab').addEventListener('click', () => {
  isLoginMode = true;
  el('login-tab').classList.add('active');
  el('register-tab').classList.remove('active');
  el('auth-submit').textContent = 'Kirjaudu';
  el('auth-error').textContent  = '';
});

el('register-tab').addEventListener('click', () => {
  isLoginMode = false;
  el('register-tab').classList.add('active');
  el('login-tab').classList.remove('active');
  el('auth-submit').textContent = 'Rekisteröidy';
  el('auth-error').textContent  = '';
});

el('login-tab').addEventListener('click', updateForgotVisibility);
el('register-tab').addEventListener('click', updateForgotVisibility);

el('forgot-btn').addEventListener('click', async () => {
  const email   = el('auth-email').value.trim();
  const errorEl = el('auth-error');
  const successEl = el('forgot-success');
  errorEl.textContent   = '';
  successEl.textContent = '';
  successEl.classList.add('hidden');

  if (!email) {
    errorEl.textContent = 'Kirjoita ensin sähköpostiosoitteesi ylläolevaan kenttään.';
    return;
  }

  const btn = el('forgot-btn');
  btn.disabled = true;
  try {
    await auth.sendPasswordResetEmail(email);
    successEl.textContent = `Salasanan palautuslinkki lähetetty osoitteeseen ${email}. Tarkista myös roskapostikansio.`;
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.code);
  } finally {
    btn.disabled = false;
  }
});

el('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = el('auth-email').value.trim();
  const password = el('auth-password').value;
  const errorEl  = el('auth-error');
  errorEl.textContent = '';
  el('auth-submit').disabled = true;

  try {
    if (isLoginMode) {
      isNewRegistration = false;
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      isNewRegistration = true;
      await auth.createUserWithEmailAndPassword(email, password);
    }
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.code);
    el('auth-submit').disabled = false;
  }
});

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found':        'Tällä sähköpostilla ei löydy tiliä.',
    'auth/wrong-password':        'Väärä salasana.',
    'auth/invalid-credential':    'Virheellinen sähköposti tai salasana.',
    'auth/email-already-in-use':  'Sähköposti on jo rekisteröity.',
    'auth/weak-password':         'Salasanan tulee olla vähintään 6 merkkiä.',
    'auth/invalid-email':         'Virheellinen sähköpostiosoite.',
    'auth/too-many-requests':     'Liian monta yritystä. Yritä myöhemmin uudelleen.',
    'auth/operation-not-allowed': 'Sähköpostikirjautuminen ei ole käytössä.',
    'auth/network-request-failed':'Verkkovirhe. Tarkista yhteys.',
    'auth/internal-error':        'Firebase-virhe. Tarkista asetukset.',
  };
  return map[code] || `Virhe: ${code || 'tuntematon'}`;
}

el('logout-btn').addEventListener('click', async () => {
  closeProfileModal();
  if (unsubEntries) { unsubEntries(); unsubEntries = null; }
  await auth.signOut();
});

auth.onAuthStateChanged(async (user) => {
  currentUser = user;
  if (user) {
    hide('auth-view');
    el('auth-submit').disabled = false;

    // 1. Serve profile from cache instantly (zero reads)
    const cachedProfile = Cache.get(user.uid, 'profile');
    if (cachedProfile) {
      userProfile = cachedProfile;
      updateHeaderProfile();
    }

    // 2. Load from Firestore
    await loadProfile();
    await loadAppSettings();

    // 3. New registration → show onboarding instead of app
    if (isNewRegistration && !userProfile.onboardingDone) {
      show('onboarding-modal');
      return;
    }

    show('app-view');
    // 4. Start entries (also cache-aware)
    loadEntries();
  } else {
    if (unsubEntries) unsubEntries();
    userProfile = {};
    hide('app-view');
    hide('onboarding-modal');
    show('auth-view');
  }
});

// ── Onboarding form ────────────────────────────────────────────
el('onboarding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Tallennetaan…';

  const firstName = el('ob-firstname').value.trim();
  const teams = [...document.querySelectorAll('input[name="ob-team"]:checked')].map(c => c.value);
  const shareActivities = el('ob-share-activities').checked;
  const shareComments   = el('ob-share-comments').checked;

  try {
    const profile = {
      firstName,
      teams,
      shareActivities,
      shareComments,
      onboardingDone: true,
    };
    await getUserDoc().set({ profile }, { merge: true });
    userProfile = { ...userProfile, ...profile };
    Cache.set(currentUser.uid, 'profile', userProfile);
    updateHeaderProfile();
    isNewRegistration = false;
    hide('onboarding-modal');
    show('app-view');
    loadEntries();
  } catch (err) {
    console.error('Onboarding save failed:', err);
    btn.disabled = false;
    btn.textContent = 'Aloita käyttö →';
    toast('Tallennus epäonnistui, yritä uudelleen.', 'error');
  }
});
