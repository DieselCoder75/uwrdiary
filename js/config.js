// ============================================================
// FIREBASE CONFIGURATION
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

// Offline persistence — kirjaukset jonottuvat automaattisesti
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
    console.warn('Persistence:', err);
  }
});

// ============================================================
// CONSTANTS
// ============================================================
const ADMIN_EMAIL  = 'janne.lind@gmail.com';
// AI Coach: oletuksena PÄÄLLÄ näillä käyttäjillä (jos täppää ei ole erikseen
// asetettu profiilissa). Muilla oletuksena pois — käyttäjä voi laittaa päälle itse.
const AICOACH_DEFAULT_ON_EMAILS = [
  'janne.lind@gmail.com',
  'nuppu.rytioja@gmail.com',
  'paula.aittooja@gmail.com',
];
const PAGE_WEEKS        = 4;   // initial window (current + 3 prev weeks)
const OLDER_PAGE_WEEKS  = 2;   // step size when loading older entries
const CHART_CACHE_TTL   = 60 * 60 * 1000;   // 1 h
const JOUKKUE_CACHE_TTL = 45 * 60 * 1000;   // 45 min
const TEAM_CACHE_TTL    = 60 * 60 * 1000;   // 1 h
const REACTION_EMOJIS   = ['🔥', '💪', '🎉', '😅', '🥇', '❤️'];

const PERF_COLORS        = ['#AAAAAA', '#4FC3D0', '#7DC83A', '#F5A623', '#E84040'];
const PERF_COLORS_DARK   = ['#555555', '#1A6B75', '#3A6B10', '#8A5200', '#7A1010'];
// Slightly darkened (~20 %) — used for inactive perf-btn borders & labels
const PERF_COLORS_BORDER = ['#888888', '#3A9099', '#5E962B', '#C4841C', '#BA3232'];
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

const ALL_TYPES = [
  'Avovesiuinti', 'BJJ', 'Crosstrainer', 'Frisbeegolf', 'Hengenpidätys',
  'Hiihto', 'HIIT', 'Hyötyliikunta', 'Jääkiekko', 'Jalkapallo', 'Jooga',
  'Juoksu', 'Kahvakuula', 'Kehonhuolto', 'Kiipeily', 'Koripallo', 'Kuntopiiri',
  'Kuntosali', 'Kävely', 'Laskettelu', 'Lentopallo', 'Liikkuvuus',
  'Lumilautailu', 'Luistelu', 'Maastopyöräily', 'Melonta', 'Padel', 'Pesäpallo',
  'Pilates', 'Porrastreeni', 'Pyöräily', 'Ryhmäliikunta', 'Salibandy', 'Snorklaus',
  'Rullaluistelu', 'Soutu', 'Spinning', 'Squash', 'SUP-lautailu', 'Suunnistus', 'Sähly',
  'Tanssi', 'Tennis', 'Ultimate', 'Uinti', 'Uppopallo', 'Vaellus',
  'Vapaasukellus', 'Vesijuoksu', 'Vesijumppa', 'Voimaharjoittelu',
  'Kajakointi', 'Sauvakävely', 'Surffaus',
];

const JOUKKUE_PAGE_SIZE = 20;

// ============================================================
// EWMA TRAINING LOAD — tehoaluepainot + lajikertoimet
// ============================================================
// Tehoalueen kuormituspaino (indeksi = performance-arvo 0–5)
// I  = palauttava, hyvin kevyt → 1.0
// II = aerobinen pohja, reipas mutta ei happoja → 2.0
// III= VO2max-työ, pitkät kovat vedot (>2 min) → 3.5
// IV = nopeuskestävyys, maksimaaliset 30–60 s intervallit → 5.0
// V  = nopeus, alle 10 s räjähteet + pitkät palautukset → 3.0
const ZONE_WEIGHTS = [0, 1.0, 2.0, 3.5, 5.0, 3.0];

// Lajin oletuskuormituspaino kun tehoaluetta ei ole kirjattu.
// Asteikko vastaa suunnilleen ZONE_WEIGHTS-skaalaa.
const SPORT_DEFAULT_WEIGHTS = {
  // Hyvin kevyt — venyttely, huolto, jooga
  'Kehonhuolto':     1.0, 'Liikkuvuus':      1.0, 'Jooga':           1.0, 'Pilates':      1.0,
  // Kevyt — rauhallinen liikkuminen
  'Kävely':          1.5, 'Hyötyliikunta':   1.5, 'Frisbeegolf':     1.5, 'Snorklaus':    1.5,
  // Kohtalainen
  'Sauvakävely':     2.0, 'SUP-lautailu':    2.0, 'Vesijumppa':      2.0, 'Tanssi':       2.0,
  'Luistelu':        2.0, 'Rullaluistelu':   2.0, 'Laskettelu':      2.0, 'Lumilautailu': 2.0,
  'Vaellus':         2.0, 'Hengenpidätys':   2.0, 'Vapaasukellus':   2.0, 'Melonta':      2.0,
  'Kajakointi':      2.0, 'Crosstrainer':    2.0,
  // Kohtalainen–korkea — tyypillinen harjoitteluvauhti
  'Pyöräily':        2.5, 'Kuntosali':       2.5, 'Voimaharjoittelu':2.5, 'Kahvakuula':   2.5,
  'Uinti':           2.5, 'Avovesiuinti':    2.5, 'Vesijuoksu':      2.5, 'Ryhmäliikunta':2.5,
  'Soutu':           2.5, 'Surffaus':        2.5, 'Spinning':        2.5,
  // Korkea — kilpailu/joukkueurheilu, intensiivinen aerobinen harjoittelu
  'Juoksu':          3.0, 'Maastopyöräily':  3.0, 'Hiihto':          3.0, 'Suunnistus':   3.0,
  'Salibandy':       3.0, 'Jääkiekko':       3.0, 'Jalkapallo':      3.0, 'Koripallo':    3.0,
  'Lentopallo':      3.0, 'Tennis':          3.0, 'Padel':           3.0, 'Pesäpallo':    2.5,
  'Kuntopiiri':      3.0, 'Kiipeily':        3.0, 'Sähly':           3.0,
  // Hyvin korkea — kontaktilajit, maksimaaliset intervallitreenit
  'Uppopallo':       3.5, 'BJJ':             3.5, 'HIIT':            3.5,
  'Porrastreeni':    3.5, 'Squash':          3.5, 'Ultimate':        3.5,
};
const SPORT_DEFAULT_WEIGHT_FALLBACK = 2.0; // tuntematon laji

// Single source of truth for all team names (may be overridden by Firestore settings/app)
let TEAMS = ['Naisten Maajoukkue', 'Urheilusukeltajat', 'PSK-Kupla'];

// Dynamic weekly zone plan loaded from Firestore settings/app.weekPlan
// Format: { "2026-W18": "IV", "2026-W19": "I–II" }
// Overrides the hardcoded WEEKLY_PLAN in calendar.js
let dynamicWeekPlan = {};

// Load app-wide settings from Firestore (teams list + week plan)
// Guarded so repeated calls (auth + portal open) only hit Firestore once per session.
let appSettingsLoaded = false;
async function loadAppSettings() {
  if (appSettingsLoaded) return;
  try {
    const doc = await db.collection('settings').doc('app').get();
    if (doc.exists) {
      const data = doc.data();
      if (Array.isArray(data.teams) && data.teams.length > 0) TEAMS = data.teams;
      if (data.weekPlan && typeof data.weekPlan === 'object') dynamicWeekPlan = data.weekPlan;
    }
    appSettingsLoaded = true;
  } catch (err) {
    console.warn('loadAppSettings:', err);
  }
}

// Render team checkboxes into a container element
function renderTeamCheckboxes(containerId, inputName, checkedTeams = []) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = TEAMS.map(team => `
    <label class="team-checkbox-item">
      <input type="checkbox" name="${inputName}" value="${team}"${checkedTeams.includes(team) ? ' checked' : ''}>
      <span>${team}</span>
    </label>`).join('');
}

// Populate the admin CSV team <select> with TEAMS options (keeps static options intact)
function populateAdminTeamSelect() {
  const sel = document.getElementById('admin-csv-team');
  if (!sel) return;
  // Remove any previously added dynamic options (keep the first two: placeholder + __ALL__)
  while (sel.options.length > 2) sel.remove(2);
  TEAMS.forEach(team => {
    const opt = document.createElement('option');
    opt.value = team;
    opt.textContent = team;
    sel.appendChild(opt);
  });
}
