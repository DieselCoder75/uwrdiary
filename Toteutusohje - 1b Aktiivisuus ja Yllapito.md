# 1b toteutus — Aktiivisuus & Ylläpito

Pohjana suunnan **1b** (design-kanvaasi `Hallintapaneeli.dc.html`, osiot `#1b`). Kaikki muutokset käyttävät jo olemassa olevia CSS-muuttujia (`--blue`, `--blue-mid`, `--blue-ghost`, `--radius`, `--shadow` jne.) — ei uusia värejä.

Koska aktiiviset käyttäjät ovat käytännössä aina NMJ:tä, **joukkuevalinta poistetaan Aktiivisuus-välilehdeltä** ja raportti ladataan automaattisesti kaikista pelaajista.

---

## 1. Aktiivisuus-välilehti

### index.html — `#admin-tab-aktiivisuus`
Poista team-select + Lataa-rivi, korvaa yhteenveto-hero-kortilla:

```html
<!-- Tab: Aktiivisuus -->
<div id="admin-tab-aktiivisuus" class="tab-content">
  <div class="admin-section">
    <div id="admin-activity-hero" class="act-hero-card">
      <!-- renderActivityHero() täyttää -->
    </div>

    <div id="admin-activity-report">
      <p class="loading">Haetaan harjoitustietoja…</p>
    </div>

    <button id="act-legend-toggle" class="act-legend-toggle-btn" type="button">Selite ?</button>
    <div class="act-report-legend hidden" id="act-legend-body">
      <div class="act-legend-row">
        <span><span class="act-legend-swatch act-week-0"></span> 0 treeniä</span>
        <span><span class="act-legend-swatch act-week-1"></span> 1 treeni</span>
        <span><span class="act-legend-swatch act-week-2"></span> 2 treeniä</span>
        <span><span class="act-legend-swatch act-week-3"></span> 3+</span>
      </div>
      <div class="act-legend-row">
        <span><span class="act-status act-status--active"></span> Aktiivinen</span>
        <span><span class="act-status act-status--moderate"></span> Kohtalainen</span>
        <span><span class="act-status act-status--inactive"></span> Ei aktiivinen</span>
      </div>
    </div>
  </div>
</div>
```

Poista/piilota vastaavasti `admin-report-team` ja `admin-report-btn` -elementit ja niiden `populateAdminPortalSelects` -kutsut jos niitä ei enää tarvita muualla.

### admin.js

**a) Lataa raportti automaattisesti** kun Aktiivisuus-välilehti avataan — korvaa napin `click`-kuuntelijan:

```js
// openAdminPortal() / vaihdettaessa aktiiviseksi:
if (tabName === 'aktiivisuus') {
  renderActivityReport('__all__'); // ei enää joukkuevalintaa
}
```

`renderActivityReport(team, force)` toimii jo `team === '__all__'` -tapauksessa (rivi ~483 käyttää `cachedAdminUsers` suoraan), joten funktiota itseään ei tarvitse muuttaa.

**b) Uusi `renderActivityHero(memberData)`** — kutsu `renderActivityReportHtml`-funktion alussa, ennen `container.innerHTML = …`:

```js
function renderActivityHero(memberData) {
  const host = el('admin-activity-hero');
  if (!host) return;

  const activeCount = memberData.filter(m => m.total4 >= 2).length;
  const total = memberData.length;
  const avgPerWeek = total
    ? (memberData.reduce((s, m) => s + m.total4, 0) / total / 4).toFixed(1)
    : '0.0';

  // kolmiosainen palkki: aktiiviset / kohtalaiset / ei-aktiiviset osuudet
  const moderate = memberData.filter(m => m.total4 === 1).length;
  const inactive = total - activeCount - moderate;
  const pct = n => total ? Math.max(4, Math.round(n / total * 100)) : 0;

  host.innerHTML = `
    <div class="act-hero-label">JOUKKUEEN AKTIIVISUUS · 4 VK</div>
    <div class="act-hero-stats">
      <div class="act-hero-main">
        <span class="act-hero-num">${activeCount}<small>/${total}</small></span>
        <span class="act-hero-sub">aktiivista pelaajaa</span>
      </div>
      <div class="act-hero-side">
        <span class="act-hero-num act-hero-num--sm">${avgPerWeek}</span>
        <span class="act-hero-sub">treeniä / vk keskiarvo</span>
      </div>
    </div>
    <div class="act-hero-bar">
      <div class="act-hero-bar-seg act-hero-bar-seg--active" style="flex:${pct(activeCount)}"></div>
      <div class="act-hero-bar-seg act-hero-bar-seg--moderate" style="flex:${pct(moderate)}"></div>
      <div class="act-hero-bar-seg act-hero-bar-seg--inactive" style="flex:${pct(inactive)}"></div>
    </div>`;
}
```

Kutsu se `renderActivityReportHtml(container, memberData, weeks)`:n alkuun: `renderActivityHero(memberData);` heti `memberData.sort(...)` jälkeen.

**c) Selite piiloon oletuksena**, avautuu napista:

```js
el('act-legend-toggle')?.addEventListener('click', () => {
  el('act-legend-body').classList.toggle('hidden');
});
```

### styles.css — lisää

```css
.act-hero-card {
  border-radius: var(--radius);
  background: linear-gradient(135deg, #1444A0 0%, #1B62D4 55%, #3A82F0 100%);
  color: #fff;
  padding: 0.9rem 1.1rem 0.85rem;
  margin-bottom: 0.85rem;
  box-shadow: 0 4px 18px rgba(20,68,160,0.28);
  overflow: hidden;
}
.act-hero-label {
  font-size: 0.68rem; font-weight: 900; letter-spacing: 0.09em; opacity: 0.8;
  margin-bottom: 0.5rem;
}
.act-hero-stats { display: flex; align-items: flex-end; justify-content: space-between; gap: 0.75rem; }
.act-hero-main, .act-hero-side { display: flex; flex-direction: column; gap: 2px; }
.act-hero-side { align-items: flex-end; }
.act-hero-num { font-size: 2rem; font-weight: 900; line-height: 1; }
.act-hero-num small { font-size: 1rem; font-weight: 700; opacity: 0.7; }
.act-hero-num--sm { font-size: 1.1rem; }
.act-hero-sub { font-size: 0.72rem; font-weight: 700; opacity: 0.78; }
.act-hero-bar { display: flex; gap: 4px; align-items: center; margin-top: 0.6rem; }
.act-hero-bar-seg { height: 6px; border-radius: 99px; }
.act-hero-bar-seg--active   { background: rgba(255,255,255,0.9); }
.act-hero-bar-seg--moderate { background: rgba(255,255,255,0.45); }
.act-hero-bar-seg--inactive { background: rgba(255,255,255,0.18); }

.act-legend-toggle-btn {
  background: none; border: none; padding: 0.4rem 0;
  font-size: 0.78rem; font-weight: 800; color: var(--blue-mid); cursor: pointer;
}
```

**Pelaajakortit valkoisiksi kortistoiksi** (nyt `.act-card` on litteä lista — muutetaan jokainen omaksi kortiksi, kuten 1b:ssä):

```css
.act-card {
  background: var(--white);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  border: 1px solid var(--border-light);
  padding: 0.75rem 1rem;
  margin-bottom: 0.65rem;
  border-bottom: none; /* korvaa vanhan rivierottelun */
}
.act-card:last-child { margin-bottom: 0; }
.act-week-cell { height: 16px; border-radius: 4px; } /* isompi, kuten 1b */
```

`.act-card-list` pysyy ennallaan (vain `gap`/`margin` hoituu kortin omalla marginaalilla).

---

## 2. Ylläpito-välilehti

Rakenne pysyy samana (Joukkueet → Viikkosuunnitelma → Varmuuskopio → 2 vaarallista toimintoa), mutta jokainen `.admin-section` kääritään valkoiseksi kortiksi ja kaksi viimeistä toimintoa ryhmitellään punareunaiseen "Vaara-alue"-korttiin.

### index.html
Lisää luokka `admin-card` jokaiseen `.admin-section`-diviin `#admin-tab-yllapito`:ssa (poista turhat inline `border-top`/`padding-top` -tyylit, kortti hoitaa erottelun varjolla):

```html
<div class="admin-section admin-card">
  <h3 class="admin-section-title">🏟️ Joukkueet</h3>
  ...
</div>

<div class="admin-section admin-card">
  <h3 class="admin-section-title">📅 Viikkosuunnitelma</h3>
  ...
</div>

<div class="admin-section admin-card">
  <h3 class="admin-section-title">💾 Varmuuskopio</h3>
  ...
</div>

<!-- Vaara-alue: korvaa kaksi viimeistä .admin-section-lohkoa -->
<div class="admin-card admin-danger-zone">
  <div class="admin-danger-zone-header">Vaara-alue</div>
  <div class="admin-danger-zone-row">
    <div class="admin-danger-zone-copy">
      <div class="admin-danger-zone-title">Reaktiodatan korjaus</div>
      <div class="admin-danger-zone-desc">Rakentaa reaktiolaskurit uudelleen</div>
    </div>
    <button id="fix-reactions-btn" class="admin-danger-zone-btn">Aja…</button>
  </div>
  <div id="fix-reactions-log" class="admin-danger-zone-log"></div>

  <div class="admin-danger-zone-row">
    <div class="admin-danger-zone-copy">
      <div class="admin-danger-zone-title">Orporeaktioiden poisto</div>
      <div class="admin-danger-zone-desc">Poistaa reaktiot ilman käyttäjää</div>
    </div>
    <button id="purge-orphan-reactions-btn" class="admin-danger-zone-btn admin-danger-zone-btn--danger">Aja…</button>
  </div>
  <div id="purge-reactions-log" class="admin-danger-zone-log"></div>
</div>
```

Pitkät selitystekstit ("Rakentaa reactionByUser- ja reactionCounts-kentät…") siirtyvät napin painalluksesta avautuvaan confirm-dialogiin (`confirm()` tai olemassa oleva modal), eivät enää näy suoraan sivulla — vähemmän tekstiä, sama tieto saatavilla ennen varsinaista ajoa.

### styles.css — lisää

```css
.admin-card {
  background: var(--white);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  border: 1px solid var(--border-light);
  padding: 1rem 1.1rem 1.1rem;
  margin-bottom: 0.85rem;
}
/* poista vanha border-top-erottelu, korttien väli hoitaa asian */
.admin-card + .admin-card { margin-top: 0; }

.admin-danger-zone {
  border: 1px solid #F5C6C6;
  padding: 0;
  overflow: hidden;
}
.admin-danger-zone-header {
  background: var(--danger-light);
  color: var(--danger);
  font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em;
  padding: 0.75rem 1.1rem;
}
.admin-danger-zone-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  padding: 0.75rem 1.1rem;
  border-bottom: 1px solid var(--border-light);
}
.admin-danger-zone-row:last-of-type { border-bottom: none; }
.admin-danger-zone-title { font-size: 0.85rem; font-weight: 700; color: var(--text); }
.admin-danger-zone-desc { font-size: 0.74rem; color: var(--text-muted); }
.admin-danger-zone-btn {
  flex-shrink: 0;
  font-size: 0.78rem; font-weight: 700; color: var(--blue-mid);
  padding: 0.4rem 0.8rem; border-radius: 99px;
  border: 1.5px solid var(--border); background: var(--blue-ghost);
  cursor: pointer;
}
.admin-danger-zone-btn--danger {
  color: var(--danger); border-color: #F5C6C6; background: var(--danger-light);
}
.admin-danger-zone-log {
  font-size: 0.8rem; font-family: monospace; color: var(--text-muted);
  max-height: 200px; overflow-y: auto; padding: 0 1.1rem 0.75rem;
}
```

**Viikkosuunnitelma-rivit** — lisää vain hienovarainen tehoalue-värikoodaus (`renderWeekPlanSection`, admin.js):

```js
const ZONE_COLORS = {
  'I':   { bg: 'var(--border-light)', fg: 'var(--text-muted)' },
  'II':  { bg: '#DFF6F8', fg: '#0b5460' },
  'III': { bg: '#FFF2DA', fg: '#7a4d00' },
  'IV':  { bg: '#FFE1D6', fg: '#8a2e0a' },
  'V':   { bg: '#FBD9D9', fg: '#7a0f0f' },
};
// week-plan-badge-elementtiin: style="background:${ZONE_COLORS[zone]?.bg}; color:${ZONE_COLORS[zone]?.fg}"
```

(`zone`-arvo on roomalainen numero I–V, ks. `PERF_LABELS` `config.js`:ssä.)

---

## Yhteenveto muutoksista
- Aktiivisuus: joukkuevalinta pois → automaattinen lataus, uusi gradientti-hero-yhteenveto ylös, selite piiloon napin taakse, pelaajarivit → valkoiset kortit.
- Ylläpito: jokainen lohko omaksi valkoiseksi kortiksi, kaksi vaarallista toimintoa yhteen punareunaiseen "Vaara-alue"-korttiin tiiviimmällä tekstillä, viikkosuunnitelman tehoalueet väritetty.
- Ei uusia värejä tai fontteja — kaikki `:root`-muuttujista.
