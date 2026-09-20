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
const COACHDIGEST_PROMPT_VERSION = 1;
const COACHDIGEST_VOIMA_TYPES   = ['Voimaharjoittelu', 'Kuntosali', 'Kahvakuula', 'Kuntopiiri'];
const COACHDIGEST_UINTI_TYPES   = ['Uinti', 'Avovesiuinti'];
const COACHDIGEST_FETCH_LIMIT   = 80;   // per pelaaja (kattaa ~6 vk + marginaali)
const COACHDIGEST_DEFAULT_TEAM  = 'Naisten Maajoukkue';

// Kommenteista poimittavat "signaalisanat" (henkinen kuormitus / jaksaminen)
const COACHDIGEST_MOOD_WORDS = [
  'väsy', 'uupu', 'näänty', 'poikki', 'loppu', 'jaksa', 'jaksami', 'univaj', 'nuku huono',
  'stress', 'paine', 'kiire', 'ahdist', 'masent', 'alaku', 'motivaati', 'turhaut', 'kyllästy',
  'kipu', 'kipeä', 'sairas', 'flunssa', 'kuume', 'vamma', 'loukkaan', 'rasitus', 'kramppi',
];

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
  if (!es.length) return { uid: p.uid, name: p.name, email: p.email, hasData: false };

  const maxDate  = es.reduce((m, e) => e._d > m ? e._d : m, new Date(0));
  const winStart = new Date(maxDate); winStart.setDate(winStart.getDate() - 42);
  const midStart = new Date(maxDate); midStart.setDate(midStart.getDate() - 21);

  const win    = es.filter(e => e._d > winStart && e._d <= maxDate);
  const recent = win.filter(e => e._d > midStart);       // viim. 3 vk
  const prior  = win.filter(e => e._d <= midStart);      // edell. 3 vk

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

  // Kommentit (myös yksityiset) — poimi vain signaaliset: matala fiilis TAI signaalisana
  const comments = win
    .filter(e => (e.comment || '').trim())
    .filter(e => (e.feeling >= 1 && e.feeling <= 2) ||
      COACHDIGEST_MOOD_WORDS.some(w => e.comment.toLowerCase().includes(w)))
    .sort((a, b) => b._d - a._d)
    .slice(0, 3)
    .map(e => ({
      date: `${e._d.getDate()}.${e._d.getMonth() + 1}.`,
      feeling: e.feeling >= 1 ? e.feeling : null,
      text: e.comment.trim().slice(0, 180),
    }));

  const wellbeingFlag = (feelDelta != null && feelDelta <= -1.0) || lowRecent >= 3;

  return {
    uid: p.uid, name: p.name, email: p.email, hasData: true,
    sessions: win.length, uppo, oheis, uinti, voima,
    recentFeel, priorFeel, feelDelta, lowRecent, comments, wellbeingFlag,
    maxDate,
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
  const withData = analyzed.filter(p => p.hasData);
  const playerLines = withData.map(p => {
    const feel = p.recentFeel != null
      ? `fiilis viim.3vk ${p.recentFeel}/5 vs edell.3vk ${p.priorFeel != null ? p.priorFeel + '/5' : '–'}${p.feelDelta != null ? ` (muutos ${p.feelDelta > 0 ? '+' : ''}${p.feelDelta})` : ''}`
      : 'fiilis –';
    const low = p.lowRecent > 0 ? `; ${p.lowRecent} matalan fiiliksen (1–2) treeniä viim.3vk` : '';
    const flag = p.wellbeingFlag ? ' [SIGNAALI]' : '';
    let line = `- ${p.name}${flag}: 6vk yhteensä ${p.sessions} treeniä (uppopallo ${p.uppo}, oheis ${p.oheis}, uinti ${p.uinti}, voima ${p.voima}); ${feel}${low}.`;
    if (p.comments.length) {
      line += ' Kommentit: ' + p.comments.map(c =>
        `"${c.text}"${c.feeling ? ` (fiilis ${c.feeling})` : ''}`).join(' ');
    }
    return line;
  });
  const noData = analyzed.filter(p => !p.hasData).map(p => p.name);

  return `Olet uppopallon (underwater rugby) huippuvalmentaja. Laadit joukkueen valmentajalle TIIVIIN hyvinvointi- ja harjoittelukoonnin suomeksi. Pidä koko vastaus korkeintaan noin kahden ruudun/sivun mittaisena. Ole lempeä, konkreettinen ja ammattimainen. Käytä selkeää, arkista suomea äläkä ammattislangia. Jos joudut viittaamaan mittariin (esim. kokonaisrasitus/ACWR), käytä arkitermiä ja laita lyhenne tarvittaessa sulkeisiin. ÄLÄ tee terveys- tai lääketieteellisiä diagnooseja — kuvaile vain havaintoja fiiliksestä ja kommenteista ja ehdota, että valmentaja voi jutella pelaajan kanssa.

JOUKKUE: ${team} (${analyzed.length} pelaajaa, joista ${withData.length} kirjannut treenejä)

JOUKKUEEN VIIKKOTASO (viimeiset 6 viikkoa, suunniteltu tehoalue mukana):
${weekLines.join('\n')}

PELAAJAKOHTAINEN DATA (kunkin pelaajan 6 viikkoa hänen viimeisimmästä kirjauksestaan taaksepäin; fiilisvertailu = viim. 3 vk vs edell. 3 vk. "[SIGNAALI]" = automaattinen esisuodatin havaitsi fiiliksen laskun ≥1.0 tai ≥3 matalan fiiliksen treeniä):
${playerLines.join('\n')}${noData.length ? `\n\nEI KIRJAUKSIA (älä arvioi näitä): ${noData.join(', ')}` : ''}

TREENIANALYYSIN TEESIT (tiiviisti, joukkuetasolla):
- Hyvään viikkoon kuuluu sekä uppopalloa että monipuolista oheista (uinti + voima). Suuntaa-antava: 4 harj/vko → 2+2, 5 → 2+3, 6 → 3+3, 7 → 3+4.
- Joka viikko ~60 % kuormasta olisi hyvä olla kevyttä/tasapainottavaa (tehoalueet I, II tai V). Kovan teeman viikoilla kovan työn (III–IV) osuus vähintään ~20 %.
- Katso osuvatko kovat tehoaluetreenit suunniteltuun tehoalueeseen.
- Sovellus on ollut käytössä vähän aikaa: tyhjät/vähäiset viikot johtuvat todennäköisesti kirjaamatta jättämisestä, EI treenaamattomuudesta. Kesken oleva viikko ei ole "kevyt". Älä moiti näistä.

HENKISEN HYVINVOINNIN OHJE:
- Fiilis (1–5) on tässä sovelluksessa pelaajan henkisen jaksamisen pääsignaali. Yhdistä se kommentteihin.
- Nimeä VAIN pelaajat joilla on selkeä nosto (lasku fiiliksessä, toistuva matala fiilis, tai kommentti joka viittaa väsymykseen/stressiin/kipuun). Muista pelaajista riittää maininta "ei erityisiä nostoja".
- Yksi lause per pelaaja + tarvittaessa lyhyt sitaatti kommentista. Ei diagnooseja, ei dramatisointia.

VASTAUKSEN MUOTO (markdown):
## Joukkueen kokonaiskuva
2–4 lausetta joukkueen tilanteesta (treeni + henkinen puoli).

## Harjoittelu
3–5 luettelokohtaa ("- ") joukkuetason havainnoista (määrät, uppopallo/oheis-suhde, tehoaluejakauma, osuvuus suunnitelmaan). Nimeä pelaaja vain jos hän selkeästi poikkeaa.

## Henkinen hyvinvointi
Luettelo ("- ") vain niistä pelaajista joilla on nosto: nimi + yksi lause + tarvittaessa lyhyt sitaatti. Lopuksi yksi rivi: "Muilla ei erityisiä nostoja." jos niin on.
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

function coachDigestShow(text, ts) {
  const out  = el('coachdigest-output');
  const meta = el('coachdigest-meta');
  if (out) out.innerHTML = (typeof aiCoachFormat === 'function') ? aiCoachFormat(text) : escapeHtml(text);
  if (meta && ts) {
    const d = new Date(ts);
    meta.textContent = `Koonti tehty ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} klo `
      + `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

// Pelaajanapit rakennetaan OMASTA rakenteisesta datasta (ei AI-tekstistä) → XSS-turvallinen.
function coachDigestRenderPlayers(players) {
  const box = el('coachdigest-players');
  if (!box) return;
  const withData = (players || []).filter(p => p.hasData);
  if (!withData.length) { box.innerHTML = ''; return; }
  const sorted = [...withData].sort((a, b) =>
    (b.wellbeingFlag - a.wellbeingFlag) || a.name.localeCompare(b.name, 'fi'));
  box.innerHTML = `<h4 class="coachdigest-players-title">Pelaajat</h4>`
    + sorted.map(p => {
      const dot = p.wellbeingFlag ? '<span class="coachdigest-dot" title="Signaali fiiliksessä"></span>' : '';
      return `<div class="coachdigest-player-row">
          <span class="coachdigest-player-name">${dot}${escapeHtml(p.name)}</span>
          <button class="btn-secondary coachdigest-open-btn" data-act="impersonate"
            data-uid="${escapeHtml(p.uid)}" data-name="${escapeHtml(p.name)}" data-email="${escapeHtml(p.email)}">Avaa loki</button>
        </div>`;
    }).join('');
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
  el('coachdigest-players') && (el('coachdigest-players').innerHTML = '');

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
    coachDigestShow(text, ts);
    coachDigestRenderPlayers(analyzed);
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
    coachDigestShow(cached.text, cached.ts);
    coachDigestRenderPlayers(cached.players || []);
  }
  const stale = !cached
    || (Date.now() - cached.ts > COACHDIGEST_TTL)
    || cached.pv !== COACHDIGEST_PROMPT_VERSION;
  if (stale) coachDigestRun();
}

// Joukkuevalinnan vaihto: näytä cache (jos on) tai kehota päivittämään
el('coachdigest-team')?.addEventListener('change', () => renderCoachDigestTab());
el('coachdigest-run-btn')?.addEventListener('click', () => coachDigestRun());

// Pelaajanappien delegation (pysyvä container) → impersonointi
el('coachdigest-players')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-act="impersonate"]');
  if (btn) startImpersonation(btn.dataset.uid, btn.dataset.name, btn.dataset.email);
});
