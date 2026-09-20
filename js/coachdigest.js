// ============================================================
// HYVINVOINTI — valmentajan/adminin joukkuekoonti (Feature A)
// ============================================================
// Yksi Gemini-kutsu per joukkue. Kaksi osaa: (1) tiivis treenianalyysi
// (AI Coachin teesit joukkuetasolla) ja (2) henkisen hyvinvoinnin koonti
// (fiilis + kommentit, myös yksityiset). Nimeää vain pelaajat joilla on
// selkeä nosto. Data kerätään per pelaaja: 6 viikkoa pelaajan VIIMEISESTÄ
// kirjatusta treenistä taaksepäin (ratkaisee keskeneräisen viikon ongelman).
// Fiilisvertailu = viimeiset 3 vk vs edelliset 3 vk. EI muuta AI Coachia.

const COACHDIGEST_LS_PREFIX     = 'uppis_cdigest_';        // + coachUid + '_' + team
const COACHDIGEST_TTL           = 12 * 60 * 60 * 1000;     // 12 h
const COACHDIGEST_PROMPT_VERSION = 3;
const COACHDIGEST_VOIMA_TYPES   = ['Voimaharjoittelu', 'Kuntosali', 'Kahvakuula', 'Kuntopiiri'];
const COACHDIGEST_UINTI_TYPES   = ['Uinti', 'Avovesiuinti'];
const COACHDIGEST_FETCH_LIMIT   = 80;   // per pelaaja (kattaa ~6 vk + marginaali)
const COACHDIGEST_DEFAULT_TEAM  = 'Naisten Maajoukkue';

// VAHVAT signaalisanat: näiden perusteella kommentti nostetaan aina esiin.
// Lievät negatiiviset maininnat ("vähän väsytti") ohitetaan tarkoituksella.
const COACHDIGEST_STRONG_WORDS = [
  'uupu', 'näänty', 'loppuun', 'burn', 'en jaksa', 'ei jaksa enää', 'täysin poikki',
  'masent', 'ahdist', 'paniikki', 'itku', 'itketti', 'romah', 'ylikuormit',
  'vamma', 'loukkaan', 'loukkasi', 'murtu', 'reväh', 'repesi', 'leikkaus',
  'sairas', 'kuume', 'kova kipu', 'kovaa kipua', 'en pysty', 'lopettaa',
];
const COACHDIGEST_ACTIVE_DAYS = 14;   // aktiiviseksi vaaditaan kirjaus viim. 2 vk
const COACHDIGEST_HIGH_WEEK   = 10;   // yli tämän treeniä/vk = hälytys

// ── Joukkuevalitsin ───────────────────────────────────────────
function populateCoachDigestTeams(teamsForSelects) {
  const sel = el('coachdigest-team');
  if (!sel) return;
  const isAdmin = currentUser?.email === ADMIN_EMAIL;
  const teams = teamsForSelects || (isAdmin ? TEAMS : (userProfile.coachOf || []));
  sel.innerHTML = teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  const def = teams.includes(COACHDIGEST_DEFAULT_TEAM) ? COACHDIGEST_DEFAULT_TEAM : (teams[0] || '');
  sel.value = def;
}

// ── Cache (per valmentaja + joukkue) ──────────────────────────
function coachDigestCacheKey(team) {
  const uid = currentUser?.uid || 'anon';
  return `${COACHDIGEST_LS_PREFIX}${uid}_${team}`;
}
function coachDigestGetCached(team) {
  try {
    const raw = localStorage.getItem(coachDigestCacheKey(team));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.text === 'string' && typeof p.ts === 'number') return p;
  } catch {}
  return null;
}
function coachDigestSetCached(team, text, players, ts) {
  try {
    localStorage.setItem(coachDigestCacheKey(team),
      JSON.stringify({ text, players, ts, pv: COACHDIGEST_PROMPT_VERSION }));
  } catch {}
}

// ── Datan haku (per pelaaja, 6 vk viimeisestä kirjauksesta) ───
async function coachDigestFetchTeam(team) {
  await ensureAdminUsers();
  const members = cachedAdminUsers.filter(u => {
    const teams = u.profile.teams || (u.profile.team ? [u.profile.team] : []);
    return teams.includes(team);
  });
  return Promise.all(members.map(async u => {
    const name = [u.profile.firstName, u.profile.lastName].filter(Boolean).join(' ') || u.email || u.uid;
    const snap = await db.collection('users').doc(u.uid).collection('entries')
      .orderBy('date', 'desc').limit(COACHDIGEST_FETCH_LIMIT).get();
    const entries = snap.docs.map(d => {
      const data = d.data();
      const dt = data.date?.toDate ? data.date.toDate() : new Date(data.date);
      return { ...data, _d: dt };
    }).filter(e => !isNaN(e._d));
    return { uid: u.uid, name, email: u.email || '', entries };
  }));
}

// ── Per pelaaja: 6 vk ikkuna + 3v3 fiilisvertailu + kommentit ─
function coachDigestAnalyzePlayer(p) {
  const es = p.entries;
  if (!es.length) return { uid: p.uid, name: p.name, email: p.email, hasData: false, active: false };

  const now = new Date(); now.setHours(23, 59, 59, 999);
  const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - COACHDIGEST_ACTIVE_DAYS);

  const maxDate  = es.reduce((m, e) => e._d > m ? e._d : m, new Date(0));
  const winStart = new Date(maxDate); winStart.setDate(winStart.getDate() - 42);
  const midStart = new Date(maxDate); midStart.setDate(midStart.getDate() - 21);

  const win    = es.filter(e => e._d > winStart && e._d <= maxDate);
  const recent = win.filter(e => e._d > midStart);       // viim. 3 vk
  const prior  = win.filter(e => e._d <= midStart);      // edell. 3 vk
  const last14 = es.filter(e => e._d >= twoWeeksAgo && e._d <= now);

  // Aktiivinen = vähintään yksi kirjaus viimeisen 2 viikon aikana. Ei-aktiivisia
  // ei analysoida lainkaan (ei hyvinvointi- eikä treenihälytyksiä).
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
  const uinti = win.filter(e => COACHDIGEST_UINTI_TYPES.includes(e.type)).length;
  const voima = win.filter(e => COACHDIGEST_VOIMA_TYPES.includes(e.type)).length;
  const oheis = win.length - uppo;

  // Kommentit: nosta esiin VAIN vahvat signaalit (vahva sana tai fiilis = 1).
  // Yksittäinen heikko fiilis (2) tai lievä negatiivinen maininta ohitetaan.
  const hasStrongComment = win.some(e =>
    (e.comment || '') && COACHDIGEST_STRONG_WORDS.some(w => e.comment.toLowerCase().includes(w)));
  const comments = win
    .filter(e => (e.comment || '').trim())
    .filter(e => e.feeling === 1 ||
      COACHDIGEST_STRONG_WORDS.some(w => e.comment.toLowerCase().includes(w)))
    .sort((a, b) => b._d - a._d)
    .slice(0, 3)
    .map(e => ({
      date: `${e._d.getDate()}.${e._d.getMonth() + 1}.`,
      feeling: e.feeling >= 1 ? e.feeling : null,
      text: e.comment.trim().slice(0, 180),
    }));

  // ── Treenihälytykset (deterministiset) — vain aktiivisille ──
  const trainingFlags = [];
  if (active) {
    // 1. Yli 10 treeniä jonakin viikkona
    const perWeek = {};
    win.forEach(e => { const k = calWeekKey(e._d); perWeek[k] = (perWeek[k] || 0) + 1; });
    const maxWeek = Math.max(0, ...Object.values(perWeek));
    if (maxWeek > COACHDIGEST_HIGH_WEEK) trainingFlags.push(`erittäin suuri treenimäärä (${maxWeek} yhtenä viikkona)`);

    // 2. Ei vapaapäiviä kahteen viikkoon (kirjaus jokaisena viim. 14 pv)
    const dayKeys = new Set(last14.map(e => calDateKey(e._d)));
    if (dayKeys.size >= COACHDIGEST_ACTIVE_DAYS) trainingFlags.push('ei yhtään vapaapäivää kahteen viikkoon');

    // 3. Puuttuva laji yli kahteen viikkoon
    if (!last14.some(e => e.type === 'Uppopallo'))                       trainingFlags.push('ei uppopalloa yli 2 vk');
    if (!last14.some(e => COACHDIGEST_UINTI_TYPES.includes(e.type)))     trainingFlags.push('ei uintia yli 2 vk');
    if (!last14.some(e => COACHDIGEST_VOIMA_TYPES.includes(e.type)))     trainingFlags.push('ei voimaharjoittelua yli 2 vk');

    // 4. Kovalla viikolla ei kovia treenejä (suunniteltu III/IV, mutta ei III/IV-treeniä)
    getLastNWeeks(6).forEach(wStart => {
      const planned = calPlannedZone(wStart) || '';
      if (!/III|IV/.test(planned)) return;
      const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
      const wkEntries = win.filter(e => e._d >= wStart && e._d < wEnd);
      if (!wkEntries.length) return;                       // ei treenannut → ei tämä hälytys
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

// ── Joukkueen viikkotaso (viim. 6 ISO-viikkoa, suunniteltu tehoalue) ──
function coachDigestTeamWeeks(players) {
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
    const planned  = calPlannedZone(wStart) || '–';
    const isCurrent = today >= wStart && today < wEnd;
    const zoneStr = PERF_ROMAN.map((r, i) => `${r}:${zones[i]}`).join(' ');
    return `Vk ${week}${isCurrent ? ' [kesken]' : ''}: ${sessions} treeniä (tehoalueet ${zoneStr}); suunniteltu tehoalue ${planned}`;
  });
}

// ── Promptin rakennus ─────────────────────────────────────────
function coachDigestBuildPrompt(team, analyzed, weekLines) {
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

// ── Renderöinti ───────────────────────────────────────────────
let coachDigestBusy = false;

function coachDigestSetIntro() {
  const intro = el('coachdigest-intro');
  if (!intro) return;
  intro.innerHTML =
    'Joukkuekoonti fiiliksestä ja treeneistä (per pelaaja 6 viikkoa viimeisestä kirjauksesta). '
    + 'Sisältää myös yksityiset kommentit valmennuskäyttöön.'
    + '<span class="aicoach-disclaimer">AI voi tehdä virheitä – käytä koontia keskustelun tukena, älä ainoana totuutena.</span>';
}

function coachDigestShow(text, ts, players) {
  const out  = el('coachdigest-output');
  const meta = el('coachdigest-meta');
  if (out) {
    out.innerHTML = (typeof aiCoachFormat === 'function') ? aiCoachFormat(text) : escapeHtml(text);
    coachDigestLinkifyNames(out, players);
  }
  if (meta && ts) {
    const d = new Date(ts);
    meta.textContent = `Koonti tehty ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} klo `
      + `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// Tekee AI-tekstissä esiintyvistä pelaajien nimistä klikattavia (→ impersonointi).
// Nimet ja UID:t tulevat OMASTA rakenteisesta datasta (ei AI-tekstistä) → XSS-turvallinen:
// AI-teksti vain haetaan, korvattava sisältö rakennetaan textContentina + dataset-attribuutteina.
function coachDigestLinkifyNames(container, players) {
  const named = (players || []).filter(p => p && p.name && p.uid);
  if (!container || !named.length) return;

  // Nimikartta: koko nimi + uniikki etunimi (jos ei toistu joukkueessa).
  const byName = new Map();
  named.forEach(p => byName.set(p.name, p));
  const firstCounts = {};
  named.forEach(p => { const f = p.name.split(' ')[0]; firstCounts[f] = (firstCounts[f] || 0) + 1; });
  named.forEach(p => {
    const f = p.name.split(' ')[0];
    if (firstCounts[f] === 1 && !byName.has(f)) byName.set(f, p);
  });

  // Pisin ensin → "Anna Korhonen" ennen "Anna"
  const keys = [...byName.keys()].sort((a, b) => b.length - a.length);
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + keys.map(escapeRe).join('|') + ')', 'g');

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    re.lastIndex = 0;
    if (re.test(node.nodeValue)) targets.push(node);
  }

  targets.forEach(tn => {
    const s = tn.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const p = byName.get(m[0]);
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'coachdigest-name-link';
      span.dataset.act   = 'impersonate';
      span.dataset.uid   = p.uid;
      span.dataset.name  = p.name;
      span.dataset.email = p.email || '';
      span.textContent   = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    tn.parentNode.replaceChild(frag, tn);
  });
}

async function coachDigestRun() {
  if (coachDigestBusy) return;
  const team = el('coachdigest-team')?.value;
  const out  = el('coachdigest-output');
  const btn  = el('coachdigest-run-btn');
  if (!team) { if (out) out.innerHTML = '<p class="aicoach-empty">Valitse joukkue.</p>'; return; }

  coachDigestBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Analysoidaan…'; }
  if (out) out.innerHTML = '<p class="loading">Kootaan joukkueen tilannetta…</p>';

  try {
    if (typeof window.geminiGenerate !== 'function') throw new Error('AI-moduuli ei latautunut');
    const raw = await coachDigestFetchTeam(team);
    if (!raw.length) {
      if (out) out.innerHTML = '<p class="aicoach-empty">Ei pelaajia tässä joukkueessa.</p>';
      return;
    }
    const analyzed  = raw.map(coachDigestAnalyzePlayer);
    const weekLines = coachDigestTeamWeeks(raw);
    if (!analyzed.some(p => p.hasData)) {
      if (out) out.innerHTML = '<p class="aicoach-empty">Joukkueella ei ole vielä treenikirjauksia analysoitavaksi.</p>';
      return;
    }
    const text = await window.geminiGenerate(coachDigestBuildPrompt(team, analyzed, weekLines));
    const ts   = Date.now();
    const slim = analyzed.map(p => ({ uid: p.uid, name: p.name, email: p.email, hasData: p.hasData, wellbeingFlag: !!p.wellbeingFlag }));
    coachDigestSetCached(team, text, slim, ts);
    coachDigestShow(text, ts, analyzed);
  } catch (err) {
    console.error('Hyvinvointi-koonti:', err);
    if (out) out.innerHTML = `<p class="aicoach-error">Koonti epäonnistui: ${escapeHtml(err?.message || String(err))}`
      + `<br><span class="aicoach-error-hint">Varmista että Firebase AI Logic (Gemini Developer API) on käytössä Firebase-konsolissa (Build → AI Logic).</span></p>`;
  } finally {
    coachDigestBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '↻ Päivitä'; }
  }
}

async function renderCoachDigestTab() {
  const out = el('coachdigest-output');
  if (!out) return;
  coachDigestSetIntro();

  const team = el('coachdigest-team')?.value;
  if (!team) { out.innerHTML = '<p class="aicoach-empty">Valitse joukkue ja paina Päivitä.</p>'; return; }

  const cached = coachDigestGetCached(team);
  if (cached) {
    coachDigestShow(cached.text, cached.ts, cached.players || []);
  }
  const stale = !cached
    || (Date.now() - cached.ts > COACHDIGEST_TTL)
    || cached.pv !== COACHDIGEST_PROMPT_VERSION;
  if (stale) coachDigestRun();
}

// Joukkuevalinnan vaihto: näytä cache (jos on) tai kehota päivittämään
el('coachdigest-team')?.addEventListener('change', () => renderCoachDigestTab());
el('coachdigest-run-btn')?.addEventListener('click', () => coachDigestRun());

// Tekstin nimilinkkien delegation (pysyvä container) → impersonointi
el('coachdigest-output')?.addEventListener('click', e => {
  const t = e.target.closest('[data-act="impersonate"]');
  if (t) startImpersonation(t.dataset.uid, t.dataset.name, t.dataset.email);
});
