// ============================================================
// FIREBASE CONFIGURATION
// Replace with your own project config from the Firebase console
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyAAMnqhZq682004Ts0RaYxGLY-v54qj3UI",
  authDomain: "uwrdiary.firebaseapp.com",
  projectId: "uwrdiary",
  storageBucket: "uwrdiary.firebasestorage.app",
  messagingSenderId: "1099287377245",
  appId: "1:1099287377245:web:ff2bf47483449b547aa4b4"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

// ============================================================
// STATE
// ============================================================
let currentUser    = null;
let currentEntryId = null;  // null = new entry, string = editing
let perfValue      = 0;
let feelValue      = 0;
let unsubEntries   = null;
let userProfile    = {};
let pendingAvatarDataUrl = null;  // base64 image staged for save
let allEntries     = [];          // cached flat array for charts
let chartInstances = {};          // Chart.js instances keyed by id

// Vertailu filter / metric state
let vertailuMetric     = 'minutes'; // 'minutes' | 'sessions'
let vertailuPerfFilter = [];        // [] = all zones, [1,3] = only zones I and III
let cachedTeamMemberEntries = {};   // uid → array of plain entry objects

// Chart entries — full 12-week window, independent of Treenit pagination
let allChartEntries   = [];
const CHART_CACHE_TTL = 60 * 60 * 1000;  // 1 h

// Joukkue feed cache state
let joukkueFeedCacheTs   = 0;
let joukkueFeedCacheData = null;
const JOUKKUE_CACHE_TTL  = 45 * 60 * 1000;   // 45 min (was 15)
const REACTION_EMOJIS    = ['🔥', '💪', '👏', '🎉', '😅', '🥇'];

// In-memory cache for current user's own reactions per entry (avoids re-reading on tab switches)
// key: "ownerUid_entryId" → emoji string or null
const myReactionsCache = {};

const ADMIN_EMAIL  = 'janne.lind@gmail.com';

// Pagination state
const PAGE_WEEKS   = 4;
let pageWindowStart = null;  // Date: beginning of current window (oldest shown)
let olderDocs       = [];    // docs fetched for older pages
let hasMorePages    = true;

// ============================================================
// LOCAL CACHE  (localStorage, keyed by uid)
// ============================================================
const Cache = {
  _key(uid, suffix) { return `uppis_${uid}_${suffix}`; },

  set(uid, suffix, data) {
    try {
      localStorage.setItem(this._key(uid, suffix), JSON.stringify({ ts: Date.now(), data }));
    } catch (e) { /* storage full — ignore */ }
  },

  get(uid, suffix) {
    try {
      const raw = localStorage.getItem(this._key(uid, suffix));
      return raw ? JSON.parse(raw).data : null;
    } catch { return null; }
  },

  // Returns a lightweight fingerprint of serialisable data for change detection
  fingerprint(data) {
    return JSON.stringify(data);
  },

  clear(uid) {
    Object.keys(localStorage)
      .filter(k => k.startsWith(`uppis_${uid}_`))
      .forEach(k => localStorage.removeItem(k));
  },
};

// ============================================================
// HELPERS
// ============================================================
function show(id)  { document.getElementById(id).classList.remove('hidden'); }
function hide(id)  { document.getElementById(id).classList.add('hidden'); }
function el(id)    { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getUserEntries() {
  return db.collection('users').doc(currentUser.uid).collection('entries');
}

function getUserDoc() {
  return db.collection('users').doc(currentUser.uid);
}

// Serialise a Firestore doc to plain JSON (Timestamps → millis)
function serialiseEntry(doc) {
  const d = doc.data();
  return {
    id:          doc.id,
    date:        d.date?.toMillis       ? d.date.toMillis()      : null,
    updatedAt:   d.updatedAt?.toMillis  ? d.updatedAt.toMillis() : null,
    hasTime:     d.hasTime  ?? false,
    type:        d.type        || '',
    duration:    d.duration    || 0,
    performance: d.performance || 0,
    feeling:     d.feeling     || 0,
    comment:     d.comment     || '',
    distance:       d.distance      ?? null,
    avgHr:          d.avgHr         ?? null,
    maxHr:          d.maxHr         ?? null,
    reactionCounts: d.reactionCounts || {},
  };
}

// Deserialise back — restore Timestamp-like objects for existing code
function deserialiseEntry(raw) {
  const toTs = ms => ms ? { toMillis: () => ms, toDate: () => new Date(ms) } : null;
  return {
    date:           toTs(raw.date),
    updatedAt:      toTs(raw.updatedAt),
    hasTime:        raw.hasTime,
    type:           raw.type,
    duration:       raw.duration,
    performance:    raw.performance,
    feeling:        raw.feeling,
    comment:        raw.comment,
    distance:       raw.distance ?? null,
    avgHr:          raw.avgHr   ?? null,
    maxHr:          raw.maxHr   ?? null,
    reactionCounts: raw.reactionCounts || {},
  };
}

function formatDisplayDate(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);

  // Local date key helpers
  const localKey = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dKey      = localKey(d);

  let dateStr;
  if (dKey === localKey(today))     dateStr = 'tänään';
  else if (dKey === localKey(yesterday)) dateStr = 'eilen';
  else dateStr = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;

  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (hasTime) {
    return dateStr + ' · ' + d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
  }
  return dateStr;
}

function starsHtml(n, total = 5) {
  const filled = Math.min(Math.max(Math.round(n), 0), total);
  return `<span class="stars-filled">${'★'.repeat(filled)}</span><span>${'★'.repeat(total - filled)}</span>`;
}

function confirm(message) {
  return new Promise(resolve => {
    const dialog  = el('confirm-dialog');
    const msgEl   = dialog.querySelector('p');
    const okBtn   = el('confirm-ok');
    const cancelBtn = el('confirm-cancel');
    msgEl.textContent = message;
    dialog.classList.remove('hidden');
    function cleanup(result) {
      dialog.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ============================================================
// AUTH VIEW
// ============================================================
let isLoginMode = true;
let isNewRegistration = false;  // set to true only after createUserWithEmailAndPassword

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

// Show forgot-password link only in login mode
function updateForgotVisibility() {
  const wrap = el('forgot-wrap');
  if (wrap) wrap.style.display = isLoginMode ? '' : 'none';
}

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
    alert('Tallennus epäonnistui, yritä uudelleen.');
  }
});

// ============================================================
// ENTRIES — PAGINATED REAL-TIME LIST
// ============================================================

// Returns a Date set to midnight at start of the Monday N weeks ago
function weeksAgoMonday(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;          // 1=Mon … 7=Sun
  d.setDate(d.getDate() - (day - 1));   // this Monday
  d.setDate(d.getDate() - n * 7);       // N weeks back
  return d;
}

function loadEntries() {
  pageWindowStart = weeksAgoMonday(PAGE_WEEKS);
  olderDocs       = [];
  hasMorePages    = true;

  hide('load-more-wrap');
  hide('no-more-entries');
  el('period-label').textContent = '';

  if (unsubEntries) { unsubEntries(); unsubEntries = null; }

  const cacheKey   = 'entries_' + pageWindowStart.getTime();
  const cachedDocs = Cache.get(currentUser.uid, cacheKey);

  // ── Serve from cache instantly (zero reads) ─────────────────
  if (cachedDocs && cachedDocs.length > 0) {
    const fakeDocs = cachedDocs.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
    allEntries = cachedDocs.map(raw => ({ id: raw.id, ...deserialiseEntry(raw) }));
    refreshActiveChart();
    renderPage(fakeDocs, olderDocs);
    const cachedHasMore = Cache.get(currentUser.uid, 'hasMore_' + pageWindowStart.getTime());
    if (cachedHasMore !== null) {
      hasMorePages = cachedHasMore;
      if (hasMorePages) show('load-more-wrap'); else hide('load-more-wrap');
    }
  } else {
    renderPage([], olderDocs);
  }

  // ── Background fetch — re-renders only if data changed ──────
  fetchEntries();
}

async function fetchEntries() {
  if (!currentUser) return;

  const btn = el('refresh-btn');
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }

  try {
    const windowStart = firebase.firestore.Timestamp.fromDate(pageWindowStart);
    const cacheKey    = 'entries_' + pageWindowStart.getTime();

    const snap       = await getUserEntries().orderBy('date', 'desc').where('date', '>=', windowStart).get();
    const serialised = snap.docs.map(serialiseEntry);
    const cached     = Cache.get(currentUser.uid, cacheKey) || [];

    if (Cache.fingerprint(serialised) !== Cache.fingerprint(cached)) {
      Cache.set(currentUser.uid, cacheKey, serialised);
      allEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      refreshActiveChart();
      renderPage(snap.docs, olderDocs);
    }

    // "Has more" check — only if not cached
    if (Cache.get(currentUser.uid, 'hasMore_' + pageWindowStart.getTime()) === null) {
      const check = await getUserEntries().where('date', '<', windowStart).limit(1).get();
      hasMorePages = !check.empty;
      Cache.set(currentUser.uid, 'hasMore_' + pageWindowStart.getTime(), hasMorePages);
      if (hasMorePages) show('load-more-wrap'); else hide('load-more-wrap');
    }
  } catch (err) {
    console.error('fetchEntries:', err);
  } finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

// ── Chart entries: full 12-week window, independent of Treenit pagination ──
async function fetchChartEntries() {
  if (!currentUser) return;

  const weeks    = getLastNWeeks(12);
  const weekStart = weeks[0];
  const lsKey    = 'uppis_ch_' + currentUser.uid;

  // Serve from cache if fresh
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts < CHART_CACHE_TTL && parsed.wk === weekStart.getTime()) {
        allChartEntries = parsed.data.map(e => ({ id: e.id, ...deserialiseEntry(e) }));
        return;
      }
    }
  } catch {}

  // Fetch from Firestore
  const cutoff = firebase.firestore.Timestamp.fromDate(weekStart);
  const snap   = await getUserEntries().where('date', '>=', cutoff).orderBy('date', 'desc').get();
  allChartEntries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Cache
  try {
    localStorage.setItem(lsKey, JSON.stringify({
      ts: Date.now(), wk: weekStart.getTime(),
      data: snap.docs.map(serialiseEntry),
    }));
  } catch {}
}

function invalidateChartCache() {
  try { localStorage.removeItem('uppis_ch_' + currentUser.uid); } catch {}
  allChartEntries = [];
}

// Re-fetch when user returns to app (both tabs)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) {
    const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
    if (activeTab === 'treenit') fetchEntries();
    if (activeTab === 'joukkue') renderJoukkueTab(); // respects TTL cache
  }
});

async function loadOlderPage() {
  const btn = el('load-more-btn');
  btn.disabled = true;
  btn.textContent = 'Ladataan…';

  const newWindowStart = new Date(pageWindowStart);
  newWindowStart.setDate(newWindowStart.getDate() - PAGE_WEEKS * 7);

  const from     = firebase.firestore.Timestamp.fromDate(newWindowStart);
  const to       = firebase.firestore.Timestamp.fromDate(pageWindowStart);
  const cacheKey = 'entries_older_' + newWindowStart.getTime();

  try {
    // Check cache for this older window first
    const cachedOlder = Cache.get(currentUser.uid, cacheKey);
    let olderRaw;

    if (cachedOlder) {
      olderRaw = cachedOlder;
    } else {
      const snap = await getUserEntries()
        .orderBy('date', 'desc')
        .where('date', '>=', from)
        .where('date', '<',  to)
        .get();
      olderRaw = snap.docs.map(serialiseEntry);
      Cache.set(currentUser.uid, cacheKey, olderRaw);
    }

    if (olderRaw.length === 0) {
      hasMorePages = false;
      hide('load-more-wrap');
      show('no-more-entries');
    } else {
      const fakeDocs = olderRaw.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));
      olderDocs = [...olderDocs, ...fakeDocs];
      pageWindowStart = newWindowStart;

      // Check for even older entries
      const oldest     = firebase.firestore.Timestamp.fromDate(newWindowStart);
      const checkSnap  = await getUserEntries().where('date', '<', oldest).limit(1).get();
      hasMorePages     = !checkSnap.empty;
      Cache.set(currentUser.uid, 'hasMore_' + newWindowStart.getTime(), hasMorePages);

      // Get live window docs from cache (already in memory via onSnapshot)
      const liveKey    = 'entries_' + weeksAgoMonday(PAGE_WEEKS).getTime();
      const liveRaw    = Cache.get(currentUser.uid, liveKey) || [];
      const liveFakeDocs = liveRaw.map(raw => ({ id: raw.id, data: () => deserialiseEntry(raw) }));

      allEntries = [...liveFakeDocs, ...olderDocs].map(d => ({ id: d.id, ...d.data() }));
      refreshActiveChart();
      renderPage(liveFakeDocs, olderDocs);
    }
  } catch (err) {
    console.error(err);
    alert('Vanhempien treenien lataus epäonnistui.');
  }

  btn.disabled = false;
  btn.textContent = 'Lataa aiemmat 4 viikkoa';
}

el('load-more-btn').addEventListener('click', loadOlderPage);

// Infinite scroll — Treenit + Joukkue tabs
let joukkueLoadingPage = false;
window.addEventListener('scroll', async () => {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  const distFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;

  if (activeTab === 'treenit') {
    if (!hasMorePages) return;
    if (distFromBottom < 120) {
      const btn = el('load-more-btn');
      if (!btn.classList.contains('hidden') && !btn.disabled) btn.click();
    }
  }

  if (activeTab === 'joukkue') {
    if (joukkueLoadingPage) return;
    if (joukkueFeedRendered >= joukkueFeedItems.length) return;
    if (distFromBottom < 180) {
      joukkueLoadingPage = true;
      await appendJoukkuePage();
      joukkueLoadingPage = false;
    }
  }
}, { passive: true });

function sortEntries(docs) {
  return [...docs].sort((a, b) => {
    const da = a.data(), db_ = b.data();
    const ta = da.date?.toMillis ? da.date.toMillis() : new Date(da.date).getTime();
    const tb = db_.date?.toMillis ? db_.date.toMillis() : new Date(db_.date).getTime();

    // Local YYYY-MM-DD key — avoids UTC offset issues in Finland (UTC+2/+3)
    const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    const dayA = localDay(ta);
    const dayB = localDay(tb);

    // Different days → later day first
    if (dayA !== dayB) return dayA > dayB ? -1 : 1;

    // Same day: timed entries before date-only
    const haA = da.hasTime ?? (ta % 86400000 !== 0);
    const haB = db_.hasTime ?? (tb % 86400000 !== 0);
    if (haA !== haB) return haB ? 1 : -1;

    // Both timed → later time first
    if (haA && haB) return tb - ta;

    // Both date-only → later updatedAt first (or doc order)
    const ua = da.updatedAt?.toMillis ? da.updatedAt.toMillis() : 0;
    const ub = db_.updatedAt?.toMillis ? db_.updatedAt.toMillis() : 0;
    return ub - ua;
  });
}

function entryCardHtml(doc) {
  const d         = doc.data();
  const date      = d.date ? formatDisplayDate(d.date) : '—';
  const comment   = d.comment ? `<div class="entry-comment">${escapeHtml(d.comment)}</div>` : '';
  const perfColor = d.performance ? PERF_COLORS[d.performance - 1] : 'var(--blue)';
  return `
    <div class="entry-card" onclick="openEntry('${doc.id}')">
      <div class="entry-card-stripe" style="background:${perfColor}"></div>
      <div class="entry-card-body">
        <div class="entry-card-header">
          <span class="entry-type">${escapeHtml(d.type || '—')}</span>
          <span class="entry-date">${escapeHtml(date)}</span>
        </div>
        <div class="entry-stats-grid">
          <span class="entry-duration">⏱ ${escapeHtml(String(d.duration || '?'))} min</span>
          <span class="stats-center">${d.performance ? `<span class="entry-perf-badge" style="background:${PERF_COLORS[d.performance-1]}22;color:${PERF_COLORS_DARK[d.performance-1]};border:1px solid ${PERF_COLORS[d.performance-1]}55">${PERF_ROMAN[d.performance - 1]} – ${PERF_LABELS[d.performance].split(' – ')[1]}</span>` : ''}</span>
          <span class="stats-right">${d.feeling ? `<span class="entry-feel-badge" style="background:${FEEL_COLORS[d.feeling].bg};color:${FEEL_COLORS[d.feeling].color}">${FEEL_EMOJIS[d.feeling]} ${FEEL_LABELS[d.feeling]}</span>` : ''}</span>
          ${(d.distance != null || d.avgHr != null || d.maxHr != null) ? `
          <span class="extra-col1">${d.distance != null ? `📍 ${String(d.distance).replace('.', ',')} km` : ''}</span>
          <span class="extra-col2">${d.avgHr != null ? `❤️ ${d.avgHr} bpm` : ''}</span>
          <span class="extra-col3">${d.maxHr != null ? `🔺 ${d.maxHr} bpm` : ''}</span>` : ''}
        </div>
        ${comment}
        <div class="entry-reactions" id="ereact-${doc.id}"></div>
      </div>
    </div>`;
}

function renderPage(liveDocs, extraDocs) {
  const list  = el('entries-list');
  const empty = el('empty-state');
  const allDocs = sortEntries([...liveDocs, ...extraDocs]);

  if (allDocs.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    hide('load-more-wrap');
    el('period-label').textContent = '';
    return;
  }

  empty.classList.add('hidden');
  list.innerHTML = allDocs.map(entryCardHtml).join('');
  showOwnEntryReactions(allDocs); // reads from cached reactionCounts — zero Firestore reads

  // Period label
  const newest = allDocs[0].data().date;
  const oldest = allDocs[allDocs.length - 1].data().date;
  const fmt    = ts => { const d = ts?.toDate ? ts.toDate() : new Date(ts); return d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' }); };
  el('period-label').textContent = `Näytetään: ${fmt(oldest)} – ${fmt(newest)}`;

  // Load-more button
  if (hasMorePages) {
    show('load-more-wrap');
    hide('no-more-entries');
  } else {
    hide('load-more-wrap');
    show('no-more-entries');
  }
}

// ============================================================
// OWN ENTRY REACTIONS (read-only display — reads from reactionCounts, zero Firestore reads)
// ============================================================
function showOwnEntryReactions(allDocs) {
  allDocs.forEach(doc => {
    const counts = doc.data().reactionCounts;
    if (!counts) return;
    const slot = document.getElementById('ereact-' + doc.id);
    if (!slot) return;
    const badges = REACTION_EMOJIS
      .filter(e => (counts[e] || 0) > 0)
      .map(e => `<span class="own-reaction-badge">${e} ${counts[e]}</span>`)
      .join('');
    if (badges) slot.innerHTML = `<div class="own-reactions-row">${badges}</div>`;
  });
}

// ============================================================
// MODAL — OPEN / CLOSE
// ============================================================
el('add-btn').addEventListener('click', () => openModal());
el('close-modal').addEventListener('click', closeModal);
el('entry-modal').querySelector('.modal-backdrop').addEventListener('click', closeModal);
el('entry-comment').addEventListener('input', updateCommentCounter);

function openModal(entryId = null, data = null) {
  currentEntryId = entryId;
  el('modal-title').textContent = entryId ? 'Muokkaa treeniä' : 'Uusi Treeni';
  el('delete-entry-btn').classList.toggle('hidden', !entryId);

  // Date — cap at today so future dates cannot be selected
  const today = new Date().toISOString().split('T')[0];
  el('entry-date').max = today;
  el('entry-date').value = data?.date ? timestampToDateStr(data.date) : today;

  // Time
  const hasTime = data?.date ? checkHasTime(data.date) : false;
  el('show-time').checked = hasTime;
  el('entry-time').classList.toggle('hidden', !hasTime);
  el('entry-time').value = hasTime ? timestampToTimeStr(data.date) : '';

  // Type
  buildTypeCombobox(data?.type || '');

  // Other fields
  el('entry-duration').value  = data?.duration || 60;
  el('entry-comment').value   = data?.comment  || '';
  updateCommentCounter();
  el('entry-distance').value  = data?.distance != null ? String(data.distance).replace('.', ',') : '';
  el('entry-heartrate').value = data?.avgHr    != null ? data.avgHr    : '';
  el('entry-maxhr').value     = data?.maxHr    != null ? data.maxHr    : '';

  // Open extra section only if editing and has extra data; otherwise close
  const extraEl = el('entry-extra');
  extraEl.open  = !!(data?.distance || data?.avgHr || data?.maxHr);

  // Stars
  setPerformance(data?.performance || 0);
  setFeeling(data?.feeling || 0);

  el('entry-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  hide('entry-modal');
  document.body.style.overflow = '';
}

// ============================================================
// ACTIVITY TYPE DROPDOWN
// ============================================================
const ALL_TYPES = [
  'Hiihto', 'Hyötyliikunta', 'Jalkapallo', 'Jooga', 'Juoksu', 'Kiipeily',
  'Koripallo', 'Kuntopiiri', 'Kuntosali', 'Kävely', 'Laskettelu', 'Lentopallo',
  'Luistelu', 'Melonta', 'Porrastreeni', 'Pyöräily', 'Ryhmäliikunta', 'Salibandy',
  'Tanssi', 'Tennis', 'Ultimate', 'Uinti', 'Uppopallo', 'Vaellus',
];

// Build item list for the combobox (called each time modal opens for fresh recents)
function buildTypeCombobox(currentType) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const seen   = new Set();
  const recent = [];
  [...allEntries]
    .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0))
    .forEach(e => {
      const ms = e.date?.toMillis ? e.date.toMillis() : 0;
      if (ms >= cutoff && e.type && !seen.has(e.type)) { seen.add(e.type); recent.push(e.type); }
    });

  // Store grouped items for filtering
  el('entry-type-list').dataset.recent = JSON.stringify(recent);

  // Render list and set input value
  el('entry-type').value = currentType || '';
  renderComboboxList('');
}

function renderComboboxList(query) {
  const listEl  = el('entry-type-list');
  const q       = query.trim().toLowerCase();
  const recent  = JSON.parse(listEl.dataset.recent || '[]');

  const match = t => !q || t.toLowerCase().includes(q);

  const recentFiltered = recent.filter(match);
  const allFiltered    = ALL_TYPES.filter(t => match(t) && !recent.includes(t));

  let html = '';

  if (recentFiltered.length > 0) {
    html += `<li class="combobox-group">Viimeisimmät</li>`;
    recentFiltered.forEach(t => {
      html += `<li class="combobox-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (allFiltered.length > 0) {
    html += `<li class="combobox-group">Kaikki lajit</li>`;
    allFiltered.forEach(t => {
      html += `<li class="combobox-item" data-value="${escapeHtml(t)}">${highlightMatch(t, q)}</li>`;
    });
  }
  if (!html) {
    html = `<li class="combobox-empty">Ei tuloksia — tallennetaan omana lajina</li>`;
  }

  listEl.innerHTML = html;
}

function highlightMatch(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx))
    + `<mark>${escapeHtml(text.slice(idx, idx + q.length))}</mark>`
    + escapeHtml(text.slice(idx + q.length));
}

function openCombobox() {
  const input  = el('entry-type');
  const listEl = el('entry-type-list');
  renderComboboxList(input.value);
  listEl.classList.add('open');
  input.setAttribute('aria-expanded', 'true');
}

function closeCombobox() {
  const listEl = el('entry-type-list');
  listEl.classList.remove('open');
  el('entry-type').setAttribute('aria-expanded', 'false');
}

function initTypeCombobox() {
  const input  = el('entry-type');
  const listEl = el('entry-type-list');

  input.addEventListener('focus', () => openCombobox());
  input.addEventListener('click', () => openCombobox());

  input.addEventListener('input', () => {
    renderComboboxList(input.value);
    listEl.classList.add('open');
  });

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = [...listEl.querySelectorAll('.combobox-item')];
    const active = listEl.querySelector('.combobox-item.highlighted');
    const idx = items.indexOf(active);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = items[idx + 1] || items[0];
      items.forEach(i => i.classList.remove('highlighted'));
      next?.classList.add('highlighted');
      next?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = items[idx - 1] || items[items.length - 1];
      items.forEach(i => i.classList.remove('highlighted'));
      prev?.classList.add('highlighted');
      prev?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (active) { e.preventDefault(); input.value = active.dataset.value; closeCombobox(); }
    } else if (e.key === 'Escape') {
      closeCombobox();
    }
  });

  // Click on list item
  listEl.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.combobox-item');
    if (item) { e.preventDefault(); input.value = item.dataset.value; closeCombobox(); }
  });

  // Touch support
  listEl.addEventListener('touchend', (e) => {
    const item = e.target.closest('.combobox-item');
    if (item) { e.preventDefault(); input.value = item.dataset.value; closeCombobox(); }
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!el('entry-type-wrap').contains(e.target)) closeCombobox();
  });
}

// ============================================================
// TIME TOGGLE / TYPE COMBOBOX INIT
// ============================================================
el('show-time').addEventListener('change', (e) => {
  el('entry-time').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked) el('entry-time').focus();
});

initTypeCombobox();

// ============================================================
// PERFORMANCE — Roman numeral buttons
// ============================================================
const PERF_COLORS      = ['#AAAAAA', '#4FC3D0', '#7DC83A', '#F5A623', '#E84040'];
const PERF_COLORS_DARK = ['#555555', '#1A6B75', '#3A6B10', '#8A5200', '#7A1010'];
const PERF_LABELS = ['', 'I – Peruskunto', 'II – Kestävyys', 'III – Maksimikestävyys', 'IV – Nopeuskestävyys', 'V – Nopeus'];
const PERF_ROMAN  = ['I', 'II', 'III', 'IV', 'V'];
const FEEL_LABELS = ['', 'Kehno', 'Välttävä', 'OK', 'Hyvä', 'Huippu'];
const FEEL_EMOJIS = ['', '😫', '😕', '🙂', '😄', '🤩'];
// Pastel bg / text pairs: red → orange → yellow-green → green → vivid green
const FEEL_COLORS = [
  null,
  { bg: 'rgba(220,38,38,0.10)',  color: '#b91c1c' },  // 1 Kehno
  { bg: 'rgba(234,88,12,0.10)',  color: '#c2410c' },  // 2 Välttävä
  { bg: 'rgba(161,163,29,0.12)', color: '#737509' },  // 3 OK
  { bg: 'rgba(22,163,74,0.11)',  color: '#15803d' },  // 4 Hyvä
  { bg: 'rgba(16,185,129,0.12)', color: '#0a7a52' },  // 5 Huippu
];

// Apply Polar zone color to a perf button when active
function applyPerfBtnColor(btn, zoneIndex, isActive) {
  const color = PERF_COLORS[zoneIndex];
  if (isActive) {
    btn.style.background   = color;
    btn.style.borderColor  = color;
    btn.style.color        = 'white';
    btn.style.boxShadow    = `0 3px 10px ${color}66`;
  } else {
    btn.style.background   = '';
    btn.style.borderColor  = '';
    btn.style.color        = '';
    btn.style.boxShadow    = '';
  }
}

function updateCommentCounter() {
  const textarea = el('entry-comment');
  const counter  = el('comment-char-count');
  const wrap     = counter?.closest('.char-counter');
  if (!textarea || !counter || !wrap) return;
  const len = textarea.value.length;
  counter.textContent = len;
  wrap.classList.toggle('near-limit', len >= 400 && len < 500);
  wrap.classList.toggle('at-limit',   len >= 500);
}

function setPerformance(value) {
  perfValue = value;
  const container = el('perf-stars');
  container.innerHTML = '';

  PERF_ROMAN.forEach((roman, i) => {
    const btn       = document.createElement('button');
    btn.type        = 'button';
    const isActive  = i + 1 === value;
    btn.className   = 'perf-btn' + (isActive ? ' active' : '');
    btn.textContent = roman;
    applyPerfBtnColor(btn, i, isActive);
    btn.addEventListener('click', () => setPerformance(i + 1));
    container.appendChild(btn);
  });

  el('perf-desc').textContent = value ? PERF_LABELS[value] : '';
}

// ============================================================
// EMOJI RATING (Feeling)
// ============================================================
function setFeeling(value) {
  feelValue = value;
  const container = el('feel-stars');
  container.innerHTML = '';

  FEEL_EMOJIS.slice(1).forEach((emoji, i) => {
    const btn     = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'feel-btn' + (i + 1 === value ? ' active' : '');
    btn.textContent = emoji;
    btn.title     = FEEL_LABELS[i + 1];
    btn.addEventListener('click', () => setFeeling(i + 1));
    container.appendChild(btn);
  });

  el('feel-desc').textContent = value ? FEEL_LABELS[value] : '';
}

// Init widgets
setPerformance(0);
setFeeling(0);

// ============================================================
// SAVE (create / update)
// ============================================================
el('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const dateVal = el('entry-date').value;
  const timeVal = el('show-time').checked ? el('entry-time').value : '';

  if (!dateVal) { alert('Valitse päivämäärä.'); return; }

  // Prevent future dates (same day is OK regardless of time)
  const todayStr = new Date().toISOString().split('T')[0];
  if (dateVal > todayStr) { alert('Et voi lisätä treeniä tulevaisuuteen.'); return; }

  const dateObj = timeVal
    ? new Date(`${dateVal}T${timeVal}`)
    : new Date(`${dateVal}T00:00:00`);

  const type = el('entry-type').value.trim();
  if (!type) { alert('Valitse tai kirjoita aktiviteetti.'); return; }

  const duration = parseInt(el('entry-duration').value, 10);
  if (!duration || duration < 1) { alert('Syötä keston kesto minuutteina.'); return; }

  const distRaw  = parseFloat(el('entry-distance').value.replace(',', '.'));
  const hrRaw    = parseInt(el('entry-heartrate').value, 10);
  const maxHrRaw = parseInt(el('entry-maxhr').value, 10);

  const data = {
    date:        firebase.firestore.Timestamp.fromDate(dateObj),
    hasTime:     !!timeVal,
    type,
    duration,
    performance: perfValue,
    feeling:     feelValue,
    comment:     el('entry-comment').value.trim(),
    distance:    isNaN(distRaw)  ? null : distRaw,
    avgHr:       isNaN(hrRaw)    ? null : hrRaw,
    maxHr:       isNaN(maxHrRaw) ? null : maxHrRaw,
    updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
  };

  try {
    if (currentEntryId) {
      await getUserEntries().doc(currentEntryId).update(data);
    } else {
      data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
      await getUserEntries().add(data);
    }
    // Invalidate caches and re-fetch
    Cache.set(currentUser.uid, 'entries_' + pageWindowStart.getTime(), null);
    invalidateChartCache();
    closeModal();
    fetchEntries();
  } catch (err) {
    console.error(err);
    alert('Tallennus epäonnistui. Yritä uudelleen.');
  }
});

// ============================================================
// DELETE
// ============================================================
el('delete-entry-btn').addEventListener('click', async () => {
  const yes = await confirm('Poistetaanko tämä harjoitus? Toimintoa ei voi peruuttaa.');
  if (!yes) return;
  try {
    await getUserEntries().doc(currentEntryId).delete();
    Cache.set(currentUser.uid, 'entries_' + pageWindowStart.getTime(), null);
    invalidateChartCache();
    closeModal();
    fetchEntries();
  } catch (err) {
    console.error(err);
    alert('Poisto epäonnistui.');
  }
});

// ============================================================
// OPEN EXISTING ENTRY FOR EDITING
// ============================================================
async function openEntry(entryId) {
  // Serve from in-memory cache (zero reads)
  const cached = allEntries.find(e => e.id === entryId);
  if (cached) { openModal(entryId, cached); return; }
  // Fallback: fetch from Firestore (entry not in current window)
  try {
    const doc = await getUserEntries().doc(entryId).get();
    if (doc.exists) openModal(entryId, doc.data());
  } catch (err) {
    console.error(err);
  }
}

// ============================================================
// NAV TABS
// ============================================================
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    el('tab-' + tab).classList.remove('hidden');
    // FAB only on treenit
    el('add-btn').classList.toggle('hidden', tab !== 'treenit');
    if (tab === 'vertailu') renderVertailuCharts();
    if (tab === 'trendit')  renderTrenditCharts();
    if (tab === 'joukkue')  renderJoukkueTab();
  });
});

el('refresh-btn').addEventListener('click', fetchEntries);
el('joukkue-refresh-btn').addEventListener('click', () => renderJoukkueTab(true));

function refreshActiveChart() {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  // Vertailu fetches external team data — only re-render on explicit tab open, not on every own-entry refresh
  if (activeTab === 'trendit') renderTrenditCharts();
}

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
const TEAM_CACHE_TTL = 60 * 60 * 1000; // 1 h in ms

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

// ── Init perf filter buttons (called once per renderVertailuCharts) ──
function initVertailuPerfFilter() {
  const container = el('vertailu-perf-btns');
  if (!container) return;
  // Already built — just refresh active states
  if (container.children.length === 5) {
    Array.from(container.children).forEach((btn, i) => {
      const isActive = vertailuPerfFilter.includes(i + 1);
      btn.classList.toggle('active', isActive);
      applyPerfBtnColor(btn, i, isActive);
    });
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
      else vertailuPerfFilter.splice(idx, 1);
      // Clear team cache so filter change forces recompute
      const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
      if (myTeams.length > 0) {
        const weeks = getLastNWeeks(12);
        const cKey  = teamCacheKey(myTeams, weeks[0].getTime());
        try { localStorage.removeItem('uppis_tc_' + currentUser.uid + '_' + cKey); } catch {}
      }
      renderVertailuCharts();
    });
    container.appendChild(btn);
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
          await Promise.all(teamMemberUids.map(async uid => {
            const snap = await db.collection('users').doc(uid).collection('entries')
              .where('date', '>=', cutoff).get();
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

  // Build legend
  const legendEl = el('trendit-legend');
  legendEl.innerHTML = PERF_ROMAN.map((r, i) =>
    `<span class="legend-item"><span class="legend-swatch" style="background:${PERF_COLORS[i]}"></span>${r}</span>`
  ).join('');

  const weeks   = getLastNWeeks(12);
  const weekMap = groupByWeek(allChartEntries);
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

  // Feeling average bars
  const feelingData = weeks.map(w => {
    const val = avgField(weekMap[w.getTime()] || [], 'feeling');
    return val !== null ? +val.toFixed(1) : null;
  });

  destroyChart('weeklyFeeling');
  chartInstances.weeklyFeeling = new Chart(
    el('chart-weekly-feeling').getContext('2d'),
    {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Fiilis',
          data: feelingData,
          backgroundColor: '#4f46e5',
          borderRadius: 2,
        }],
      },
      options: {
        ...chartBaseOptions,
        scales: {
          x: { ...chartBaseOptions.scales.x },
          y: { ...chartBaseOptions.scales.y, min: 0, max: 5, ticks: { stepSize: 1, font: { size: 10 } } },
        },
      },
    }
  );
}

// ============================================================
// PROFILE — load, display, modal
// ============================================================
async function loadProfile() {
  try {
    const snap = await getUserDoc().get();
    const remoteProfile = snap.exists ? (snap.data().profile || {}) : {};
    const remoteEmail   = snap.exists ? snap.data().email : null;

    // Only write email to Firestore if it's missing or changed (saves a write on most logins)
    if (remoteEmail !== currentUser.email) {
      getUserDoc().set({ email: currentUser.email }, { merge: true });
    }

    // Update cache only if data actually changed
    const cached = Cache.get(currentUser.uid, 'profile');
    if (Cache.fingerprint(remoteProfile) !== Cache.fingerprint(cached)) {
      Cache.set(currentUser.uid, 'profile', remoteProfile);
    }

    userProfile = remoteProfile;
  } catch (err) {
    console.error('loadProfile failed:', err);
    // Fall back to whatever the cache already loaded
    if (!userProfile || !Object.keys(userProfile).length) userProfile = {};
  }
  updateHeaderProfile();
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
  el('help-version-text').textContent  = `Versio 1.0 (build ${build})`;
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

  // Show/hide admin button
  const isAdmin = currentUser?.email === ADMIN_EMAIL;
  el('admin-panel-btn').classList.toggle('hidden', !isAdmin);

  el('profile-nickname').value  = userProfile.nickname  || '';
  el('profile-firstname').value = userProfile.firstName || '';
  el('profile-lastname').value  = userProfile.lastName  || '';
  el('profile-gender').value    = userProfile.gender    || '';
  el('profile-birthday').value  = userProfile.birthday  || '';
  const savedTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
  document.querySelectorAll('input[name="profile-team"]').forEach(cb => {
    cb.checked = savedTeams.includes(cb.value);
  });
  el('profile-share-activities').checked = userProfile.shareActivities === true;
  el('profile-share-comments').checked   = userProfile.shareComments   === true;
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
    alert(
      `Pakattu kuva on ${Math.round(compressedBytes / 1024)} KB — yli 100 KB rajan.\n\n` +
      `Valitse pienempi tai neliönmuotoinen (1:1) kuva ja yritä uudelleen.`
    );
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

el('remove-avatar-btn').addEventListener('click', () => {
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
      alert('Profiilin tallennus epäonnistui: ' + err.message);
      return;
    }
  }
  Cache.set(currentUser.uid, 'profile', updated);
  userProfile = updated;
  updateHeaderProfile();
  closeProfileModal();
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
  el('profile-age-display').textContent = age !== null ? `Ikä: ${age} vuotta` : '';
}

el('profile-birthday').addEventListener('change', (e) => updateAgeDisplay(e.target.value));

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
// DANGER CONFIRM DIALOG (requires typing "Poista")
// ============================================================
function dangerConfirm(message) {
  return new Promise((resolve) => {
    el('danger-dialog-msg').textContent = message;
    el('danger-confirm-input').value = '';
    el('danger-ok').disabled = true;
    show('danger-dialog');

    function onInput() {
      el('danger-ok').disabled = el('danger-confirm-input').value.trim() !== 'Poista';
    }
    function onOk() {
      if (el('danger-confirm-input').value.trim() !== 'Poista') return;
      cleanup(true);
    }
    function onCancel() { cleanup(false); }
    function cleanup(result) {
      hide('danger-dialog');
      el('danger-confirm-input').removeEventListener('input', onInput);
      el('danger-ok').removeEventListener('click', onOk);
      el('danger-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    el('danger-confirm-input').addEventListener('input', onInput);
    el('danger-ok').addEventListener('click', onOk);
    el('danger-cancel').addEventListener('click', onCancel);
  });
}

// ============================================================
// DELETE USER DATA UTILITY
// ============================================================
async function deleteAllUserData(uid) {
  // Delete all entries subcollection
  const entriesSnap = await db.collection('users').doc(uid).collection('entries').get();
  const batch = db.batch();
  entriesSnap.docs.forEach(d => batch.delete(d.ref));
  batch.delete(db.collection('users').doc(uid));
  await batch.commit();
}

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
      alert('Kirjaudu ulos ja uudelleen sisään, sitten yritä uudelleen.');
    } else {
      alert('Poisto epäonnistui: ' + err.message);
    }
  }
});

// ============================================================
// ADMIN PANEL
// ============================================================
el('admin-panel-btn').addEventListener('click', openAdminModal);
el('close-admin').addEventListener('click', closeAdminModal);
el('admin-backdrop').addEventListener('click', closeAdminModal);

function openAdminModal() {
  show('admin-modal');
  document.body.style.overflow = 'hidden';
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
  if (!team) { alert('Valitse ensin joukkue.'); return; }
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
    alert(team === '__ALL__' ? 'Ei käyttäjiä.' : 'Ei jäseniä joukkueessa: ' + team);
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
    alert('Poisto epäonnistui: ' + err.message);
  }
}

// ============================================================
// DATE / TIME UTILITIES
// ============================================================
function timestampToDateStr(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  // Format as YYYY-MM-DD in local time
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function timestampToTimeStr(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function checkHasTime(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.getHours() !== 0 || d.getMinutes() !== 0;
}

// ============================================================
// JOUKKUE FEED
// ============================================================
let joukkueFeedItems    = [];   // all sorted items
let joukkueFeedRendered = 0;    // how many cards are currently in DOM
let joukkueAvatarCache  = {};   // uid → base64 avatar
const JOUKKUE_PAGE_SIZE = 20;

// Same sort logic as sortEntries but for plain entry objects
function sortFeedItems(items) {
  const localDay = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  return [...items].sort((a, b) => {
    const ta = a.entry.date?.toMillis ? a.entry.date.toMillis() : 0;
    const tb = b.entry.date?.toMillis ? b.entry.date.toMillis() : 0;
    const dayA = localDay(ta), dayB = localDay(tb);
    if (dayA !== dayB) return dayA > dayB ? -1 : 1;
    const haA = a.entry.hasTime ?? (ta % 86400000 !== 0);
    const haB = b.entry.hasTime ?? (tb % 86400000 !== 0);
    if (haA !== haB) return haB ? 1 : -1;
    if (haA && haB) return tb - ta;
    const ua = a.entry.updatedAt?.toMillis ? a.entry.updatedAt.toMillis() : 0;
    const ub = b.entry.updatedAt?.toMillis ? b.entry.updatedAt.toMillis() : 0;
    return ub - ua;
  });
}

function joukkueFeedItemHtml(item, myReaction, avatarCache) {
  const { ownerUid, profile, entryId, entry } = item;
  const memberName = profile.nickname || profile.firstName || profile.email || 'Pelaaja';
  const initials   = (profile.firstName?.[0] || profile.email?.[0] || '?').toUpperCase();
  const avatarSrc  = profile.photoURL || avatarCache[ownerUid];
  const avatarHtml = avatarSrc ? `<img src="${avatarSrc}" alt="">` : initials;

  const dateStr = entry.date?.toMillis ? formatDisplayDate(entry.date) : '—';

  const perfIdx   = entry.performance ? entry.performance - 1 : null;
  const perfBadge = perfIdx !== null
    ? `<span class="entry-perf-badge" style="background:${PERF_COLORS[perfIdx]}22;color:${PERF_COLORS_DARK[perfIdx]};border:1px solid ${PERF_COLORS[perfIdx]}55">${PERF_ROMAN[perfIdx]} – ${PERF_LABELS[entry.performance].split(' – ')[1]}</span>`
    : '<span></span>';
  const feelBadge = entry.feeling
    ? `<span class="entry-feel-badge" style="background:${FEEL_COLORS[entry.feeling].bg};color:${FEEL_COLORS[entry.feeling].color}">${FEEL_EMOJIS[entry.feeling]} ${FEEL_LABELS[entry.feeling]}</span>`
    : '';

  const emojiCounts  = entry.reactionCounts || {};
  const reactionBtns = REACTION_EMOJIS.map(emoji => {
    const count     = emojiCounts[emoji] || 0;
    const isActive  = myReaction === emoji;
    const countHtml = count > 0 ? `<span class="reaction-count">${count}</span>` : '';
    return `<button class="reaction-btn${isActive ? ' active' : ''}" data-emoji="${emoji}" onclick="toggleReaction('${ownerUid}','${entryId}','${emoji}',this)">${emoji}${countHtml}</button>`;
  }).join('');

  return `
    <div class="joukkue-entry-card">
      <div class="joukkue-entry-header">
        <div class="joukkue-avatar-sm">${avatarHtml}</div>
        <span class="joukkue-member-name">${escapeHtml(memberName)}</span>
        <span class="joukkue-entry-date">${escapeHtml(dateStr)}</span>
      </div>
      <div class="joukkue-entry-body">
        <div class="joukkue-entry-type">${escapeHtml(entry.type || '—')}</div>
        <div class="entry-stats-grid">
          <span class="entry-duration">⏱ ${entry.duration || '?'} min</span>
          <span class="stats-center">${perfBadge !== '<span></span>' ? perfBadge : ''}</span>
          <span class="stats-right">${feelBadge}</span>
          ${(entry.distance != null || entry.avgHr != null || entry.maxHr != null) ? `
          <span class="extra-col1">${entry.distance != null ? `📍 ${String(entry.distance).replace('.', ',')} km` : ''}</span>
          <span class="extra-col2">${entry.avgHr != null ? `❤️ ${entry.avgHr} bpm` : ''}</span>
          <span class="extra-col3">${entry.maxHr != null ? `🔺 ${entry.maxHr} bpm` : ''}</span>` : ''}
        </div>
        ${entry.comment && profile.shareComments ? `<div class="entry-comment">${escapeHtml(entry.comment)}</div>` : ''}
      </div>
      <div class="joukkue-reactions">${reactionBtns}</div>
    </div>`;
}

async function appendJoukkuePage() {
  if (joukkueFeedRendered >= joukkueFeedItems.length) return;

  const feedEl = el('joukkue-feed');
  const slice  = joukkueFeedItems.slice(joukkueFeedRendered, joukkueFeedRendered + JOUKKUE_PAGE_SIZE);

  // Fetch current user's own reaction per entry — use in-memory cache to skip re-reads on tab switch
  // Reaction counts come free from entry.reactionCounts — zero extra reads for display
  const myReactionsMap = {};
  await Promise.all(slice.map(async ({ ownerUid, entryId }) => {
    const key = ownerUid + '_' + entryId;
    if (key in myReactionsCache) {
      myReactionsMap[key] = myReactionsCache[key];
      return;
    }
    try {
      const doc = await db.collection('users').doc(ownerUid)
        .collection('entries').doc(entryId)
        .collection('reactions').doc(currentUser.uid).get();
      myReactionsMap[key] = myReactionsCache[key] = doc.exists ? doc.data().emoji : null;
    } catch { myReactionsMap[key] = myReactionsCache[key] = null; }
  }));

  const html = slice.map(item =>
    joukkueFeedItemHtml(item, myReactionsMap[item.ownerUid + '_' + item.entryId] || null, joukkueAvatarCache)
  ).join('');

  if (joukkueFeedRendered === 0) feedEl.innerHTML = html;
  else feedEl.insertAdjacentHTML('beforeend', html);
  joukkueFeedRendered += slice.length;
}

async function renderJoukkueTab(force = false) {
  const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);

  if (myTeams.length === 0) {
    show('joukkue-no-team');
    el('joukkue-feed').innerHTML = '';
    el('joukkue-period-label').textContent = '';
    return;
  }
  hide('joukkue-no-team');

  // Period label: today back 14 days
  const periodEnd   = new Date();
  const periodStart = new Date(); periodStart.setDate(periodStart.getDate() - 14);
  const fmtP = d => d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  el('joukkue-period-label').textContent = `Näytetään: ${fmtP(periodStart)} – ${fmtP(periodEnd)}`;

  // Force refresh: clear feed + reaction caches
  if (force) {
    const cacheKey = 'joukkue_feed_' + [...myTeams].sort().join('|');
    try { localStorage.removeItem('uppis_jf_' + currentUser.uid + '_' + cacheKey); } catch {}
    Object.keys(myReactionsCache).forEach(k => delete myReactionsCache[k]);
  }

  // Reset pagination
  joukkueFeedItems    = [];
  joukkueFeedRendered = 0;
  el('joukkue-feed').innerHTML = '<div class="loading">Ladataan…</div>';

  try {
    const cacheKey = 'joukkue_feed_' + [...myTeams].sort().join('|');
    const now      = Date.now();
    let   rawItems = null;

    // ── Try cache ─────────────────────────────────────────────
    const cachedRaw = localStorage.getItem('uppis_jf_' + currentUser.uid + '_' + cacheKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (now - parsed.ts < JOUKKUE_CACHE_TTL) {
          rawItems = parsed.data.map(item => ({
            ...item,
            entry: {
              ...item.entry,
              date: typeof item.entry.date === 'number'
                ? { toMillis: () => item.entry.date, toDate: () => new Date(item.entry.date) }
                : item.entry.date,
            },
          }));
        }
      } catch {}
    }

    // ── Load avatar cache ─────────────────────────────────────
    try {
      const av = localStorage.getItem('uppis_av_' + currentUser.uid);
      if (av) { const p = JSON.parse(av); if (now - p.ts < 86400000) joukkueAvatarCache = p.data; }
    } catch {}

    // ── Fetch from Firestore if no cache ──────────────────────
    if (!rawItems) {
      const usersSnap = await db.collection('users')
        .where('profile.teams', 'array-contains-any', myTeams).get();

      const members = [];
      usersSnap.forEach(doc => {
        if (doc.id !== currentUser.uid && doc.data()?.profile?.shareActivities === true)
          members.push({ uid: doc.id, profile: doc.data()?.profile || {} });
      });

      const cutoff   = new Date(); cutoff.setDate(cutoff.getDate() - 14);
      const cutoffTs = firebase.firestore.Timestamp.fromDate(cutoff);

      rawItems = [];
      await Promise.all(members.map(async ({ uid, profile }) => {
        const snap = await db.collection('users').doc(uid).collection('entries')
          .where('date', '>=', cutoffTs).orderBy('date', 'desc').get();
        snap.forEach(doc => rawItems.push({ ownerUid: uid, profile, entryId: doc.id, entry: doc.data() }));
      }));

      // Cache avatars separately (24h)
      const avatarMap = {};
      members.forEach(({ uid, profile }) => { if (profile.photoURL) avatarMap[uid] = profile.photoURL; });
      joukkueAvatarCache = avatarMap;
      try { localStorage.setItem('uppis_av_' + currentUser.uid, JSON.stringify({ ts: now, data: avatarMap })); } catch {}

      // Cache feed (strip avatar to save space)
      try {
        localStorage.setItem('uppis_jf_' + currentUser.uid + '_' + cacheKey,
          JSON.stringify({ ts: now, data: rawItems.map(item => ({
            ...item,
            profile: { ...item.profile, avatar: undefined },
            entry:   { ...item.entry, date: item.entry.date?.toMillis?.() ?? item.entry.date },
          })) }));
      } catch {}
    }

    if (rawItems.length === 0) {
      el('joukkue-feed').innerHTML = '<p style="padding:1rem;color:var(--text-muted);font-size:0.9rem;">Ei joukkueen treenejä viimeiseltä 14 päivältä.</p>';
      return;
    }

    joukkueFeedItems = sortFeedItems(rawItems);
    await appendJoukkuePage();

  } catch (err) {
    console.error('Joukkue feed error:', err);
    el('joukkue-feed').innerHTML = '<p style="padding:1rem;color:var(--text-muted);">Lataus epäonnistui.</p>';
  }
}

window.toggleReaction = async function toggleReaction(ownerUid, entryId, emoji, btnEl) {
  const entryRef    = db.collection('users').doc(ownerUid).collection('entries').doc(entryId);
  const reactionRef = entryRef.collection('reactions').doc(currentUser.uid);
  const isActive    = btnEl.classList.contains('active');
  const inc         = firebase.firestore.FieldValue.increment;

  // Find old active reaction button (for switching emojis)
  const reactionRow = btnEl.closest('.joukkue-reactions');
  const oldActiveBtn = !isActive ? reactionRow?.querySelector('.reaction-btn.active') : null;
  const oldEmoji     = oldActiveBtn?.dataset.emoji || null;

  // ── Optimistic UI + in-memory reaction cache update ──────────
  const cacheKey = ownerUid + '_' + entryId;
  const prevCached = myReactionsCache[cacheKey];
  myReactionsCache[cacheKey] = isActive ? null : emoji;

  btnEl.classList.toggle('active', !isActive);
  adjustReactionCount(btnEl, isActive ? -1 : 1);
  if (oldActiveBtn) { oldActiveBtn.classList.remove('active'); adjustReactionCount(oldActiveBtn, -1); }

  try {
    const batch = db.batch();
    if (isActive) {
      batch.delete(reactionRef);
      batch.update(entryRef, { [`reactionCounts.${emoji}`]: inc(-1) });
    } else {
      batch.set(reactionRef, { emoji, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
      const updates = { [`reactionCounts.${emoji}`]: inc(1) };
      if (oldEmoji) updates[`reactionCounts.${oldEmoji}`] = inc(-1);
      batch.update(entryRef, updates);
    }
    await batch.commit();

    // Invalidate joukkue feed cache so next open has fresh counts
    const myTeams  = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
    const feedKey  = 'uppis_jf_' + currentUser.uid + '_joukkue_feed_' + [...myTeams].sort().join('|');
    try { localStorage.removeItem(feedKey); } catch {}
  } catch (err) {
    console.error('Reaction error:', err);
    // Revert optimistic update
    myReactionsCache[cacheKey] = prevCached;
    btnEl.classList.toggle('active', isActive);
    adjustReactionCount(btnEl, isActive ? 1 : -1);
    if (oldActiveBtn) { oldActiveBtn.classList.add('active'); adjustReactionCount(oldActiveBtn, 1); }
  }
};

function adjustReactionCount(btn, delta) {
  let countEl = btn.querySelector('.reaction-count');
  const current = countEl ? (parseInt(countEl.textContent) || 0) : 0;
  const next    = Math.max(0, current + delta);
  if (next > 0) {
    if (!countEl) { countEl = document.createElement('span'); countEl.className = 'reaction-count'; btn.appendChild(countEl); }
    countEl.textContent = next;
  } else if (countEl) {
    countEl.remove();
  }
}
