/**
 * UWR Diary — Google Sheets export relay (Apps Script Web App)
 * ------------------------------------------------------------
 * Ottaa vastaan treenidataa selaimesta (admin-portaali → Ylläpito → Sheets-vienti)
 * ja kirjoittaa sen Google Sheetiin. Kaikki pysyvä tila (kursorit, vaihe, vesileima)
 * elää piilotetussa `_state`-välilehdessä → app on tilaton klikkausten välillä.
 *
 * Välilehdet:
 *   Treenit  — yksi rivi per treeni (Avain = uid|entryId)
 *   Testit   — testitulokset (täysi korvaus joka ajolla)
 *   _state   — JSON-tila (piilotettu)
 *
 * KÄYTTÖÖNOTTO:
 *   1. Luo uusi Google Sheet. Extensions → Apps Script. Liitä tämä koodi.
 *   2. Aseta alla oleva SECRET samaksi kuin appin Ylläpito-välilehdellä.
 *   3. Deploy → New deployment → type: Web app.
 *        Execute as: Me.  Who has access: Anyone.
 *   4. Kopioi Web app URL appin asetuskenttään.
 *
 * TIETOTURVA: URL:iin liitetään jaettu salasana (secret). URL + secret annetaan
 * appiin vain kerran (tallennetaan selaimen localStorageen), EI julkiseen koodiin.
 */

var SECRET = 'VAIHDA-TÄMÄ-PITKÄKSI-SATUNNAISEKSI-MERKKIJONOKSI';

var TAB_TREENIT = 'Treenit';
var TAB_TESTIT  = 'Testit';
var TAB_STATE   = '_state';

var TREENIT_HEADERS = [
  'Avain', 'Pelaaja', 'Email', 'Päivämäärä', 'Aktiviteetti', 'Kesto (min)',
  'Tehoalue', 'Fiilis', 'Matka (km)', 'Keskisyke', 'Maksimisyke', 'Kommentti', 'Muokattu'
];
var TESTIT_HEADERS = ['Avain', 'Pelaaja', 'Email', 'Tyyppi', 'Päivämäärä', 'Tulos'];

var KEY_COL  = 1; // Avain sarake A
var DATE_COL = 4; // Päivämäärä sarake D (yyyy-mm-dd)

// ── HTTP-käsittelijät ─────────────────────────────────────────

function doGet(e) {
  if (!checkSecret_(e)) return json_({ error: 'unauthorized' });
  return json_({ ok: true, state: readState_() });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ error: 'bad json' }); }

  if (!body || body.secret !== SECRET) return json_({ error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var res = { ok: true };
    if (body.treenit && body.treenit.length)  res.upserted = upsertRows_(TAB_TREENIT, TREENIT_HEADERS, body.treenit);
    if (body.verifyWindows && body.verifyWindows.length) res.deleted = applyVerifyWindows_(body.verifyWindows);
    if (body.testit)  res.testit = replaceAll_(TAB_TESTIT, TESTIT_HEADERS, body.testit);
    if (body.state)   writeState_(body.state);
    return json_(res);
  } finally {
    lock.releaseLock();
  }
}

// ── Sheet-operaatiot ──────────────────────────────────────────

function upsertRows_(tabName, headers, rows) {
  var sheet = getOrCreateSheet_(tabName, headers);
  var last  = sheet.getLastRow();
  var keyMap = {}; // Avain → 1-pohjainen rivinumero
  if (last >= 2) {
    var keys = sheet.getRange(2, KEY_COL, last - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) keyMap[String(keys[i][0])] = i + 2;
  }
  var appends = [], updated = 0;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var key = String(row[0]);
    if (keyMap[key]) {
      sheet.getRange(keyMap[key], 1, 1, headers.length).setValues([row]);
      updated++;
    } else {
      appends.push(row);
    }
  }
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, headers.length).setValues(appends);
  }
  return { updated: updated, appended: appends.length };
}

// Poistaa Sheetistä rivit, jotka osuvat ikkunaan [start,end) mutta joita ei
// enää löydy Firestoresta (Avain ei ole lähetetyssä keys-listassa).
function applyVerifyWindows_(windows) {
  var sheet = getOrCreateSheet_(TAB_TREENIT, TREENIT_HEADERS);
  var last  = sheet.getLastRow();
  if (last < 2) return 0;
  var data = sheet.getRange(2, 1, last - 1, TREENIT_HEADERS.length).getValues();
  var toDelete = []; // 1-pohjaiset rivinumerot
  for (var w = 0; w < windows.length; w++) {
    var win  = windows[w];
    var keep = {};
    for (var k = 0; k < win.keys.length; k++) keep[String(win.keys[k])] = true;
    for (var i = 0; i < data.length; i++) {
      var d = String(data[i][DATE_COL - 1]); // yyyy-mm-dd
      if (d >= win.start && d < win.end) {
        var key = String(data[i][KEY_COL - 1]);
        if (!keep[key]) toDelete.push(i + 2);
      }
    }
  }
  // Poista alhaalta ylös ettei indeksit siirry
  toDelete.sort(function (a, b) { return b - a; });
  var seen = {};
  for (var j = 0; j < toDelete.length; j++) {
    var rowNum = toDelete[j];
    if (seen[rowNum]) continue;
    seen[rowNum] = true;
    sheet.deleteRow(rowNum);
  }
  return toDelete.length;
}

function replaceAll_(tabName, headers, rows) {
  var sheet = getOrCreateSheet_(tabName, headers);
  var last  = sheet.getLastRow();
  if (last >= 2) sheet.getRange(2, 1, last - 1, headers.length).clearContent();
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return rows.length;
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ── Tila (_state) ─────────────────────────────────────────────

function readState_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_STATE);
  if (!sheet) return null;
  var v = sheet.getRange('A1').getValue();
  if (!v) return null;
  try { return JSON.parse(v); } catch (err) { return null; }
}

function writeState_(state) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TAB_STATE);
  if (!sheet) { sheet = ss.insertSheet(TAB_STATE); sheet.hideSheet(); }
  sheet.getRange('A1').setValue(JSON.stringify(state));
}

// ── Apurit ────────────────────────────────────────────────────

function checkSecret_(e) {
  return e && e.parameter && e.parameter.secret === SECRET;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
