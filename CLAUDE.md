# UWR Diary — Claude muistio

Tämä tiedosto luetaan automaattisesti jokaisessa Claude Code -sessiossa.

## Projekti lyhyesti

**UWR Diary** on uppopalloilijoiden harjoituspäiväkirja-PWA.  
- URL: https://uwrdiary.web.app  
- Firebase project: `uwrdiary`  
- Admin: `janne.lind@gmail.com`  
- Toinen käyttäjä: `katja.lind@gmail.com`

## Deploy-työnkulku (TÄRKEÄ — muista joka kerta)

1. Muokkaa tiedostoa → **bumppaa sen `?v=` numero index.html:ssä** (cache-first SW
   tarjoilee vanhan tiedoston jos URL ei muutu — tämä on aiheuttanut "ei muuttunut"
   -bugeja: muutos deployattu mutta vanha versio cachessa).
2. **Bumppaa aina `CACHE_NAME` sw.js:ssä** (esim. v146 → v147).
3. `cd "/Users/janne.lind/Documents/My Apps/Uppis" && ./deploy.sh`
   - Skripti käyttää automaattisesti `~/.uppis_firebase_token` (CI-token) jos se on olemassa.
   - Jos tokenia ei ole: aja kerran `firebase login:ci`, tallenna token tiedostoon
     `echo 'TOKEN' > ~/.uppis_firebase_token && chmod 600 ~/.uppis_firebase_token`.
4. Tarkista JS-syntaksi ennen deployta: `node -c js/<tiedosto>.js`.
5. **HUOM:** linter saattaa bumpata `styles.css?v=` automaattisesti — tarkista todellinen
   numero `grep`illä ennen kuin oletat sen arvon.
6. Käyttäjä saa uuden version "Uusi versio saatavilla – Päivitä" -palkista (ks. PWA-osio).

## Teknologiat

- **Frontend**: Vanilla HTML/CSS/JS, ei frameworkia
- **Backend**: Firebase Firestore + Firebase Auth (compat SDK v10.7.1, CDN)
- **Hosting**: Firebase Hosting
- **PWA**: Service Worker (`sw.js`), manifest.json, apple-touch-icon

## Tiedostorakenne

```
index.html          — koko UI (auth + app + modaalit) + inline AI-moduuli + SW-rekisteröinti
styles.css          — kaikki tyylit
sw.js               — service worker
manifest.json
js/
  config.js         — Firebase config, vakiot (PERF_COLORS, TEAMS, ZONE_WEIGHTS, AICOACH_DEFAULT_ON_EMAILS, jne.)
  state.js          — globaalit muuttujat (currentUser, userProfile, impersonating, allChartEntries, jne.)
  cache.js          — Cache-apuluokka (localStorage)
  utils.js          — apufunktiot (el, show, hide, toast, confirm, escapeHtml, jne.)
  records.js        — ennätyslaskenta
  auth.js           — kirjautuminen / rekisteröinti, splash, päivän tervehdys
  entries.js        — treenikirjaukset (CRUD, bottom sheet) + getUserDoc/getViewDoc/viewUid
  charts.js         — Chart.js-kaaviot (Trendit: Omat + Vertailu + Kuorma/EWMA-ACWR)
  joukkue.js        — joukkuefeed, reaktiot
  profile.js        — profiili, salasananvaihto, tilin poisto, tavoitteet, ennätykset, testit
  admin.js          — hallintapaneeli (admin/coach), impersonointi, event delegation
  calendar.js       — kuukausikalenteri, viikkosuunnitelma (WEEKLY_PLAN), ISO-viikot
  aicoach.js        — AI Coach: datan keruu, Gemini-prompt, renderöinti (admin/opt-in)
  app.js            — navigointi, tab/sub-tab-logiikka, swipe
```

## Versiot index.html:ssä (päivitä aina muuttaessa — ks. Deploy-työnkulku)

Senhetkiset (kasvavat jatkuvasti — tarkista aina `grep`illä index.html:stä):
```html
styles.css?v=406
config.js?v=15
state.js?v=4
cache.js?v=2
utils.js?v=5
records.js?v=1
entries.js?v=30
charts.js?v=30
profile.js?v=62
joukkue.js?v=13
calendar.js?v=37
admin.js?v=36
aicoach.js?v=7
auth.js?v=17
app.js?v=17
```

Service worker cache: `CACHE_NAME = 'uwr-diary-v147'` (sw.js rivi 4) — kasvaa joka deployllä.

## Sovelluksen versionumero ("Versio 1.7")

- Sovelluksen näkyvä versio (esim. **"Versio 1.7"**) on kovakoodattu KAHTEEN paikkaan —
  päivitä molemmat samalla: `js/auth.js` (splash) ja `js/profile.js` (`help-version-text`).
- "build" -numero = `styles.css?v=` luettuna dynaamisesti (ei käsin).
- **Käyttöohje** = `#help-modal` index.html:ssä, 3 välilehteä: Käyttöohje / Tietoturva /
  Versiot. Uusi ominaisuus → lisää kuvaus Käyttöohjeeseen JA merkintä Versiot-historiaan,
  ja nosta versionumero (1.7 → 1.8 jne.).

## Design-järjestelmä

### Värit (CSS custom properties, styles.css)

| Muuttuja | Käyttö |
|---|---|
| `--blue` (#003F9C) | Pääväri, primary-napit |
| `--blue-deep` (#002A6E) | Tummin sininen (esim. päivityspalkin tausta) |
| `--blue-mid` (#1A56B0) | Keskisininen (otsikot) |
| `--bg` | Taustaväri |
| `--white` | Kortit, modaalit |
| `--text` | Pääteksti |
| `--text-muted` | Toissijainen teksti (esim. kommentit, AI Coach -teksti) |
| `--border-light` | Reunaviivat |
| `--green` / `--red` | Onnistuminen / virhe |

⚠️ **`--blue-dark` EI ole olemassa** — sen käyttö renderöityy läpinäkyväksi/perityksi.
Käytä `--blue-deep` tai `--blue-mid`. (On aiheuttanut jo läpinäkyvä-tausta- ja
väribugeja.)

### Tehoalueet (PERF_COLORS, config.js)

```js
const PERF_COLORS        = ['#AAAAAA', '#4FC3D0', '#7DC83A', '#F5A623', '#E84040'];
const PERF_COLORS_DARK   = ['#555555', '#1A6B75', '#3A6B10', '#8A5200', '#7A1010'];
const PERF_COLORS_BORDER = ['#888888', '#3A9099', '#5E962B', '#C4841C', '#BA3232'];
// Indeksit: 0=I Peruskunto, 1=II Kestävyys, 2=III Maksimikestävyys, 3=IV Nopeuskestävyys, 4=V Nopeus
```

### Napit

| Luokka | Käyttö |
|---|---|
| `btn-primary` | Sininen täytetty — pää-CTA, Hallintapaneeli, Kirjaudu ulos, Vaihda salasana |
| `btn-secondary` | Harmaa/neutraali |
| `btn-danger-outline` | Punainen reunustettu — vaarallinen toiminto (tilin poisto) |
| `btn-danger-solid` | Punainen täytetty — admin-poistot |

### Z-index-hierarkia (muista tämä!)

```
app-top-bar:      z-index 500  (sticky, transform: translateZ(0))
admin-portal:     z-index 600  (position: fixed, koko ruutu)
.modal:           z-index 700  (entry-modal, profile-modal, help-modal)
.sheet-backdrop:  z-index 750
.bottom-sheet:    z-index 751
.confirm-overlay: z-index 900  (vahvistusdialoogi)
```

## Firestore-rakenne

```
users/{uid}
  email: string
  coachOf: string[]            ← juuressa (EI profile sisällä); valmentajan joukkueet
  profile: { nickname, firstName, lastName, gender, birthday, teams[], photoURL,
             shareActivities, shareComments,
             aiCoachEnabled: bool,                 ← AI Coach -täppä (profiili)
             uiPrefs: { kuormaDisclaimerOpen: bool } }
  myReactions: { "ownerUid_entryId": emoji }   ← käyttäjän omat reaktiot
  /entries/{entryId}
    type, duration, date (Timestamp), performance (1-5), feeling (1-5),
    distance, avgHr, maxHr, comment, privateComment, hasTime, updatedAt
    reactionCounts: { "🔥": 2, "💪": 1 }
    /reactions/{reactorUid}
      emoji, timestamp
  /fitTests/{id}        — 10×100m räpyläpotkutesti
  /maxSpeedTests/{id}   — { date, time }
  /muscleTests/{id}     — lihastestit (kaikki auth-käyttäjät saavat lukea)
```

## Firestore security rules (tärkeimmät)

- Käyttäjä voi lukea/kirjoittaa **omaan** dokumenttiinsa vapaasti
- Kaikki auth-käyttäjät voivat **lukea** muiden entryt (joukkuenäkymä)
- Kaikki auth-käyttäjät voivat **päivittää** vain `reactionCounts`-kenttää muiden entryssä
- Admin voi **päivittää** `myReactions`-kenttää kenen tahansa dokumentissa (migraatio)
- Admin voi **poistaa** kenen tahansa dokumentin

## Reaktio-arkkitehtuuri

- `myReactions` tallennetaan **reaktorin omaan** `users/{currentUid}`-dokumenttiin
- Entryyn kirjoitetaan vain `reactionCounts` (kaikille sallittu)
- `reactions/{reactorUid}`-alikollektio on lähde totuudesta (doc ID = reaktorin UID → max 1/käyttäjä)
- Joukkuefeed lataa `myGlobalReactions` käyttäjän omasta dokumentista (1 Firestore-read)
- Feed-välimuisti: `localStorage` avain `uppis_jf2_{uid}_{cacheKey}`, TTL 45 min

## Joukkuefeed-välimuisti

- Prefix: `uppis_jf2_` (vanha `uppis_jf_` on mitätöity)
- TTL: 45 min (`JOUKKUE_CACHE_TTL`)
- Pakotettu päivitys: ↻-nappi tai force-parametri `renderJoukkueTab(true)`

## localStorage-cachen avaimet (kaikki)

| Avain | Sisältö | TTL |
|---|---|---|
| `uppis_jf2_{uid}_{cacheKey}` | Joukkuefeed-data | 45 min |
| `uppis_cal_{uid}_{year}_{month}` | Kalenterin kuukausidata | 4 h (kuluva/edellinen kk), 7 pv (historia) |
| `uppis_admin_users_{uid}` | Admin-käyttäjälista + recentCount | 24 h |
| `uppis_records_{uid}` | Ennätykset-HTML | 24 h |
| `uppis_act_{uid}_{team}_{weekTs}` | Aktiivisuusraportti (admin) | 1 h |
| `uppis_app_settings` | Sovellusasetukset (dynamicWeekPlan jne.) | ei TTL:ää |
| `uppis_ch_{viewUid}` | Chart-entryt (12 vk) — **viewUid**, ei currentUser! | 1 h |
| `uppis_{viewUid}` Cache.set avaimet `entries_*`, `hasMore_*`, `entries_older_*` | Treenilokin sivutus — **viewUid** | — |
| `uppis_aicoach_{uid}` | AI Coach -analyysi { text, ts, pv } | 1 vko / prompt-versio |
| `uppis_firstname` | Etunimi splash-tervehdykseen | — |
| `uppis_next_splash` / `uppis_was_logged_in` | Splash-esilataus / kirjautumistila | — |

⚠️ **Impersonointi-cache-sääntö:** kaikki treenidatan cache-avaimet käyttävät
`viewUid()`:ia (= impersonoitu käyttäjä jos `impersonating`, muuten currentUser.uid),
EIVÄT `currentUser.uid`:ia. Muuten impersonoidun pelaajan data vuotaa adminin omaan
cacheen. (Tämä oli korkean vakavuuden bugi, korjattu.)

Invalidointi:
- Kalenteri: `invalidateCalendarCache()` — kutsutaan entries save/delete yhteydessä
- Ennätykset: `invalidateEnnatykset()` — kutsutaan entries save/delete yhteydessä
- Admin-käyttäjät: `localStorage.removeItem(ADMIN_USERS_LS + uid)` — kutsutaan adminDeleteUser:ssa

## PWA / iOS-huomiot

- `apple-mobile-web-app-status-bar-style: black-translucent`
- `app-top-bar` tarvitsee `transform: translateZ(0)` jotta Canvas-elementit eivät piirrä sen päälle (iOS GPU-kompositing)
- Service worker: navigation = network-first, static assets = cache-first + background update

## Joukkueet (TEAMS, config.js)

```js
const TEAMS = ['Naisten Maajoukkue', 'Urheilusukeltajat', 'PSK-Kupla'];
```

## Kieli

Käyttöliittymä on **suomeksi**. Koodissa kommentit suomeksi tai englanniksi.

## Testit-välilehti (10×100m räpyläpotkutesti)

Käyttäjäprofiilin **Testit**-välilehdellä on 10×100m räpyläpotkutesti.

**Firestore-polku:** `users/{uid}/fitTests/{testId}`

**Dokumentin rakenne:**
```js
{
  date: Timestamp,
  measurements: [  // 10 alkiota
    { time: number|null, hr1: number|null, hr2: number|null, error: boolean },
    // ...
  ]
}
```

**Mittavirhe-säännöt:**
- `error: true` jos mittauksessa ei ole sykkeitä (hr1=null && hr2=null) → automaattinen
- `error: true` jos käyttäjä on flagannut sen UI:sta

**Max Nopeus -testi:** `users/{uid}/maxSpeedTests/{id}` → `{ date: Timestamp, time: number }`

**Admin-skripti datan importtaamiseen:** `/tmp/upload-fittest.mjs` (käyttää
firebase-adminia + service account JSONia kohdassa
`/Users/janne.lind/Downloads/uwrdiary-firebase-adminsdk-fbsvc-fdf2f53fed.json`).
Hakee UID:n emaililla `auth.getUserByEmail(email)`. firebase-admin asennettu
`/tmp/`:hen — `cd /tmp && node upload-fittest.mjs`.

## Splash screen -kuvat

Loginin/splashin satunnaislogo: `auth.js` lukee `SPLASH_LOGO_IMAGES`-listan
(tällä hetkellä splash-1…splash-4). **Uutta kuvaa lisätessä:** kopioi tiedosto
`img/splash/`-kansioon JA lisää sen polku `SPLASH_LOGO_IMAGES`-listaan auth.js:ssä —
pelkkä tiedoston deploy ei riitä, koodi ei tunne sitä ilman listaa.
Tiedostot kansiossa `img/splash/splash-1.png`, `splash-2.png` jne.
Lisää uusia kuvia työkalulla `tools/resize-splash.html` (output: 512×512 PNG).
Koodi käyttää `_trySetSplashLogo()`-helpperia — jos kuva 404 → fallback
`icon-512.png`. Sama satunnaisesti valittu kuva pysyy myös
kirjautumisanimaatiossa (`justLoggedIn` haara `auth.onAuthStateChanged`:ssä).

## Navigointi & swipe (app.js)

- Päävälilehdet: Treenit / Trendit / Joukkue. Ali-välilehdet per pää-välilehti.
- **Swipe-järjestys:** `PAGES`-taulukko app.js:ssä. **Uutta ali-välilehteä lisätessä
  lisää se PAGES:iin** oikeaan kohtaan, muuten swipe hyppää sen yli.
- `nextVisiblePageIndex()` ohittaa piilotetut (esim. admin-only / opt-in) sivut — sivu
  jonka ali-tab-nappi on `hidden` jätetään swipessä väliin.
- FAB (+) näkyy vain Treenit → Loki -näkymässä eikä impersonoinnin aikana.

## AI Coach (js/aicoach.js + index.html inline -moduuli)

Gemini-pohjainen valmennusanalyysi. Sijainti: **Treenit-rivin ali-välilehti**
(Kalenterin oikealla, `data-subtab="aicoach"`).

**Näkyvyys (opt-in):** profiilin täppä "Ota AI Coach käyttöön"
(`profile.aiCoachEnabled`). Oletus pois, PAITSI `AICOACH_DEFAULT_ON_EMAILS`
(config.js): `janne.lind@gmail.com`, `nuppu.rytioja@gmail.com`,
`paula.aittooja@gmail.com`. Resolveri `aiCoachEnabledForCurrentUser()` profile.js:ssä;
tab-näkyvyys päivitetään `updateAdminShortcut()`:ssa.

**Data:** vain MUISTISSA oleva jakso `allChartEntries` (viim. 12 vk) — ei koko historiaa.
Per viikko: uppopallo/oheis/uinti/voima-määrät, tehoalueet, kalenterin suunniteltu
tehoalue (`calPlannedZone`), fiilis-ka, ACWR (`calcEwmaHistory`). Lisäksi ENSI viikon
suunniteltu tehoalue suosituksia varten.

**Prompt:** kiinteät osat aicoach.js:ssä (rooli="huippuvalmentaja" sisäisesti, mutta
käyttäjälle näkyvä teksti sanoo "AI-valmentaja"); tehoalueselitteet; uppopallo/oheis-
ohjeistus (jaottelutaulukko 4–7 harj/vko; uinti+voima osana viikoittaista oheista);
datan-tulkintaohje (sovellus uusi → tyhjät viikot = puuttuvat kirjaukset, ei
treenaamattomuus); vastausmuoto Kokonaiskuva / Havainnot (- lista) / Ensi viikolle
(- lista, sama muoto). `AICOACH_PROMPT_VERSION` — nosta kun promptia muutetaan →
cache mitätöityy ja analyysi ajetaan uusiksi.

**Ajologiikka:** avattaessa näyttää cachen; ajaa automaattisesti uuden jos ei cachea,
>1 vko vanha, TAI prompt-versio muuttunut. "↻ Analysoi uudelleen" pakottaa ajon.

**Gemini-integraatio:** Firebase AI Logic (modulaarinen SDK 11.10.0, ESM-import
gstaticista index.html:n `<script type="module">`-lohkossa). `GoogleAIBackend`
(Gemini Developer API, ilmainen taso), malli `gemini-2.5-flash`. Erillinen modulaarinen
app-instanssi nimellä `'aicoach'` (compat-SDK pyörii rinnalla). Globaali
`window.geminiGenerate(prompt)`. **Firebase AI Logic on jo kytketty päälle konsolissa
(Gemini Developer API). Jos AI-kutsut alkavat epäonnistua, tarkista konsolista
Build → AI Logic ja sallitut domainit.**

## Kuorma-välilehti (EWMA / ACWR) — js/charts.js

Trendit-rivin ali-välilehti `kuorma`. **Näkyy kaikille** (ei enää admin-only).
- `calcEwmaHistory(entries)`: ATL (λ=0.25, 7 pv) + CTL (λ=0.069, 28 pv) päivätasolla.
- `sessionLoadAU` = tehoaluekerroin (`ZONE_WEIGHTS`) tai lajikerroin
  (`SPORT_DEFAULT_WEIGHTS`) × kesto.
- ACWR = ATL/CTL. Vyöhykkeet: <0.8 sininen, 0.8–1.3 vihreä (optimi), 1.3–1.5 keltainen,
  >1.5 punainen. Gauge (SVG-kaari) + 12 vk kehitysgraafi (taustavyöhykkeet vaaleilla
  väreillä; pisteet värjätään ACWR-statuksen mukaan).
- ACWR-arvo leikataan piirrossa max 2.0 (tooltip näyttää oikean). Ensimmäiset ~28 pv
  (kunnes CTL tasaantuu) jätetään ACWR-graafista pois. Kuluva (kesken) viikko = katkoviiva.
- `renderKuormaTab()` on async ja hakee `fetchChartEntries()` jos `allChartEntries` tyhjä
  (tärkeää impersonoinnissa).

## Impersonointi (admin.js + entries.js)

- `impersonating = { uid, name, email, teams, profile }` (state.js), `null` = oma käyttäjä.
- **`getUserDoc()`** = AINA oma käyttäjä (profiilin kirjoitukset). **`getViewDoc()` /
  `getUserEntries()`** = katseltava (impersonoitu tai oma). **`viewUid()`** = katseltavan uid.
- `startImpersonation` / `stopImpersonation` nollaavat `allChartEntries=[]` ja kutsuvat
  `resetViewedProfileState()` (profile.js — nollaa `testit/maxSpeedTests/lihasTests/
  ennatyksetLoaded`) → ei vuoda toisen pelaajan dataa.
- Kirjoitukset estetty impersonoinnin aikana (entries.js `openModal` early-return).

## Tietoturva-huomiot

- **`escapeHtml` (utils.js) EI escapeta heittomerkkiä `'`** — älä koskaan upota
  käyttäjädataa inline `onclick="f('${data}')"` -kohtaan (JS-injektio). admin.js käyttää
  nyt **event delegationia** (`data-act` + `.dataset`, kuuntelijat pysyvissä containereissa)
  inline-handlereiden sijaan.
- Korjattu: impersonointi-cache-avaimet (viewUid), testidata-vuoto, `__all__`/`__ALL__`
  CSV-sentinel + "Kaikki"-vienti vain adminille.
- **Vielä avoinna (tiedoksi):** (a) feed-cache tallentaa privaatit/jakamattomat kommentit
  selkokielisenä localStorageen (joukkue.js); yksityisyyssuodatus vain UI-tasolla — myös
  Firestore-säännöt sallivat kaikkien lukea kaikki entryt. (b) Ei Firebase App Checkia.
  (c) ACWR-lukua ei leikata "Harjoituskuorma nyt" -kortissa harvalla datalla.

## CSS-sudenkuopat (opittua)

- **Spesifisyys + lähdejärjestys:** `.btn-secondary` (flex:1) ja `.form-group > label`
  (display:block) voittavat `.aicoach-run-btn` / `.team-checkbox-item` -säännöt jos
  spesifisyys on sama mutta ne tulevat myöhemmin. Käytä spesifimpää selektoria
  (esim. `.aicoach-header .aicoach-run-btn`, `.form-group > label.team-checkbox-item`).
- `.chart-subtitle` käyttää shorthand-marginaalia → ylikirjoita double-class-selektorilla.

## Service worker -päivitysmekanismi (uusittu)

Vanha auto-reload (`client.navigate`) **poistettu** — se aiheutti tuplasplashin.
Nykyinen malli (kontrolloitu päivitys):
- `sw.js` install **EI** kutsu `skipWaiting()` → uusi SW jää "waiting"-tilaan.
- `sw.js` kuuntelee `message`-eventtiä: `{type:'SKIP_WAITING'}` → `self.skipWaiting()`.
- `sw.js` activate: poistaa vanhat cachet + `clients.claim()`.
- index.html (inline SW-rekisteröinti):
  - Kun uusi worker on `installed` ja `controller` olemassa → näytä alareunan palkki
    **"Uusi versio saatavilla – Päivitä"** (`#update-banner`).
  - "Päivitä"-nappi → `reg.waiting.postMessage({type:'SKIP_WAITING'})`, asettaa
    `userTriggeredUpdate=true`.
  - `controllerchange` → `location.reload()` VAIN jos `userTriggeredUpdate` (ei
    ensiasennuksen claim-reloadia).
  - `visibilitychange` (sovellus näkyviin) → `reg.update()` (PWA huomaa uudet versiot).
- Palkin tyyli: `.update-banner` (tausta `--blue-deep`, valkoinen teksti, fixed bottom).
