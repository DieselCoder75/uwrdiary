// ============================================================
// Feature B — viikoittainen Hyvinvointi-koonti sähköpostilla
// ============================================================
// Ajetaan GitHub Actions -cronilla (ma klo 07:00 Suomen aikaa). Lukee Firestoren
// (Admin SDK), generoi saman Hyvinvointi-koonnin kuin sovelluksen Hyvinvointi-
// välilehti (js/coachdigest.js), ja lähettää sen Naisten Maajoukkueen
// valmentajille (coachOf sisältää joukkueen) Gmail SMTP:llä. Kaikille sama viesti.
//
// PARITEETTI: analyysi- ja prompt-logiikan on pysyttävä yhtenevänä
// js/coachdigest.js:n kanssa. Jos muutat toista, muuta molemmat.

import admin from 'firebase-admin';
import nodemailer from 'nodemailer';

const TEAM = 'Naisten Maajoukkue';
const APP_URL = 'https://uwrdiary.web.app';

// ── Vakiot (mirror js/coachdigest.js) ─────────────────────────
const VOIMA_TYPES = ['Voimaharjoittelu', 'Kuntosali', 'Kahvakuula', 'Kuntopiiri'];
const UINTI_TYPES = ['Uinti', 'Avovesiuinti'];
const FETCH_LIMIT = 80;
const ACTIVE_DAYS = 14;
const HIGH_WEEK   = 10;
const STRONG_WORDS = [
  'uupu', 'näänty', 'loppuun', 'burn', 'en jaksa', 'ei jaksa enää', 'täysin poikki',
  'masent', 'ahdist', 'paniikki', 'itku', 'itketti', 'romah', 'ylikuormit',
  'vamma', 'loukkaan', 'loukkasi', 'murtu', 'reväh', 'repesi', 'leikkaus',
  'sairas', 'kuume', 'kova kipu', 'kovaa kipua', 'en pysty', 'lopettaa',
];
const PERF_ROMAN = ['I', 'II', 'III', 'IV', 'V'];

// Kovakoodattu viikkosuunnitelma (fallback; Firestore settings/app.weekPlan ohittaa)
const WEEKLY_PLAN = {
  2026: {
     1: 'I–II',  2: 'I–II',  3: 'III–IV', 4: 'IV',   5: 'I–II',
     6: 'IV',    7: 'I–II',  8: 'IV',     9: 'V',    10: 'I–II',
    11: 'II',   12: 'III',  13: 'I–II',  14: 'III',
    15: 'IV',   16: 'I–II', 17: 'III',   18: 'IV',
    19: 'I–II', 20: 'IV',   21: 'V',     22: 'I–II',
    23: 'III',  24: 'IV',   25: 'I–II',  26: 'I–II',
    27: 'III',  28: 'I–II', 29: 'I–II',  30: 'III',
    31: 'I–II', 32: 'I–II', 33: 'IV',
  },
};

let dynamicWeekPlan = {};

// ── Aika-/viikkoapurit (mirror charts.js + calendar.js) ───────
function getMondayOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() - day + (day === 0 ? -6 : 1));
  date.setHours(0, 0, 0, 0);
  return date;
}
function getLastNWeeks(n) {
  const monday = getMondayOfWeek(new Date());
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(monday); d.setDate(d.getDate() - (n - 1 - i) * 7); return d;
  });
}
function calIsoWeekData(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7), year: d.getUTCFullYear() };
}
function calWeekKey(monday) {
  const { week, year } = calIsoWeekData(monday);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
function calPlannedZone(monday) {
  const key = calWeekKey(monday);
  if (key in dynamicWeekPlan) return dynamicWeekPlan[key] || null;
  const { week, year } = calIsoWeekData(monday);
  return WEEKLY_PLAN[year]?.[week] || null;
}
function calDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ── Analyysi (mirror coachDigestAnalyzePlayer) ────────────────
function analyzePlayer(p) {
  const es = p.entries;
  if (!es.length) return { uid: p.uid, name: p.name, email: p.email, hasData: false, active: false };

  const now = new Date(); now.setHours(23, 59, 59, 999);
  const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - ACTIVE_DAYS);

  const maxDate  = es.reduce((m, e) => e._d > m ? e._d : m, new Date(0));
  const winStart = new Date(maxDate); winStart.setDate(winStart.getDate() - 42);
  const midStart = new Date(maxDate); midStart.setDate(midStart.getDate() - 21);

  const win    = es.filter(e => e._d > winStart && e._d <= maxDate);
  const recent = win.filter(e => e._d > midStart);
  const prior  = win.filter(e => e._d <= midStart);
  const last14 = es.filter(e => e._d >= twoWeeksAgo && e._d <= now);

  const active = last14.length > 0;

  const feelAvg = arr => {
    const f = arr.map(e => e.feeling).filter(x => x >= 1);
    return f.length ? +(f.reduce((s, x) => s + x, 0) / f.length).toFixed(1) : null;
  };
  const recentFeel = feelAvg(recent);
  const priorFeel  = feelAvg(prior);
  const feelDelta  = (recentFeel != null && priorFeel != null) ? +(recentFeel - priorFeel).toFixed(1) : null;
  const lowRecent  = recent.filter(e => e.feeling >= 1 && e.feeling <= 2).length;

  const uppo  = win.filter(e => e.type === 'Uppopallo').length;
  const uinti = win.filter(e => UINTI_TYPES.includes(e.type)).length;
  const voima = win.filter(e => VOIMA_TYPES.includes(e.type)).length;
  const oheis = win.length - uppo;

  const hasStrongComment = win.some(e =>
    (e.comment || '') && STRONG_WORDS.some(w => e.comment.toLowerCase().includes(w)));
  const comments = win
    .filter(e => (e.comment || '').trim())
    .filter(e => e.feeling === 1 || STRONG_WORDS.some(w => e.comment.toLowerCase().includes(w)))
    .sort((a, b) => b._d - a._d)
    .slice(0, 3)
    .map(e => ({
      date: `${e._d.getDate()}.${e._d.getMonth() + 1}.`,
      feeling: e.feeling >= 1 ? e.feeling : null,
      text: e.comment.trim().slice(0, 180),
    }));

  const trainingFlags = [];
  if (active) {
    const perWeek = {};
    win.forEach(e => { const k = calWeekKey(e._d); perWeek[k] = (perWeek[k] || 0) + 1; });
    const maxWeek = Math.max(0, ...Object.values(perWeek));
    if (maxWeek > HIGH_WEEK) trainingFlags.push(`erittäin suuri treenimäärä (${maxWeek} yhtenä viikkona)`);

    const dayKeys = new Set(last14.map(e => calDateKey(e._d)));
    if (dayKeys.size >= ACTIVE_DAYS) trainingFlags.push('ei yhtään vapaapäivää kahteen viikkoon');

    if (!last14.some(e => e.type === 'Uppopallo'))                   trainingFlags.push('ei uppopalloa yli 2 vk');
    if (!last14.some(e => UINTI_TYPES.includes(e.type)))            trainingFlags.push('ei uintia yli 2 vk');
    if (!last14.some(e => VOIMA_TYPES.includes(e.type)))           trainingFlags.push('ei voimaharjoittelua yli 2 vk');

    getLastNWeeks(6).forEach(wStart => {
      const planned = calPlannedZone(wStart) || '';
      if (!/III|IV/.test(planned)) return;
      const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
      const wkEntries = win.filter(e => e._d >= wStart && e._d < wEnd);
      if (!wkEntries.length) return;
      if (!wkEntries.some(e => e.performance === 3 || e.performance === 4)) {
        const { week } = calIsoWeekData(wStart);
        trainingFlags.push(`vk ${week} oli kova (${planned}), mutta ei kovia (III/IV) treenejä`);
      }
    });
  }

  const wellbeingFlag = active &&
    ((feelDelta != null && feelDelta <= -1.0) || lowRecent >= 3 || hasStrongComment);

  return {
    uid: p.uid, name: p.name, email: p.email, hasData: true, active,
    sessions: win.length, uppo, oheis, uinti, voima,
    recentFeel, priorFeel, feelDelta, lowRecent, comments, hasStrongComment,
    trainingFlags, wellbeingFlag, maxDate,
  };
}

// ── Joukkueen viikkotaso (mirror coachDigestTeamWeeks) ────────
function teamWeeks(players) {
  const weeks = getLastNWeeks(6);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return weeks.map(wStart => {
    const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
    const zones = [0, 0, 0, 0, 0];
    let sessions = 0;
    players.forEach(p => p.entries.forEach(e => {
      if (e._d >= wStart && e._d < wEnd) {
        sessions++;
        if (e.performance >= 1 && e.performance <= 5) zones[e.performance - 1]++;
      }
    }));
    const { week } = calIsoWeekData(wStart);
    const planned = calPlannedZone(wStart) || '–';
    const isCurrent = today >= wStart && today < wEnd;
    const zoneStr = PERF_ROMAN.map((r, i) => `${r}:${zones[i]}`).join(' ');
    return `Vk ${week}${isCurrent ? ' [kesken]' : ''}: ${sessions} treeniä (tehoalueet ${zoneStr}); suunniteltu tehoalue ${planned}`;
  });
}

// ── Prompt (verbatim js/coachdigest.js:coachDigestBuildPrompt) ─
function buildPrompt(team, analyzed, weekLines) {
  const activePlayers = analyzed.filter(p => p.hasData && p.active);
  const inactive      = analyzed.filter(p => p.hasData && !p.active).map(p => p.name);
  const noData        = analyzed.filter(p => !p.hasData).map(p => p.name);

  const playerLines = activePlayers.map(p => {
    const feel = p.recentFeel != null
      ? `fiilis viim.3vk ${p.recentFeel}/5 vs edell.3vk ${p.priorFeel != null ? p.priorFeel + '/5' : '–'}${p.feelDelta != null ? ` (muutos ${p.feelDelta > 0 ? '+' : ''}${p.feelDelta})` : ''}`
      : 'fiilis –';
    const low  = p.lowRecent > 0 ? `; ${p.lowRecent} matalan fiiliksen (1–2) treeniä viim.3vk` : '';
    const wflag = p.wellbeingFlag ? ' [HYVINVOINTISIGNAALI]' : '';
    let line = `- ${p.name}${wflag}: 6vk yhteensä ${p.sessions} treeniä (uppopallo ${p.uppo}, oheis ${p.oheis}, uinti ${p.uinti}, voima ${p.voima}); ${feel}${low}.`;
    if (p.trainingFlags.length) line += ` TREENIHÄLYTYS: ${p.trainingFlags.join('; ')}.`;
    if (p.comments.length) {
      line += ' Vahvat kommentit: ' + p.comments.map(c =>
        `"${c.text}"${c.feeling ? ` (fiilis ${c.feeling})` : ''}`).join(' ');
    }
    return line;
  });

  return `Olet uppopallon (underwater rugby) huippuvalmentaja. Laadit joukkueen valmentajalle TIIVIIN hyvinvointi- ja harjoittelukoonnin suomeksi. Pidä koko vastaus korkeintaan noin kahden ruudun/sivun mittaisena. Ole lempeä, konkreettinen ja ammattimainen. Käytä selkeää, arkista suomea äläkä ammattislangia. Jos joudut viittaamaan mittariin (esim. kokonaisrasitus/ACWR), käytä arkitermiä ja laita lyhenne tarvittaessa sulkeisiin. ÄLÄ tee terveys- tai lääketieteellisiä diagnooseja — kuvaile vain havaintoja fiiliksestä ja kommenteista ja ehdota, että valmentaja voi jutella pelaajan kanssa.

ÄLÄ aloita tervehdyksellä, alustuksella tai johdannolla. Aloita vastaus SUORAAN otsikolla "## Joukkueen kokonaiskuva".

JOUKKUE: ${team} (analysoidaan ${activePlayers.length} aktiivista pelaajaa, jotka ovat kirjanneet treenin viim. 2 vk aikana)

JOUKKUEEN VIIKKOTASO (viimeiset 6 viikkoa, suunniteltu tehoalue mukana):
${weekLines.join('\n')}

PELAAJAKOHTAINEN DATA (vain aktiiviset; kunkin 6 viikkoa hänen viimeisimmästä kirjauksestaan taaksepäin; fiilisvertailu = viim. 3 vk vs edell. 3 vk. "[HYVINVOINTISIGNAALI]" = esisuodatin havaitsi fiiliksen laskun ≥1.0, ≥3 matalan fiiliksen treeniä TAI vahvan kommentin):
${playerLines.join('\n')}${inactive.length ? `\n\nEI KIRJAUKSIA VIIM. 2 VK (ÄLÄ analysoi äläkä nimeä näitä): ${inactive.join(', ')}` : ''}${noData.length ? `\nEI KIRJAUKSIA LAINKAAN (ohita): ${noData.join(', ')}` : ''}

TREENIANALYYSIN TEESIT (tiiviisti, joukkuetasolla):
- Hyvään viikkoon kuuluu sekä uppopalloa että monipuolista oheista (uinti + voima). Suuntaa-antava: 4 harj/vko → 2+2, 5 → 2+3, 6 → 3+3, 7 → 3+4.
- Joka viikko ~60 % kuormasta olisi hyvä olla kevyttä/tasapainottavaa (tehoalueet I, II tai V). Kovan teeman viikoilla kovan työn (III–IV) osuus vähintään ~20 %.
- Katso osuvatko kovat tehoaluetreenit suunniteltuun tehoalueeseen.
- Sovellus on ollut käytössä vähän aikaa: tyhjät/vähäiset viikot johtuvat todennäköisesti kirjaamatta jättämisestä, EI treenaamattomuudesta. Kesken oleva viikko ei ole "kevyt". Älä moiti näistä.

HENKISEN HYVINVOINNIN OHJE:
- Fiilis (1–5) on pelaajan henkisen jaksamisen pääsignaali. Yhdistä se kommentteihin.
- Nimeä VAIN pelaajat joilla on selkeä nosto; yksittäinen heikko fiilis tai lievä maininta EI riitä.
- Perustele jokainen nosto AINA konkreettisesti datasta: mikä laukaisi sen (esim. "fiilis laskenut 3.7→2.3", "kolme matalan fiiliksen treeniä", tai kommentin sisältö lyhyesti). ÄLÄ koskaan kirjoita "järjestelmä havaitsi signaalin" tai viittaa [HYVINVOINTISIGNAALI]-merkintään — se on vain sisäinen esisuodatin, ei syy jonka valmentaja näkee.
- Erota kuormaväsymys tunnesignaalista: jos matala fiilis osuu suureen treenimäärään, se viittaa ennemmin palautumistarpeeseen; jos kommentit viittaavat stressiin tai elämäntilanteeseen, ehdota lyhyttä juttutuokiota.
- Yksi tiivis lause per pelaaja (+ lyhyt sitaatti jos se valaisee). Tärkein ensin. Ei diagnooseja eikä dramatisointia.

VASTAUKSEN MUOTO (markdown):
## Joukkueen kokonaiskuva
2–4 lausetta joukkueen tilanteesta (treeni + henkinen puoli). ÄLÄ kirjoita mitään tämän otsikon eteen.

## Harjoittelu
3–5 luettelokohtaa ("- "). Nosta erityisesti esiin NIMELTÄ pelaajat, joiden treenaamisessa on hälyttävää (ks. TREENIHÄLYTYS-merkinnät): erittäin suuri treenimäärä (yli 10/vk), ei vapaapäiviä kahteen viikkoon, ei uintia/voimaa/uppopalloa yli kahteen viikkoon, tai kovalla viikolla ei tehty kovia treenejä. Mainitse myös lyhyesti joukkueen yleiskuva (määrät, uppopallo/oheis-suhde).

## Henkinen hyvinvointi
Luettelo ("- ") vain niistä pelaajista joilla on nosto: nimi + konkreettinen syy yhdellä lauseella (+ lyhyt sitaatti tarvittaessa). ÄLÄ lisää loppuun koontilausetta muista pelaajista. Jos kenelläkään ei ole nostoa, kirjoita pelkkä rivi: "Ei erityisiä nostoja."
Pidä vastaus tiiviinä. Älä toista raakadataa sellaisenaan.`;
}

// ── Gemini (REST, gemini-2.5-flash) ───────────────────────────
async function geminiGenerate(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text.trim()) throw new Error('Gemini palautti tyhjän vastauksen');
  return text.trim();
}

// ── Markdown → HTML (kevyt; otsikot, listat, lihavointi) ──────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineMd(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function markdownToHtml(md) {
  const lines = md.split('\n');
  let html = '', inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    if (line.startsWith('## ')) {
      closeList();
      html += `<h2 style="color:#1A56B0;font-size:17px;margin:20px 0 8px;">${inlineMd(line.slice(3))}</h2>`;
    } else if (line.startsWith('- ')) {
      if (!inList) { html += '<ul style="margin:6px 0 6px 0;padding-left:20px;">'; inList = true; }
      html += `<li style="margin:4px 0;">${inlineMd(line.slice(2))}</li>`;
    } else {
      closeList();
      html += `<p style="margin:8px 0;">${inlineMd(line)}</p>`;
    }
  }
  closeList();
  return html;
}

function emailHtml(digestHtml, week) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;max-width:640px;margin:0 auto;">
  <div style="background:#003F9C;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
    <div style="font-size:13px;opacity:.85;letter-spacing:.5px;">UWR DIARY · HYVINVOINTI-KOONTI</div>
    <div style="font-size:20px;font-weight:600;margin-top:2px;">Naisten Maajoukkue · viikko ${week}</div>
  </div>
  <div style="border:1px solid #e3e6ee;border-top:none;border-radius:0 0 8px 8px;padding:16px 20px;">
    ${digestHtml}
    <hr style="border:none;border-top:1px solid #e3e6ee;margin:18px 0;">
    <p style="font-size:12px;color:#6b7280;margin:0 0 6px;">Koonti perustuu pelaajien treenikirjauksiin ja fiiliksiin (myös yksityisiksi merkittyihin kommentteihin). Käytä sitä hienovaraisesti keskustelun tukena — se ei ole diagnoosi, ja tekoäly voi tehdä virheitä.</p>
    <p style="font-size:12px;color:#6b7280;margin:0;"><a href="${APP_URL}" style="color:#1A56B0;">Avaa UWR Diary</a> · koonti on nähtävissä myös sovelluksen Hyvinvointi-välilehdellä.</p>
  </div>
</div>`;
}

// ── Firestore-datan haku ──────────────────────────────────────
async function loadWeekPlan(db) {
  const doc = await db.collection('settings').doc('app').get();
  if (doc.exists) {
    const data = doc.data();
    if (data.weekPlan && typeof data.weekPlan === 'object') dynamicWeekPlan = data.weekPlan;
  }
}
async function loadUsers(db) {
  const snap = await db.collection('users').get();
  return snap.docs.map(d => {
    const u = d.data() || {};
    const prof = u.profile || {};
    const name = [prof.firstName, prof.lastName].filter(Boolean).join(' ') || u.email || d.id;
    const teams = prof.teams || (prof.team ? [prof.team] : []);
    return { uid: d.id, email: u.email || '', name, teams, coachOf: u.coachOf || [] };
  });
}
async function fetchEntries(db, uid) {
  const snap = await db.collection('users').doc(uid).collection('entries')
    .orderBy('date', 'desc').limit(FETCH_LIMIT).get();
  return snap.docs.map(d => {
    const data = d.data();
    const dt = data.date?.toDate ? data.date.toDate() : new Date(data.date);
    return { ...data, _d: dt };
  }).filter(e => !isNaN(e._d));
}

// ── Pääajo ────────────────────────────────────────────────────
function isHelsinki18() {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Helsinki', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date());
  return Number(h) === 18;
}

async function main() {
  const force = process.env.FORCE_RUN === '1';
  if (!force && !isHelsinki18()) {
    console.log('Ei klo 18 Suomen aikaa — ohitetaan tämä ajo (DST-portti).');
    return;
  }

  const dryRun = process.env.DRY_RUN === '1';
  const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const geminiKey = process.env.GEMINI_API_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!saRaw) throw new Error('Puuttuva FIREBASE_SERVICE_ACCOUNT.');
  if (!dryRun && (!geminiKey || !gmailUser || !gmailPass)) {
    throw new Error('Puuttuva ympäristömuuttuja (GEMINI_API_KEY / GMAIL_USER / GMAIL_APP_PASSWORD).');
  }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saRaw)) });
  const db = admin.firestore();

  await loadWeekPlan(db);
  const users = await loadUsers(db);

  const recipients = (process.env.TEST_RECIPIENT
    ? [process.env.TEST_RECIPIENT]
    : users.filter(u => u.coachOf.includes(TEAM) && u.email).map(u => u.email));
  if (!recipients.length) { console.log('Ei valmentajia (coachOf) joukkueelle — ei lähetetä.'); return; }

  const members = users.filter(u => u.teams.includes(TEAM));
  if (!members.length) { console.log('Ei pelaajia joukkueessa — ei lähetetä.'); return; }

  const withEntries = await Promise.all(members.map(async m => ({
    uid: m.uid, name: m.name, email: m.email, entries: await fetchEntries(db, m.uid),
  })));

  const analyzed = withEntries.map(analyzePlayer);
  if (!analyzed.some(p => p.hasData)) { console.log('Ei treenikirjauksia — ei lähetetä.'); return; }

  const weekLines = teamWeeks(withEntries);
  const prompt = buildPrompt(TEAM, analyzed, weekLines);

  if (dryRun) {
    console.log(`\n=== DRY RUN ===`);
    console.log(`Vastaanottajat (${recipients.length}):`, recipients.join(', '));
    console.log(`Pelaajia joukkueessa: ${members.length}, aktiivisia: ${analyzed.filter(p => p.active).length}, hyvinvointisignaaleja: ${analyzed.filter(p => p.wellbeingFlag).length}`);
    console.log(`\n--- PROMPT ---\n${prompt}\n`);
    return;
  }

  const digestText = await geminiGenerate(prompt, geminiKey);

  const { week } = calIsoWeekData(new Date());
  const html = emailHtml(markdownToHtml(digestText), week);

  const transporter = nodemailer.createTransport({
    service: 'gmail', auth: { user: gmailUser, pass: gmailPass },
  });
  await transporter.sendMail({
    from: `"UWR Diary – Naisten Maajoukkue" <${gmailUser}>`,
    bcc: recipients,
    subject: `Hyvinvointi-koonti – Naisten Maajoukkue (viikko ${week})`,
    text: digestText,
    html,
  });

  console.log(`Lähetetty ${recipients.length} vastaanottajalle (viikko ${week}).`);
}

main().catch(err => { console.error('Viikkokoonti epäonnistui:', err); process.exit(1); });
