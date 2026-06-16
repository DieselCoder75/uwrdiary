# UWR Diary — Kehitysaihiot

> Tilanne: deploy-v187 (2026-06-16). Ehdotuksia käyttökokemuksen, sitoutumisen,
> suorituskyvyn ja koodin laadun parantamiseksi. Erillään puhtaista bugeista
> (ks. `AVOIMET-BUGIT.md`).

Työmääräarviot suhteessa olemassa olevaan arkkitehtuuriin (vanilla JS + Firestore + PWA).

---

## A. Uudet ominaisuudet (sitoutuminen & adoptio)

### A1. 🔔 Push-notifikaatiot (FCM / Web Push) — suurin retentiovipu
PWA-pohja on jo olemassa (iOS tukee web pushia kotinäytölle asennetuille). Datasta saa heti
mielekkäät triggerit:
- "🔥 Katja reagoi treeniisi" (reaktiot jo Firestoressa)
- Viikkoyhteenveto su: "4 treeniä, 320 min, ACWR 1.1 ✅" (luvut lasketaan jo)
- Lempeä muistutus jos viikko jäämässä tyhjäksi vs. viikkosuunnitelma

**Työmäärä:** Keski — vaatii ensimmäisen Cloud Functionin (backend) + FCM-tokenien tallennuksen.
**Edellytys:** sopii tehtäväksi yhdessä bugi-1:n Cloud Functionin kanssa (sama infra).

### A2. ⚡ Pikakirjaus / treenipohjat — pienin kitka, joka käyttökerta
Kirjaamiskitka tappaa treenipäiväkirjat. Uppopalloharkat toistuvat viikoittain (ti 90 min,
tehoalue III), ja viikkosuunnitelma + kalenteri tietävät jo päivän suunnitellun tehoalueen.
Yksi nappi: "Kirjaa tämän päivän harkat" esitäytettynä → käyttäjä säätää vain fiiliksen.
**Työmäärä:** Pieni. FAB:n long-press tai bottom sheetin yläosa.

### A3. 💬 Kommentit joukkuefeediin — sosiaalinen liima
Emoji-reaktiot ovat jo olemassa; keskustelu treenien alla tuo ihmiset takaisin ilman
muistutuksia. Arkkitehtuuri = reaktioiden kopio: `entries/{id}/comments/{uid_ts}` -alikokoelma +
`commentCount`-kenttä.
**Työmäärä:** Pieni-keski. **Huom:** muista `escapeHtml` (myös `'`) kommenttien renderöinnissä.

### A4. 🏊 Valmentajan läsnäolokirjaus — koko joukkueen data kerralla
Valmentaja merkitsee harkkojen jälkeen ketkä olivat paikalla → sovellus luo pelaajille valmiin
entryn jonka he vain kuittaavat/täydentävät fiiliksellä. 1 kirjaus → 15 pelaajan data, ja
valmentajalle syy avata appi joka harkan jälkeen. Admin-paneeli + joukkuerakenne tukevat jo.
**Työmäärä:** Keski.

### A5. 🏅 Saavutusmerkit & striikit — motivaatio, data jo valmiina
`records`-aggregaatti (juuri korjattu) sisältää viikkodatat, kokonaismäärät ja ennätykset →
merkit ("100. treeni", "ennätysviikko") ja striikki (peräkkäiset viikot joina viikkotavoite
täyttyi) ovat lähinnä renderöintiä, **0 lisälukua**. Striikki on koukuttavin yksittäinen
mekaniikka. Näkyviin splash-tervehdykseen + viikkoyhteenvetokorttiin.
**Työmäärä:** Pieni.

### A6. 📈 Testitrendit — viiva ylöspäin motivoi
10×100m- ja maksiminopeustestien data on jo Firestoressa, mutta kehitys yli ajan ei piirry
mihinkään. Chart.js on jo käytössä.
**Työmäärä:** Pieni.

### A7. 🎯 Joukkuehaaste (opt-in)
Esim. "joukkueen yhteiset 5 000 min marraskuussa" yhteisellä edistymispalkilla feedin yläosassa.
Yhteistavoite välttää yksilövertailun ikävät puolet mutta luo sosiaalista painetta.
**Työmäärä:** Keski.

### A8. ⌚ Sykedatan tuonti tiedostosta (.FIT/.TCX)
Tiedoston pudotus entryyn täyttäisi kesto/syke/matka automaattisesti (Garmin/Polar-export).
Onnistuu puhtaasti selaimessa ilman backendia. **Täysi** Garmin/Apple Health -integraatio
vaatisi OAuth-palvelimen — älä aloita siitä.
**Työmäärä:** Pieni (tiedostotuonti) / Suuri (live-integraatio).

### A9. 🌙 Tumma tila
`PERF_COLORS_DARK` on jo config.js:ssä ja koko paletti CSS-muuttujissa → pohjatyö puoliksi tehty.
Usein toivotuin "pikkuominaisuus".
**Työmäärä:** Pieni-keski.

---

## B. Suorituskyky & kustannusoptimoinnit (Firebase-luvut = suora kulu)

### B1. Admin `recentCount` → `count()`-aggregaatti
**Sijainti:** `js/admin.js:~53`. Hakee nyt jokaisen entry-dokumentin 4 viikolta jokaiselle
käyttäjälle pelkkää `es.size`:ä varten (~300 lukua/miss). Compat-SDK tukee `query.count().get()`
→ ~20 lukua, sama UI. **~95 % halvempi.** Pieni, turvallinen diff.

### B2. Älä refetchaa koko Loki-ikkunaa muokkauksen jälkeen
**Sijainti:** `js/entries.js`. Joka save/delete tekee täyden ikkunan `.get()`:n, ja
fingerprint-vertailu tapahtuu vasta luvun jälkeen. Mutatoi `allEntries` paikallisesti
kirjoitetusta datasta. Rakenteellisempi vaihtoehto: live-ikkuna `onSnapshot`-kuunteluun
(persistence jo päällä, `unsubEntries`-putki on jo `state.js`:ssä) → vain muuttuneet dokumentit
laskutetaan.

### B3. Vertailu-ikkuna 24 → 12 vk
**Sijainti:** `js/charts.js:~281`. Omat kaaviot käyttävät vain 12 vk, mutta vertailu hakee 24 vk ×
jokainen joukkuelainen. Puolittaa raskaimman toistuvan monen käyttäjän kyselyn.

### B4. Joukkuefeedin TTL 45 min → 2–3 h
**Sijainti:** `js/config.js:38` (`JOUKKUE_CACHE_TTL`). ↻-nappi on jo pakkopäivitykseen, joten
UX-kustannus on lähes nolla.

---

## C. Koodin laatu & ylläpidettävyys

### C1. Yksikkötestit puhtaille funktioille — alentaa KAIKEN muun riskiä
Projektissa ei ole yhtään testiä. Aikavyöhyke-/off-by-one-herkät puhtaat funktiot
(`recordsWeekKey`, `calcEwmaHistory`, `buildRecordsUpdate`, `sessionLoadAU`, `recordsReady`)
pitäisi testata. Regressioita ei nyt huomaa mitenkään ennen tuotantoa.
**Bonus:** Firestore-emulaattori + rules-testit tekisivät sääntömuutoksista (bugi 5) turvallisia.

### C2. `escapeHtml` escapaamaan myös `'`
**Sijainti:** `js/utils.js`. Yhden rivin lisäys (`.replace(/'/g, '&#39;')`) poistaa kokonaisen
bugiluokan ja suojaa tulevia kehittäjiä. (Listattu myös bugina, mutta kuuluu tänne laatuna.)

### C3. Sovelluksen versionumero yhteen paikkaan
Nyt kovakoodattu kahteen tiedostoon (`auth.js` splash + `profile.js` help-version) → pääsee
eriytymään. Siirrä yhteen vakioon `config.js`:ään.

### C4. `confirm()`-apufunktion siivous
**Sijainti:** `js/utils.js:~61–115`. Varjostaa globaalin `window.confirm`:n, ja kuuntelijat
kasaantuvat rinnakkaisissa dialogeissa (yksi klikkaus ratkaisee kaikki pending-promiset).
Anna oma nimi + siivoa/uusi kuuntelijat per kutsu.

### C5. `deploy.sh`: `git pull --rebase` ennen pushia
Lokaali deploy pushaa suoraan mainiin `--force-with-lease`:lla. Jos haaramuutoksia mergetään
GitHubissa, lokaali main ajautuu jälkeen ja seuraava deploy kaatuu (tai pahimmillaan
ylikirjoittaa). Lisää `git pull --rebase origin main` ennen committia.

---

## Priorisoitu tiekartta

| Vaihe | Aihiot | Perustelu |
|---|---|---|
| 1. Nopeat voitot | A2 (pikakirjaus), A5 (merkit/striikit), B1 (count), C2 (escape) | Pieni työ, iso vaikutus, ei uutta infraa |
| 2. Sosiaalinen sitoutuminen | A3 (kommentit), A6 (testitrendit), B2/B3/B4 (luvut) | Tuo käyttäjät takaisin; halpaa olemassa olevan päälle |
| 3. Ensimmäinen backend | A1 (push), A4 (läsnäolo) | Vaatii Cloud Functionin — tee yhdessä bugi-1:n recursiveDelete-funktion kanssa |
| 4. Perustus | C1 (testit), C5 (deploy-pull) | Alentaa kaiken muun riskiä |
| 5. Kun aikaa | A7 (haaste), A8 (FIT-tuonti), A9 (tumma tila) | Mukava lisä, ei kriittinen |

**Mistä aloittaisin:** A2 + A3. Ne eivät vaadi uutta infraa ja osuvat adoption kahteen
ydinkysymykseen — "jaksanko kirjata" ja "onko täällä muita". Push (A1) heti perään, koska
kommentit/reaktiot ilman ilmoituksia jäävät puoliteholle.
