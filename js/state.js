// ============================================================
// MUTABLE GLOBAL STATE
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

// Joukkue feed cache state
let joukkueFeedCacheTs   = 0;
let joukkueFeedCacheData = null;

// Pagination state
let pageWindowStart = null;  // Date: beginning of current window (oldest shown)
let olderDocs       = [];    // docs fetched for older pages
let hasMorePages    = true;

let isLoginMode = true;
let isNewRegistration = false;  // set to true only after createUserWithEmailAndPassword

// Impersonation state — null = real user, object = viewing as another user
let impersonating = null; // { uid, name, email }

// joukkue feed pagination
let joukkueFeedItems    = [];   // all sorted items
let joukkueFeedRendered = 0;    // how many cards are currently in DOM
let joukkueAvatarCache  = {};   // uid → base64 avatar
let joukkueLoadingPage  = false;

// in-memory reaction cache
// key: "ownerUid_entryId" → emoji string or null
const myReactionsCache = {};
