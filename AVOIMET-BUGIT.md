# UWR Diary — Avoimet bugit

> Tilanne: deploy-v187 (tarkistettu koodista 2026-06-16).
> Rivinumerot `~`-merkillä voivat olla siirtyneet refaktoroinnissa — varmista grepillä.
> Korjatut bugit (v179–v187) eivät ole tässä listassa.

Vakavuusasteet: 🔴 Korkea · 🟠 Keski · 🟡 Matala

---

## 🔴 1. Tilinpoisto on rikki kolmella tavalla

**Sijainti:** `js/profile.js:1664–1680` (`delete-own-account-btn`) + `js/profile.js:441–479` (`deleteAllUserData`)

```js
// profile.js:1668-1670
const uid = currentUser.uid;
await deleteAllUserData(uid);   // ← tuhoaa KAIKEN datan
await currentUser.delete();     // ← voi heittää requires-recent-login
```

**Viat:**
1. **Väärä järjestys:** data poistetaan ennen `currentUser.delete()`-kutsua. Jos auth-poisto
   heittää `auth/requires-recent-login`, käyttäjälle sanotaan "kirjaudu uudelleen ja yritä"
   — mutta Firestore-data on jo lopullisesti tuhottu. Auth-tili jää, data on poissa.
2. **Orvot alikollektiot:** `deleteAllUserData` poistaa `entries`-alikollektion ja juuridokumentin,
   mutta EI `fitTests`-, `maxSpeedTests`- eikä `muscleTests`-alikollektioita (Firestore ei
   poista alikollektioita kaskadina). Testidata jää ikuisesti, ja `muscleTests` on
   sääntöjen mukaan kaikkien luettavissa.
3. **Batch kaatuu poistettuun entryyn:** rivi 462 tekee `batch.update(entryRef, { reactionCounts… })`
   jokaiselle `myReactions`-avaimelle. Jos käyttäjä reagoi aikoinaan entryyn jonka omistaja on
   sittemmin poistanut, `update()` olemattomaan dokumenttiin kaataa koko batchin → poisto
   keskeytyy pysyvästi puolivälissä.

**Korjaus:**
- Tee re-auth (tai `currentUser.delete()`) ENNEN datan poistoa, tai pyydä re-auth aina ensin.
- Poista myös `fitTests`/`maxSpeedTests`/`muscleTests` (ja omien entryjen `reactions`-alikollektiot).
- Reaktiosiivouksessa: käytä `set(..., {merge:true})` tai tarkista olemassaolo, tai siedä yksittäisen
  updaten epäonnistuminen (per-reaktio try/catch) ettei koko poisto kaadu.

---

## 🔴 2. Stored XSS testidatan kautta (impersonointinäkymä)

**Sijainti:** `js/profile.js:925–926`, `~1196`, `~1382`

```js
// profile.js:925-926
<button ... onclick="viewTestitById('${t.id}')">Näytä</button>
<button ... onclick="deleteTestitById('${t.id}', '${fmtDate(t.date)}')">Poista</button>
```

Doc-id ja kenttäarvot interpoloidaan raakana inline-`onclick`-attribuuttiin, eikä `escapeHtml`
muutenkaan escapeta heittomerkkiä `'` (ks. bugi 🟡 alla). Firestore-säännöt sallivat käyttäjän
luoda omaan `fitTests`/`maxSpeedTests`/`muscleTests`-kokoelmaansa dokumentteja mielivaltaisilla
id:illä ja kenttätyypeillä. Haitallinen pelaaja tallentaa dokumentin esim. id:llä
`'),alert(document.cookie),('` → kun admin impersonoi pelaajaa ja avaa Testit-välilehden,
skripti suoritetaan **adminin** sessiossa.

**Failure-skenaario:** pelaaja → admin-oikeuksien eskalointi impersonoinnin kautta.

**Korjaus:** vaihda event delegationiin (`data-act` + `dataset`), kuten `admin.js`:ssä jo tehtiin
inline-handlerien tilalle. Älä koskaan upota käyttäjädataa inline-`onclick`-attribuuttiin.

---

## 🔴 3. Duplikaattikirjaukset "Lataa lisää" + refetch

**Sijainti:** `js/entries.js:160` (ja `loadOlderPage` ~236–279)

`loadOlderPage` siirtää `pageWindowStart`-rajaa taaksepäin ja säilyttää vanhat dokumentit
`olderDocs`-taulukossa. Mikä tahansa seuraava `fetchEntries()` (↻-nappi, `visibilitychange`,
jokainen save/delete) laskee `inWindowDocs`:n levennetystä ikkunasta — joka nyt sisältää samat
viikot kuin `olderDocs` — ja kutsuu:

```js
renderPage(inWindowDocs, olderDocs);   // konkatenoi → samat entryt kahdesti
```

**Failure-skenaario:** Loki → "Lataa 2 viikkoa lisää" → taustoita sovellus ja palaa
(visibilitychange) → jokainen vanhempi treeni näkyy kahteen kertaan, viikkoyhteenvedot
tuplalaskevat minuutit, ja syntyy duplikaatti-DOM-id:t (`ereact-<id>`).

**Korjaus:** deduplikoi `renderPage`:ssa doc-id:n perusteella, TAI nollaa `olderDocs` ja
`pageWindowStart` ennen täyttä refetchiä, TAI laske live-ikkuna aina kiinteästä rajasta
(`weeksAgoMonday(PAGE_WEEKS)`) eikä siirretystä `pageWindowStart`:sta.

---

## 🟠 4. `entries_older_*`-cache on ikuinen eikä invalidoidu

**Sijainti:** `js/entries.js:236` (kirjoitus) vs save/delete-invalidointi (~1130, ~1180)

Vanhemmat sivut tallennetaan avaimella `'entries_older_' + ts`, mutta save/delete invalidoi vain
`'entries_' + pageWindowStart.getTime()` -avaimen (eri prefiksi). `Cache.get` ei myöskään katso
tallennettua `ts`-aikaleimaa (ei TTL:ää), eikä `Cache.clear()`-funktiota kutsuta missään.

**Failure-skenaario:** muokkaa tai poista yli 4 viikkoa vanha treeni (avattu lataa-lisää-näkymässä)
→ uudelleenlatauksen jälkeen "Lataa lisää" tarjoaa vanhentuneen cachen ikuisesti: poistettu treeni
herää henkiin, muokkaus ei näy.

**Korjaus:** lisää `entries_older_*`-avainten invalidointi save/delete-yhteyteen, TAI anna
`Cache.get`:lle TTL ja tarkista se.

---

## 🟠 5. `reactionCounts` ilman validointia (Firestore-säännöt)

**Sijainti:** `firestore.rules:33–34`

```
allow update: if request.auth != null
  && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['reactionCounts']);
```

Kuka tahansa kirjautunut voi kirjoittaa **minkä tahansa arvon** `reactionCounts`-kenttään — ei
tarkistusta että kyseessä on +1/-1 increment, ei-negatiivinen, tai oikea emoji. Yhdistettynä
client-puolen drift-mahdollisuuteen (vanha cache → tuplavähennys) laskurit voivat vääristyä tai
ne voidaan väärentää tahallaan.

**Korjaus:** tiukenna sääntöä tarkistamaan vain sallitut emoji-avaimet ja ±1 muutos, TAI siirry
laskemaan reaktiot `reactions`-alikokoelmasta (totuuden lähde) eikä denormalisoidusta laskurista.

> Liittyvä, sääntötasolla tiedossa (CLAUDE.md): kaikki entryt mukaan lukien `privateComment`
> ovat kaikkien kirjautuneiden luettavissa — yksityisyys on vain UI-suodatusta.

---

## 🟠 6. Ei Firebase App Checkia

**Sijainti:** koko Firebase-konfiguraatio (`js/config.js`, ei toteutusta)

Firestore-API on avoin mille tahansa clientille joka käyttää julkista web-configia (config on
aina näkyvissä selaimessa). Ilman App Checkia kuka tahansa voi ajaa sääntöjen sallimat luvut/
kirjoitukset suoraan SDK:lla ohi sovelluksen. Yhdistettynä avoimiin lukusääntöihin tämä
mahdollistaa esim. kaikkien käyttäjien entryjen massahaun.

**Korjaus:** ota App Check käyttöön (reCAPTCHA v3 / App Attest) ja pakota se Firestoressa.

---

## 🟡 Matalan prioriteetin bugit

| # | Bugi | Sijainti | Kuvaus & korjaus |
|---|---|---|---|
| 7 | **`escapeHtml` ei escapeta `'`** | `js/utils.js` | Escapaa vain `& < > "`. Lisää `.replace(/'/g, '&#39;')` → poistaa kokonaisen bugiluokan (mm. bugi 2 helpottuu). |
| 8 | **CSV-kaavainjektio** | `js/admin.js` (`downloadCsv`/`esc`) + profiilin oma vienti | Kommentti kuten `=HYPERLINK(...)` suoritetaan kaavana Excelissä. Prefiksoi `=+-@`-alkuiset solut heittomerkillä. |
| 9 | **fitTest auto-error-sääntöä ei toteutettu** | `js/profile.js` (~tallennus 1100-paikkeilla) | Spec: `error:true` automaattisesti jos `hr1==null && hr2==null`. Nyt vain checkbox. Myös `parseFloat(...) \|\| null` muuttaa laillisen `0`:n null:ksi. |
| 10 | **`compressImage` jumittuu** | `js/profile.js` (~414–434) | Vain `img.onload`, ei `onerror`. Dekoodaamaton kuva (esim. HEIC) jättää `await`in roikkumaan ikuisesti + object-URL vuotaa. Lisää `onerror`-reject + `URL.revokeObjectURL`. |
| 11 | **Henkilödata jää localStorageen** | `js/auth.js` (logout ~285) | Logout/tilinpoisto siivoaa vain splash+firstname. `uppis_records_*`, `uppis_jf2_*` (mm. privaatit kommentit), `uppis_aicoach_*` jäävät jaetulle laitteelle. Siivoa kaikki `uppis_*`-avaimet uloskirjautuessa. |
| 12 | **Reaktiolaskurin jäännösdrift** | `js/joukkue.js` (~334–344) | `inc(-1)`-guard estää negatiiviset, mutta vanhentunut *positiivinen* cache voi yhä ylivähentää. Lievä; admin-työkalu "Korjaa reaktiodata" paikkaa. |
| 13 | **`hasTime` UTC-fallback** | `js/entries.js` (~302), `js/joukkue.js` (~22) | `ts % 86400000 !== 0` testaa UTC-keskiyötä; Suomen paikallinen keskiyö ei ole 86,4M:n monikerta → legacy-entryt joilta puuttuu `hasTime` luokitellaan aina "ajallisiksi". |

---

## Riski- ja kompleksisuusarvio

**Riski** = todennäköisyys että korjaus rikkoo jotain / sen vaikutusala.
**Kompleksisuus** = työmäärä ja vaadittu ymmärrys. Eri akselit — moni matala-kompleksinen
korjaus on silti keskiriskinen koska koskee jaettua koodia tai dataa.

| # | Korjaus | Kompleksisuus | Riski | Keskeinen syy |
|---|---|---|---|---|
| 7 | `escapeHtml` escapaamaan `'` | Triviaali | 🟡 Matala-keski | Jaettu apufunktio kaikkialla → teoreettinen tuplaescape; testaa attribuuttinäkymät |
| 10 | `compressImage` onerror | Triviaali | 🟢 Matala | Eristetty, ei datavaikutusta |
| 8 | CSV-injektio | Matala | 🟢 Matala | Vain CSV-muotoilu |
| 9 | fitTest auto-error | Matala | 🟢 Matala | Eristetty; `0`→null-korjaus muuttaa tallennettua arvoa |
| 13 | `hasTime` UTC-fallback | Matala | 🟢 Matala | Vain legacy-entryt, kosmeettinen |
| 11 | localStorage-siivous logoutissa | Matala | 🟡 Matala-keski | Tarvitsee keep-listan (älä pyyhi `uppis_app_settings`) |
| 2 | Testidatan XSS → event delegation | Keski (3 paikkaa) | 🟡 Matala-keski | Puhdas refaktori, malli admin.js:ssä; helppo testata |
| 3 | Duplikaattikirjaukset | Matala-keski | 🟠 Keski | Sivutus-tilakone hienovarainen; dedup-by-id turvallisin |
| 4 | `entries_older_*`-cache | Matala | 🟠 Keski | **Älä** lisää TTL:ää globaaliin `Cache.get`:iin → kohdennettu prefix-invalidointi |
| 1 | Tilinpoisto (3 vikaa) | Keski | 🔴 Korkea | Tuhoava + peruuttamaton; vaikea testata turvallisesti |
| 5 | `reactionCounts`-säännöt | Keski | 🔴 Korkea | Sääntövirhe lukitsee reaktiot kaikilta; vaatii emulaattorin |
| 6 | Firebase App Check | Keski-korkea (infra) | 🔴 Korkea (operatiivinen) | Väärä konfig → koko app kaatuu kaikilta; vaiheittainen rollout |

### Poikkileikkaava rajoite: testattavuus

Projektissa ei ole automaattitestejä eikä Firestore-emulaattorisetuppia → regressiot huomaa vain
manuaalisesti tuotannossa. Tämä nostaa jokaisen korjauksen efektiivistä riskiä. Erityisesti:
bugi 1 vaatii heittotilit (älä testaa omalla), bugi 5 vaatii `firebase emulators` + rules-testit,
bugi 6 vaatii debug-tokenit + konsolin monitor-tilan ennen pakotusta.

### Riskiä alentavat arkkitehtuurivaihtoehdot

- **Bugi 1** → Cloud Function admin-SDK:n `recursiveDelete()`:llä: atominen, siivoaa alikollektiot
  automaattisesti, poistaa client-batchin hauraudet. Lisää 1. backend-funktion.
- **Bugi 5** → laske reaktiot `reactions`-alikokoelmasta: korjaa myös laskuridriftin (bugi 12) ja
  väärennyksen. Enemmän työtä kuin pelkkä sääntökiristys, mutta kaksi bugia kerralla.

## Riskikorjattu suositusjärjestys

1. **Halvat & turvalliset heti:** 7 → 10 → 8 → 9 (minimiriski; 7 tukee 2:ta).
2. **Eristetyt keskikorjaukset:** 2 (XSS-refaktori), 11 (keep-listalla), 3 (dedup-by-id).
3. **Vaativat testiympäristön:** 4 (kohdennettu invalidointi), 5 (emulaattori).
4. **Suuren vaikutusalan / tuhoavat — varovasti, testitilein/vaiheittain:** 1, 6.
