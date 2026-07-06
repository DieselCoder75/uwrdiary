// ============================================================
// AUTH VIEW
// ============================================================

// ── Sovellusversio (näytetään splash-näytön alaosassa) ───────
// Sama formaatti kuin Käyttöohjeen alussa: "Versio 1.6 (build N)".
// Build-numero luetaan styles.css?v=N -parametrista.
(() => {
  const v = document.getElementById('auth-version');
  if (!v) return;
  const m = document.querySelector('link[href*="styles.css"]')
    ?.getAttribute('href')?.match(/v=(\d+)/);
  const build = m ? m[1] : '—';
  v.textContent = `Versio 1.8 (build ${build})`;
})();

// ── Päivän tervehdys ──────────────────────────────────────────
// Vaihtuu vrk-ajan mukaan. Käyttää localStorageen cachetettua
// etunimeä → näkyy heti splash-näytössä ennen Firestore-hakua.
const FIRSTNAME_LS_KEY = 'uppis_firstname';
function _greetingForHour(h) {
  if (h >= 5  && h < 10) return 'Hyvää huomenta';
  if (h >= 10 && h < 17) return 'Hyvää päivää';
  if (h >= 17 && h < 22) return 'Hyvää iltaa';
  return 'Hyvää yötä';
}
function renderAuthGreeting() {
  const el = document.getElementById('auth-greeting');
  if (!el) return;
  const name = localStorage.getItem(FIRSTNAME_LS_KEY) || '';
  if (!name) { el.textContent = ''; return; }
  el.textContent = `${_greetingForHour(new Date().getHours())}, ${name} 👋`;
}
renderAuthGreeting();

// ── Viikko + tehoalue splash-näytölle ────────────────────────
// Näytetään vain splashilla (auth-splash / auth-animating), ei login-lomakkeessa.
// Käyttää WEEKLY_PLAN + calPlannedZone (calendar.js ladattu ennen auth.js:ää).
(function renderAuthWeekZone() {
  const wzel = document.getElementById('auth-week-zone');
  if (!wzel) return;
  try {
    const monday  = weeksAgoMonday(0);
    const { week } = calIsoWeekData(monday);
    const zone    = calPlannedZone(monday);
    if (!zone) { wzel.innerHTML = `<span class="auth-wz-week">Viikko ${week}</span>`; return; }
    const zoneNums = parseZoneStr(zone);
    const zoneNum  = zoneNums[zoneNums.length - 1] || 0;
    const color     = zoneNum ? PERF_COLORS[zoneNum - 1]      : 'var(--blue)';
    const colorDark = zoneNum ? PERF_COLORS_DARK[zoneNum - 1] : 'var(--blue-mid)';
    const label     = zoneNum ? PERF_LABELS[zoneNum].split(' – ')[1] : zone;
    wzel.innerHTML =
      `<span class="auth-wz-week">Viikko ${week}</span>` +
      `<span class="auth-wz-badge" style="background:${color}33;color:${colorDark};border-color:${color}66">${escapeHtml(zone)} – ${escapeHtml(label)}</span>`;
  } catch(e) {}
})();

// ── Reload splash ─────────────────────────────────────────────
// Jos käyttäjä on aiemmin kirjautunut, näytetään iso logo välittömästi
// jotta sisäänkirjautumislomake ei vilahdeta latauksen aikana.
const SPLASH_LS_KEY = 'uppis_was_logged_in';
let splashStart = null;

// ── Satunnainen logo-kuva kirjautumissivulle ──────────────────
// Lisää kuvia kansioon img/splash/ ja tähän listaan.
// Käytä tools/resize-splash.html kuvan muokkaukseen (512×512 px).
// Jos lista on tyhjä tai kuvaa ei löydy, käytetään oletuksena icon-512.png.
const SPLASH_LOGO_IMAGES = [
  'img/splash/splash-1.png',
  'img/splash/splash-2.png',
  'img/splash/splash-3.png',
  'img/splash/splash-4.png',
];

const SPLASH_FALLBACK     = 'icon-512.png';
const SPLASH_NEXT_LS_KEY  = 'uppis_next_splash'; // edellisellä sessiolla esiladattu kuva

// ── Pick nykyiselle sessiolle ──────────────────────────────
// Käytä edellisellä sessiolla esiladattua kuvaa (selaimessa cachessa) → ei
// välkähdystä. Jos ensimmäinen kerta tai esilataus puuttuu → arvo nyt.
let _splashLogoPick = null;
if (SPLASH_LOGO_IMAGES.length > 0) {
  const stored = localStorage.getItem(SPLASH_NEXT_LS_KEY);
  _splashLogoPick = (stored && SPLASH_LOGO_IMAGES.includes(stored))
    ? stored
    : SPLASH_LOGO_IMAGES[Math.floor(Math.random() * SPLASH_LOGO_IMAGES.length)];

  // Esivalitse + esilataa SEURAAVAN session kuva → cachetaan nyt
  const next = SPLASH_LOGO_IMAGES[Math.floor(Math.random() * SPLASH_LOGO_IMAGES.length)];
  localStorage.setItem(SPLASH_NEXT_LS_KEY, next);
  new Image().src = next; // browser cache warm-up
}

// Asettaa logoImg.src:n välittömästi. onerror-fallback jos kuva 404.
function _setSplashLogo(logoImg, src, fallback) {
  if (!logoImg || !src) return;
  logoImg.onerror = () => { if (fallback && logoImg.src !== fallback) logoImg.src = fallback; };
  logoImg.src = src;
}

// Login-lomake: vaihda logo splash-kuvaksi heti
if (_splashLogoPick) {
  _setSplashLogo(document.querySelector('.auth-logo img'), _splashLogoPick, null);
}

(function initSplash() {
  if (localStorage.getItem(SPLASH_LS_KEY) === '1') {
    const container = document.querySelector('.auth-container');
    const logoImg   = container && container.querySelector('.auth-logo img');
    if (container) container.classList.add('auth-splash');
    _setSplashLogo(logoImg, _splashLogoPick || SPLASH_FALLBACK, SPLASH_FALLBACK);
    splashStart = Date.now();
  }
})();

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

let justLoggedIn = false; // true only after manual login form submit (not page reload)

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
      justLoggedIn = true;
      await auth.signInWithEmailAndPassword(email, password);
    } else {
      isNewRegistration = true;
      justLoggedIn = false;
      await auth.createUserWithEmailAndPassword(email, password);
    }
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err.code);
    el('auth-submit').disabled = false;
    justLoggedIn = false;
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
    el('auth-submit').disabled = false;

    // 1. Serve profile from cache instantly (zero reads)
    const cachedProfile = Cache.get(user.uid, 'profile');
    if (cachedProfile) {
      userProfile = cachedProfile;
      updateHeaderProfile();
    }

    if (justLoggedIn) {
      // ── Manual login: play brand animation for ~2 s ──────────
      justLoggedIn = false;
      const container = document.querySelector('.auth-container');
      const logoImg = container && container.querySelector('.auth-logo img');
      // Käytä samaa satunnaista splash-kuvaa animaatiossa (jos ladattu) — muuten icon-512.png
      if (logoImg) _setSplashLogo(logoImg, _splashLogoPick || 'icon-512.png', 'icon-512.png');
      if (container) container.classList.add('auth-animating');

      // Load data and wait at least 2 s (so animation can finish)
      await Promise.all([
        (async () => { await loadProfile(); await loadAppSettings(); })(),
        new Promise(r => setTimeout(r, 3500))
      ]);

      if (container) container.classList.remove('auth-animating');
      if (logoImg) logoImg.src = 'icon-192.png';
      localStorage.setItem(SPLASH_LS_KEY, '1');
      hide('auth-view');

      if (isNewRegistration && !userProfile.onboardingDone) {
        show('onboarding-modal');
        return;
      }
      show('app-view');
      loadEntries();
    } else {
      // ── Page reload / auto-login: pidä splash näkyvissä ~1 s ─
      const container = document.querySelector('.auth-container');
      const logoImg   = container && container.querySelector('.auth-logo img');

      const elapsed = splashStart ? Date.now() - splashStart : 1000;
      await Promise.all([
        (async () => { await loadProfile(); await loadAppSettings(); })(),
        new Promise(r => setTimeout(r, Math.max(0, 1500 - elapsed)))
      ]);

      if (container) container.classList.remove('auth-splash');
      if (logoImg)   logoImg.src = 'icon-192.png';
      localStorage.setItem(SPLASH_LS_KEY, '1');
      hide('auth-view');

      // 3. New registration → show onboarding instead of app
      if (isNewRegistration && !userProfile.onboardingDone) {
        show('onboarding-modal');
        return;
      }
      show('app-view');
      // 4. Start entries (also cache-aware)
      loadEntries();
    }
  } else {
    if (unsubEntries) unsubEntries();
    // Reset all in-memory state so the next user starts clean
    userProfile              = {};
    impersonating            = null;
    allEntries               = [];
    allChartEntries          = [];
    cachedTeamMemberEntries  = {};
    // joukkue state
    myGlobalReactions        = {};
    myGlobalReactionsLoaded  = false;
    joukkueFeedItems         = [];
    joukkueFeedRendered      = 0;
    joukkueAvatarCache       = {};
    joukkueFeedCacheTs       = 0;
    joukkueFeedCacheData     = null;
    Object.keys(myReactionsCache).forEach(k => delete myReactionsCache[k]);
    // admin state
    cachedAdminUsers         = null;
    cachedAdminUsersTs       = 0;
    calLoadedForUid          = null;
    localStorage.removeItem(SPLASH_LS_KEY);
    localStorage.removeItem(FIRSTNAME_LS_KEY);
    const g = document.getElementById('auth-greeting');
    if (g) g.textContent = '';
    // Poista splash jos se oli näkyvissä (istunto vanhentunut tms.)
    const container = document.querySelector('.auth-container');
    const logoImg   = container && container.querySelector('.auth-logo img');
    if (container) container.classList.remove('auth-splash');
    if (logoImg)   logoImg.src = 'icon-192.png';
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
