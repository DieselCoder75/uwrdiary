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
const REACTION_EMOJIS   = ['🔥', '💪', '👏', '🎉', '😅', '🥇'];

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

const ALL_TYPES = [
  'Hiihto', 'Hyötyliikunta', 'Jalkapallo', 'Jooga', 'Juoksu', 'Kiipeily',
  'Koripallo', 'Kuntopiiri', 'Kuntosali', 'Kävely', 'Laskettelu', 'Lentopallo',
  'Luistelu', 'Melonta', 'Porrastreeni', 'Pyöräily', 'Ryhmäliikunta', 'Salibandy',
  'Tanssi', 'Tennis', 'Ultimate', 'Uinti', 'Uppopallo', 'Vaellus',
];

const JOUKKUE_PAGE_SIZE = 20;

// Single source of truth for all team names
const TEAMS = ['Naisten Maajoukkue', 'Urheilusukeltajat', 'PSK-Kupla'];

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
