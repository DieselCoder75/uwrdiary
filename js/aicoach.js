// ============================================================
// AI COACH — Gemini-pohjainen valmennusanalyysi (admin-only)
// ============================================================
// Käyttää Firebase AI Logic -SDK:ta (Gemini Developer API). Itse Gemini-kutsu
// tapahtuu erillisessä ES-moduulissa (index.html), joka asettaa
// window.geminiGenerate(prompt). Tämä tiedosto kokoaa datan, rakentaa promptin,
// ja renderöi tuloksen. Analysoidaan vain MUISTISSA oleva jakso (allChartEntries
// = viimeiset 12 viikkoa), ei koko treenihistoriaa.

const AICOACH_LS_PREFIX = 'uppis_aicoach_';          // + uid
const AICOACH_TTL       = 7 * 24 * 60 * 60 * 1000;    // 1 vko
// Nosta tätä aina kun promptia muutetaan → vanha välimuisti mitätöityy ja
// analyysi ajetaan uusiksi uudella promptilla seuraavalla avauksella.
const AICOACH_PROMPT_VERSION = 4;
const AICOACH_VOIMA_TYPES = ['Voimaharjoittelu', 'Kuntosali', 'Kahvakuula', 'Kuntopiiri'];

const AICOACH_ZONE_DESC = [
  '',
  'I – Peruskunto/Palauttava: syke 50–70 %, hyvin kevyt, rakentaa verenkiertoa ja palautumista.',
  'II – Kestävyys: syke 60–80 %, reipas ja tasainen, siirtää maitohappokynnystä ylöspäin.',
  'III – Maksimikestävyys: syke 80–90 %, pitkät kovat vedot (>2 min), kasvattaa maksimihapenottoa.',
  'IV – Nopeuskestävyys: syke 90–100 %, lyhyet maksimi-intervallit 30–60 s, korkein metabolinen stressi.',
  'V – Nopeus: räjähtävät <10 s pyrähdykset + pitkät palautukset, korkea neuraalinen stressi.',
];

const AICOACH_OHEIS_GUIDE = `UPPOPALLO vs OHEISTREENI:
Pelkkä uppopalloharjoittelu ei riitä kehittämään maajoukkuetason pelaajalle tarvittavia fyysisiä valmiuksia kansainväliselle tasolle. Kehittyminen vaatii monipuolista oheisharjoittelua (esim. uinti, juoksu, kuntosali, kuntopiiri), joka tukee nopeutta, kestävyyttä, voimaa ja liikkuvuutta.
Hyvään viikkoon kuuluu oheisharjoittelussa sekä uintia että voimaharjoittelua (jossain muodossa) – ne ovat molemmat tärkeä osa kokonaisuutta.
Suuntaa-antava jaottelu harjoitusmäärän mukaan:
- 4 harj/vko: 2 uppopallo, 2 oheis
- 5 harj/vko: 2 uppopallo, 3 oheis
- 6 harj/vko: 3 uppopallo, 3 oheis
- 7 harj/vko: 3 uppopallo, 4 oheis`;

// ── Datan kokoaminen muistissa olevista treeneistä ────────────
function aiCoachBuildContext() {
  const entries = allChartEntries || [];
  const weeks   = getLastNWeeks(12);
  const history = entries.length ? calcEwmaHistory(entries) : [];

  // ACWR per viikko (viikon viimeinen päivä historiassa)
  const acwrByWeek = weeks.map(wStart => {
    const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 6);
    const pts  = history.filter(h => h.date >= wStart && h.date <= wEnd);
    const last = pts.length ? pts[pts.length - 1] : null;
    return last && last.ctl > 0 ? +(last.atl / last.ctl).toFixed(2) : null;
  });

  const lines = weeks.map((wStart, wi) => {
    const wEnd = new Date(wStart); wEnd.setDate(wEnd.getDate() + 7);
    const wk   = entries.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      return d >= wStart && d < wEnd;
    });
    const { week } = calIsoWeekData(wStart);
    const planned  = calPlannedZone(wStart) || '–';
    const uppo     = wk.filter(e => e.type === 'Uppopallo').length;
    const oheis    = wk.length - uppo;
    const voima    = wk.filter(e => AICOACH_VOIMA_TYPES.includes(e.type)).length;
    const uinti    = wk.filter(e => e.type === 'Uinti' || e.type === 'Avovesiuinti').length;
    const feels    = wk.map(e => e.feeling).filter(f => f >= 1);
    const avgFeel  = feels.length ? (feels.reduce((s, f) => s + f, 0) / feels.length).toFixed(1) : '–';
    const acwr     = acwrByWeek[wi] !== null ? acwrByWeek[wi] : '–';
    const sessions = wk.map(e => {
      const zone = e.performance >= 1 ? PERF_ROMAN[e.performance - 1] : '–';
      const fl   = e.feeling >= 1 ? e.feeling : '–';
      return `${e.type} ${e.duration}min(teho ${zone}, fiilis ${fl})`;
    }).join('; ') || 'ei treenejä';
    return `Vk ${week}: yhteensä ${wk.length} treeniä (uppopallo ${uppo}, oheis ${oheis}, joista uinti ${uinti}, voima ${voima}); suunniteltu tehoalue ${planned}; fiilis ka ${avgFeel}/5; ACWR ${acwr}. Treenit: ${sessions}`;
  });

  // Ensi viikon suunniteltu tehoalue (suosituksia varten)
  const nextMon = new Date(weeks[weeks.length - 1]);
  nextMon.setDate(nextMon.getDate() + 7);
  const nextWeekZone = calPlannedZone(nextMon) || '–';
  const nextWeekNum  = calIsoWeekData(nextMon).week;

  // Viimeisten 7 päivän treenimäärä (laskien viimeisimmästä kirjauksesta taaksepäin)
  let recentSessionCount = 0;
  if (entries.length) {
    const lastDate = entries
      .map(e => e.date?.toDate ? e.date.toDate() : new Date(e.date))
      .reduce((max, d) => d > max ? d : max, new Date(0));
    const cutoff = new Date(lastDate);
    cutoff.setDate(cutoff.getDate() - 7);
    recentSessionCount = entries.filter(e => {
      const d = e.date?.toDate ? e.date.toDate() : new Date(e.date);
      return d >= cutoff && d <= lastDate;
    }).length;
  }

  return { lines, entryCount: entries.length, nextWeekZone, nextWeekNum, recentSessionCount };
}

function aiCoachBuildPrompt() {
  const ctx = aiCoachBuildContext();
  const zoneDesc = AICOACH_ZONE_DESC.filter(Boolean).join('\n');
  return `Olet uppopallon (underwater rugby) huippuvalmentaja. Analysoi pelaajan viimeisten viikkojen harjoitusdata ja anna kannustava mutta rehellinen valmennusanalyysi suomeksi. Saat sinutella ja puhua mutkattomasti, kuin valmentaja pelaajalleen – ei jäykkää virkakieltä.

PELAAJAN HARJOITUSDATA (vain muistissa oleva jakso, ${ctx.lines.length} viikkoa, vanhin ensin):
${ctx.lines.join('\n')}

VIIMEISEN 7 PÄIVÄN TREENIKIRJAUKSET (laskien viimeisimmästä kirjauksesta taaksepäin): ${ctx.recentSessionCount} treeniä

ENSI VIIKON (vk ${ctx.nextWeekNum}) SUUNNITELTU TEHOALUE: ${ctx.nextWeekZone}

TEHOALUESELITTEET:
${zoneDesc}

${AICOACH_OHEIS_GUIDE}

TÄRKEÄÄ DATAN TULKINNASSA:
- Sovellus on ollut pelaajilla käytössä vasta vähän aikaa. Tyhjät tai vähäiset viikot (etenkin jakson alkupäässä) johtuvat lähes varmasti siitä, ettei treenejä ole vielä ehditty kirjata – EI siitä ettei olisi treenattu. Älä tee päätelmiä harjoittelun puutteesta tällaisilta jaksoilta äläkä moiti niistä.
- Jos aivan viimeisiltä päiviltä puuttuu treenejä, kyse on todennäköisesti siitä, ettei uusimpia treenejä ole vielä ehditty kirjata. Älä tulkitse tätä harjoittelun vähenemiseksi.
- Keskity siihen jaksoon, jolta dataa selvästi on.

OHJEET ANALYYSIIN:
- Anna erityinen painoarvo viimeisimmälle 1–2 viikolle. Käytä vanhempaa dataa trendien vahvistamiseen ja pitkän aikavälin kokonaisuuden hahmottamiseen, mutta konkreettiset havainnot ja suositukset pohjaa ensisijaisesti tuoreimpaan dataan.
- Arvioi viikoittainen harjoitusmäärä ja uppopallo/oheis-suhde suhteessa yllä olevaan suuntaa-antavaan jaotteluun.
- Huomioi sisältyykö viikoittaiseen oheisharjoitteluun sekä uintia että voimaharjoittelua. Kannusta pitämään molemmat mukana.
- Katso osuvatko kovat tehoaluetreenit kalenterin suunniteltuun tehoalueeseen.
- Tarkista fiilis- ja kuorma (ACWR) -trendit. Jos fiilis on laskussa tai kuorma epäsuotuisalla tasolla (ACWR selvästi yli 1,3 tai jatkuvasti hyvin matala), nosta se esiin lempeästi ja anna konkreettinen vinkki palautumiseen.${ctx.recentSessionCount < 3 ? `\n- HUOMIO: Viimeisen 7 päivän kirjauksissa on vain ${ctx.recentSessionCount} treeni${ctx.recentSessionCount === 1 ? '' : 'ä'}. Kannusta motivoivasti ja lempeästi nostamaan viikoittaista treenimäärää – muistuta, että säännöllisyys on kehittymisen perusta.` : ''}
- Suosituksissa huomioi ensi viikon suunniteltu tehoalue (yllä): ehdota mille tehoalueelle kovat vedot kannattaa ajoittaa.
- Älä tee terveys- tai lääketieteellisiä väittämiä; puhu harjoittelusta.

VASTAUKSEN MUOTO (käytä markdownia):
1. **Kokonaiskuva** – 2–3 kannustavaa lausetta.
2. **Havainnot** – 3–5 luettelokohtaa (markdown-luettelo, "- ") konkreettisista huomioista (määrät, suhteet, tehoalueet, trendit).
3. **Ensi viikolle** – 2–3 luettelokohtaa konkreettisia, motivoivia vinkkejä. Käytä SAMAA markdown-luettelomuotoa ("- ") kuin Havainnot-osiossa – EI numeroitua listaa. Vinkkien tulee huomioida ensi viikon suunniteltu tehoalue.
Pidä vastaus tiiviinä ja selkeänä. Älä toista raakadataa sellaisenaan.`;
}

// ── Renderöinti ───────────────────────────────────────────────
let aiCoachBusy = false;

// Käytä viewUid():tä jotta admin-impersonoinnissa cache pysyy oikealla käyttäjällä
function aiCoachCacheKey() {
  const uid = (typeof viewUid === 'function' ? viewUid() : currentUser?.uid) || 'anon';
  return AICOACH_LS_PREFIX + uid;
}

function aiCoachGetCached() {
  try {
    const raw = localStorage.getItem(aiCoachCacheKey());
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.text === 'string' && typeof p.ts === 'number') return p;
  } catch {}
  return null;
}

function aiCoachSetCached(text, ts, uid) {
  const key = uid ? AICOACH_LS_PREFIX + uid : aiCoachCacheKey();
  try { localStorage.setItem(key, JSON.stringify({ text, ts, pv: AICOACH_PROMPT_VERSION })); } catch {}
}

// Kevyt ja turvallinen markdown→HTML (escapaa kaiken ensin)
function aiCoachFormat(raw) {
  const esc   = escapeHtml(String(raw || ''));
  const inline = s => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
  let html = '', inList = false;
  esc.split('\n').forEach(line => {
    const t = line.trim();
    if (!t) { if (inList) { html += '</ul>'; inList = false; } return; }
    const bullet  = t.match(/^[-*•]\s+(.*)$/);
    const numbered = t.match(/^\d+\.\s+(.*)$/);
    const heading = t.match(/^#{1,6}\s+(.*)$/);
    if (bullet) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(bullet[1])}</li>`;
    } else if (heading) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h4>${inline(heading[1])}</h4>`;
    } else if (numbered) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p class="aicoach-step">${inline(numbered[1])}</p>`;
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${inline(t)}</p>`;
    }
  });
  if (inList) html += '</ul>';
  return html;
}

// Selite napin alle: kertoo todellisen analysoidun aikavälin + varauksen.
function aiCoachSetIntro() {
  const intro = el('aicoach-intro');
  if (!intro) return;
  const entries = allChartEntries || [];
  let rangeTxt = '';
  if (entries.length) {
    const dates = entries
      .map(e => (e.date?.toDate ? e.date.toDate() : new Date(e.date)))
      .sort((a, b) => a - b);
    const fmt = d => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    rangeTxt = ` ajalta ${fmt(dates[0])}–${fmt(dates[dates.length - 1])}`;
  }
  intro.innerHTML =
    `AI-valmentajan analyysi treeneistäsi${escapeHtml(rangeTxt)}. Analysoidaan enintään 12 viikkoa; `
    + `jakso voi olla lyhyempi, jos alusta tai lopusta puuttuu kirjauksia.`
    + `<span class="aicoach-disclaimer">AI voi tehdä virheitä – jos jokin mietityttää, juttele mieluummin oman valmentajasi kanssa.</span>`;
}

function aiCoachShow(text, ts) {
  const out  = el('aicoach-output');
  const meta = el('aicoach-meta');
  if (out) out.innerHTML = aiCoachFormat(text);
  if (meta && ts) {
    const d = new Date(ts);
    meta.textContent = `Analyysi tehty ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} klo `
      + `${String(d.getHours()).padStart(2, '0')}.${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

async function aiCoachRun() {
  if (aiCoachBusy) return;
  const out = el('aicoach-output');
  const btn = el('aicoach-run-btn');
  // Capture uid before any await — impersonation may change during async Gemini call
  const capturedUid = (typeof viewUid === 'function' ? viewUid() : currentUser?.uid) || 'anon';
  if (!allChartEntries.length) await fetchChartEntries();
  if (!allChartEntries.length) {
    if (out) out.innerHTML = '<p class="aicoach-empty">Ei treenidataa analysoitavaksi.</p>';
    return;
  }
  aiCoachBusy = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Analysoidaan…'; }
  if (out) out.innerHTML = '<p class="loading">Valmentaja analysoi treenejäsi…</p>';
  try {
    if (typeof window.geminiGenerate !== 'function') {
      throw new Error('AI-moduuli ei latautunut');
    }
    const text = await window.geminiGenerate(aiCoachBuildPrompt());
    const ts   = Date.now();
    aiCoachSetCached(text, ts, capturedUid);
    aiCoachShow(text, ts);
  } catch (err) {
    console.error('AI Coach:', err);
    if (out) out.innerHTML = `<p class="aicoach-error">Analyysi epäonnistui: ${escapeHtml(err?.message || String(err))}`
      + `<br><span class="aicoach-error-hint">Varmista että Firebase AI Logic (Gemini Developer API) on otettu käyttöön Firebase-konsolissa kohdassa Build → AI Logic.</span></p>`;
  } finally {
    aiCoachBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '↻ Analysoi uudelleen'; }
  }
}

// Kutsutaan kun AI Coach -välilehti avataan
async function renderAiCoachTab() {
  const out = el('aicoach-output');
  if (!out) return;

  if (!allChartEntries.length) {
    out.innerHTML = '<p class="loading">Ladataan treenidataa…</p>';
    await fetchChartEntries();
  }
  if (!allChartEntries.length) {
    out.innerHTML = '<p class="aicoach-empty">Ei treenidataa analysoitavaksi.</p>';
    const meta = el('aicoach-meta'); if (meta) meta.textContent = '';
    return;
  }

  aiCoachSetIntro();

  const cached = aiCoachGetCached();
  if (cached) aiCoachShow(cached.text, cached.ts);

  // Vanhentunut jos: ei cachea, yli viikko vanha, TAI prompti on muuttunut
  const stale = !cached
    || (Date.now() - cached.ts > AICOACH_TTL)
    || cached.pv !== AICOACH_PROMPT_VERSION;
  if (stale) {
    aiCoachRun(); // automaattinen ajo jos ei cachea tai yli viikko vanha
  } else if (!cached) {
    out.innerHTML = '<p class="aicoach-empty">Paina "Analysoi" saadaksesi valmentajan analyysin.</p>';
  }
}

el('aicoach-run-btn')?.addEventListener('click', () => aiCoachRun());
