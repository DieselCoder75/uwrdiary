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

// ============================================================
// CONSTANTS
// ============================================================
const ADMIN_EMAIL  = 'janne.lind@gmail.com';
const PAGE_WEEKS   = 4;
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
  'Soutu', 'Spinning', 'Squash', 'SUP-lautailu', 'Suunnistus', 'Sähly',
  'Tanssi', 'Tennis', 'Ultimate', 'Uinti', 'Uppopallo', 'Vaellus',
  'Vapaasukellus', 'Vesijuoksu', 'Vesijumppa', 'Voimaharjoittelu',
];

const JOUKKUE_PAGE_SIZE = 20;

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
