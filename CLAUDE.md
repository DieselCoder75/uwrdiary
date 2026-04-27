# UWR Diary — Claude muistio

Tämä tiedosto luetaan automaattisesti jokaisessa Claude Code -sessiossa.

## Projekti lyhyesti

**UWR Diary** on uppopalloilijoiden harjoituspäiväkirja-PWA.  
- URL: https://uwrdiary.web.app  
- Firebase project: `uwrdiary`  
- Admin: `janne.lind@gmail.com`  
- Toinen käyttäjä: `katja.lind@gmail.com`

## Teknologiat

- **Frontend**: Vanilla HTML/CSS/JS, ei frameworkia
- **Backend**: Firebase Firestore + Firebase Auth (compat SDK v10.7.1, CDN)
- **Hosting**: Firebase Hosting
- **PWA**: Service Worker (`sw.js`), manifest.json, apple-touch-icon

## Tiedostorakenne

```
index.html          — koko UI (auth + app + modaalit)
styles.css          — kaikki tyylit
sw.js               — service worker (cache: uwr-diary-v17)
manifest.json
js/
  config.js         — Firebase config, vakiot (PERF_COLORS, TEAMS, jne.)
  state.js          — globaalit muuttujat (currentUser, userProfile, jne.)
  cache.js          — Cache-apuluokka (localStorage)
  utils.js          — apufunktiot (el, show, hide, toast, confirm, jne.)
  auth.js           — kirjautuminen / rekisteröinti
  entries.js        — treenikirjaukset (CRUD, bottom sheet, lajivalinta)
  charts.js         — Chart.js-kaaviot (Trendit: Omat + Vertailu)
  joukkue.js        — joukkuefeed, reaktiot
  profile.js        — profiili, salasananvaihto, tilin poisto
  admin.js          — hallintapaneeli (admin-only)
  app.js            — navigointi, tab-logiikka, swipe
```

## Versiot index.html:ssä (päivitä aina muuttaessa)

```html
styles.css?v=218
config.js?v=6
state.js?v=2
cache.js?v=2
utils.js?v=3
auth.js?v=3
entries.js?v=6
charts.js?v=6
profile.js?v=8
joukkue.js?v=7
admin.js?v=12
app.js?v=9
```

Service worker cache: `CACHE_NAME = 'uwr-diary-v19'` (sw.js rivi 4)

## Design-järjestelmä

### Värit (CSS custom properties, styles.css)

| Muuttuja | Käyttö |
|---|---|
| `--blue` / `--blue-dark` | Pääväri, primary-napit |
| `--bg` | Taustaväri |
| `--white` | Kortit, modaalit |
| `--text` | Pääteksti |
| `--text-muted` | Toissijainen teksti |
| `--border-light` | Reunaviivat |
| `--green` / `--red` | Onnistuminen / virhe |

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
  profile: { nickname, firstName, lastName, gender, birthday, teams[], photoURL,
             shareActivities, shareComments }
  myReactions: { "ownerUid_entryId": emoji }   ← käyttäjän omat reaktiot
  /entries/{entryId}
    type, duration, date (Timestamp), performance (1-5), feeling (1-5),
    distance, avgHr, maxHr, comment, hasTime, updatedAt
    reactionCounts: { "🔥": 2, "💪": 1 }
    /reactions/{reactorUid}
      emoji, timestamp
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
