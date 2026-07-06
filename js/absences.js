// ============================================================
// POISSAOLOT — toinen kirjaustyyppi (sairas / loukkaantunut / …)
// ============================================================
// Oma alikollektio users/{uid}/absences. YKSITYINEN — ei näy feedissä, ei laske
// kuormaan/ennätyksiin (eri kokoelma kuin entries). Aikaväli tallennetaan
// PER-PÄIVÄ-dokumentteina, jaettu periodId koko jaksolle → ikkunakyselyt
// triviaaleja, muokkaus/poisto batch:lla periodId:n perusteella.

let allAbsenceDays      = []; // [{id, date:Date, periodId, type, comment}] katseltavalle uidille
let absencesLoadedForUid = null;
let _absenceType        = '';   // valittu syy modaalissa
let _absenceEditPeriodId = null; // editoitavan jakson periodId, null = uusi

// Katseltava (impersonointi-tietoinen) vs. oma (kirjoitukset aina omaan)
function getViewAbsences() { return getViewDoc().collection('absences'); }
function getOwnAbsences()  { return getUserDoc().collection('absences'); }

function absenceDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function _absFmtDay(d) { return `${d.getDate()}.${d.getMonth() + 1}.`; }

// Kuluvan (ISO-)viikon sunnuntai — alkupäivän yläraja
function _absThisWeekSundayStr() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const day = d.getDay() || 7;        // 1=ma … 7=su
  d.setDate(d.getDate() + (7 - day)); // tämän viikon sunnuntai
  return timestampToDateStr(d);
}
const ABSENCE_MAX_DAYS = 14; // enintään 2 viikkoa

// Rajaa loppupäivän valitsin alkupäivän mukaan (min = alku, max = alku + 2 vko).
// resetToStart: nollaa loppupäivä alkupäiväksi (kun käyttäjä vaihtaa alkua).
function _absUpdateEndBounds(resetToStart) {
  const startStr = el('absence-start').value;
  const end = el('absence-end');
  if (!startStr) return;
  const maxD = new Date(`${startStr}T00:00:00`);
  maxD.setDate(maxD.getDate() + ABSENCE_MAX_DAYS - 1); // 14 pv mukaan lukien alku
  const maxStr = timestampToDateStr(maxD);
  end.min = startStr;
  end.max = maxStr;
  if (resetToStart || !end.value || end.value < startStr || end.value > maxStr) {
    end.value = startStr;
  }
}

// ── Lataus (kaikki katseltavan käyttäjän poissaolot; harvoja → yksi kysely) ──
async function loadAbsences(force = false) {
  if (!currentUser) return;
  const uid = impersonating ? impersonating.uid : currentUser.uid;
  if (!force && absencesLoadedForUid === uid) return;
  try {
    const snap = await getViewAbsences().orderBy('date', 'asc').get();
    allAbsenceDays = snap.docs.map(doc => {
      const x = doc.data();
      return {
        id:       doc.id,
        date:     x.date?.toDate ? x.date.toDate() : new Date(x.date),
        periodId: x.periodId,
        type:     x.type,
        comment:  x.comment || '',
      };
    });
    absencesLoadedForUid = uid;
  } catch (err) {
    console.error('loadAbsences:', err);
    // Merkitse yritys tehdyksi myös virheessä → estää ensureAbsencesForLoki:n
    // äärettömän uudelleenyrityssilmukan pysyvän virheen (esim. säännöt) sattuessa.
    absencesLoadedForUid = uid;
  }
}

function resetAbsenceState() {
  allAbsenceDays = [];
  absencesLoadedForUid = null;
}

// ── Kartat näkymille ──────────────────────────────────────────
// Kalenteri: dateKey → { type, comment, periodId }
function buildAbsenceDayMap() {
  const map = {};
  allAbsenceDays.forEach(a => { map[absenceDateKey(a.date)] = a; });
  return map;
}

// Onko jakso meneillään juuri nyt? (AI Coach / nykytila)
function isAbsentToday() {
  const k = absenceDateKey(new Date());
  return allAbsenceDays.some(a => absenceDateKey(a.date) === k);
}

// Viikon (maanantai-ms) poissaolot jaksoittain → [{periodId, type, comment, dates[]}]
function absencesForWeek(mondayMs) {
  const monday = new Date(mondayMs);
  const sunday = new Date(mondayMs + 7 * 24 * 60 * 60 * 1000);
  const byPeriod = new Map();
  allAbsenceDays.forEach(a => {
    if (a.date < monday || a.date >= sunday) return;
    if (!byPeriod.has(a.periodId)) {
      byPeriod.set(a.periodId, { periodId: a.periodId, type: a.type, comment: a.comment, dates: [] });
    }
    byPeriod.get(a.periodId).dates.push(a.date);
  });
  return [...byPeriod.values()];
}

// Onko näkyvällä lokijaksolla (mondayMs >= lowerMs) poissaoloviikkoja?
function absenceWeekMondays(lowerMs, upperMsExclusive) {
  const set = new Set();
  allAbsenceDays.forEach(a => {
    const mon = weekMondayOf(a.date).getTime();
    if (mon >= lowerMs && mon < upperMsExclusive) set.add(mon);
  });
  return set;
}

// Viikkotiilen footer-HTML — näytetään VAIN jos viikolla on poissaoloja
function absenceFooterHtml(mondayMs) {
  const periods = absencesForWeek(mondayMs);
  if (!periods.length) return '';
  const rows = periods.map(p => {
    const days  = p.dates.slice().sort((a, b) => a - b);
    const range = days.length === 1
      ? _absFmtDay(days[0])
      : `${_absFmtDay(days[0])}–${_absFmtDay(days[days.length - 1])}`;
    const emoji = ABSENCE_TYPE_EMOJI[p.type] || '🚫';
    const label = ABSENCE_TYPE_LABEL[p.type] || p.type;
    const commentHtml = p.comment
      ? `<span class="wsc-absence-comment">${escapeHtml(p.comment)}</span>` : '';
    const editable = impersonating ? '' : ' wsc-absence-row--editable';
    const tag = impersonating ? 'div' : 'button';
    const typeAttr = impersonating ? '' : ` type="button"`;
    return `<${tag}${typeAttr} class="wsc-absence-row${editable}" data-absence-period="${escapeHtml(p.periodId)}">
      <span class="wsc-absence-main">${emoji} ${escapeHtml(label)} · ${range} (${days.length} pv)</span>
      ${commentHtml}
    </${tag}>`;
  }).join('');
  return `<div class="wsc-absences">${rows}</div>`;
}

// ── Modaali: tyyppinapit + lomake ─────────────────────────────
function renderAbsenceTypeBtns() {
  const c = el('absence-type-btns');
  if (!c) return;
  c.innerHTML = ABSENCE_TYPES.map(t =>
    `<button type="button" class="absence-type-btn${t.value === _absenceType ? ' active' : ''}" data-abs-type="${t.value}">
       <span class="absence-type-emoji">${t.emoji}</span><span>${escapeHtml(t.label)}</span>
     </button>`).join('');
}

function updateAbsenceCounter() {
  const el2 = el('absence-char-count');
  if (el2) el2.textContent = el('absence-comment').value.length;
}

function prepAbsenceForm(prefill = null) {
  _absenceEditPeriodId = prefill?.periodId || null;
  const today = timestampToDateStr(new Date());
  el('absence-start').value = prefill?.start || today;
  el('absence-end').value   = prefill?.end   || today;
  el('absence-start').max   = _absThisWeekSundayStr(); // alku ≤ kuluvan viikon su
  _absUpdateEndBounds(false); // aseta loppupäivän rajat (älä nollaa prefill-arvoa)
  _absenceType = prefill?.type || '';
  renderAbsenceTypeBtns();
  el('absence-comment').value = prefill?.comment || '';
  updateAbsenceCounter();
  el('absence-delete-btn').classList.toggle('hidden', !prefill?.periodId);
  el('modal-title').textContent = prefill?.periodId ? 'Muokkaa poissaoloa' : 'Uusi poissaolo';
}

// Vaihda modaali Poissaolo-näkymään (tab-klikkaus tai editointi)
function showAbsenceTab(prefill = null) {
  el('entry-form').classList.add('hidden');
  el('absence-form').classList.remove('hidden');
  document.querySelectorAll('.entry-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.entryTab === 'poissaolo'));
  prepAbsenceForm(prefill);
}

// Vaihda takaisin Treeni-näkymään (tyhjälle lomakkeelle)
function showTreeniTab() {
  el('absence-form').classList.add('hidden');
  el('entry-form').classList.remove('hidden');
  document.querySelectorAll('.entry-tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.entryTab === 'treeni'));
  el('modal-title').textContent = currentEntryId ? 'Muokkaa treeniä' : 'Uusi Treeni';
}

// Avaa modaali olemassa olevan jakson muokkaukseen (footer-klikkaus)
function openAbsenceModal(periodId) {
  if (impersonating) return; // luku-tila
  const days = allAbsenceDays.filter(a => a.periodId === periodId).sort((a, b) => a.date - b.date);
  if (!days.length) return;
  el('entry-tab-nav').classList.add('hidden'); // editoidessa ei tab-vaihtoa
  el('entry-modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  showAbsenceTab({
    periodId,
    start:   timestampToDateStr(days[0].date),
    end:     timestampToDateStr(days[days.length - 1].date),
    type:    days[0].type,
    comment: days[0].comment,
  });
}

// Päivitä poissaoloista riippuvat näkymät tallennuksen/poiston jälkeen
function refreshAbsenceViews() {
  if (typeof loadEntries === 'function') loadEntries();           // loki + viikkofooterit
  const calVisible = !el('subtab-kalenteri')?.classList.contains('hidden');
  if (calVisible && typeof renderCalendarTab === 'function') {
    calLoadedForUid = null;
    renderCalendarTab();
  }
}

// ── Tallennus ─────────────────────────────────────────────────
async function saveAbsence() {
  if (impersonating) return;
  const startStr = el('absence-start').value;
  const endStr   = el('absence-end').value;
  if (!startStr || !endStr) { toast('Valitse ajanjakso.', 'error'); return; }
  if (endStr < startStr)    { toast('Loppupäivä ei voi olla ennen alkupäivää.', 'error'); return; }
  if (startStr > _absThisWeekSundayStr()) {
    toast('Alkupäivä voi olla korkeintaan kuluvan viikon sunnuntai.', 'error'); return;
  }
  if (!_absenceType)        { toast('Valitse poissaolon syy.', 'error'); return; }

  // Rakenna päivälista (alku–loppu, molemmat mukaan)
  const days = [];
  for (let d = new Date(`${startStr}T00:00:00`); timestampToDateStr(d) <= endStr; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
    if (days.length > ABSENCE_MAX_DAYS + 1) break;
  }
  if (days.length > ABSENCE_MAX_DAYS) {
    toast('Poissaolo voi olla enintään 2 viikkoa (14 päivää).', 'error'); return;
  }
  const comment = el('absence-comment').value.trim();

  const btn = el('absence-save-btn');
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Tallennetaan…'; }
  try {
    const col   = getOwnAbsences();
    const batch = db.batch();
    // Editoidessa: poista jakson vanhat päivädokumentit ensin
    if (_absenceEditPeriodId) {
      const old = await col.where('periodId', '==', _absenceEditPeriodId).get();
      old.forEach(doc => batch.delete(doc.ref));
    }
    const periodId = _absenceEditPeriodId || col.doc().id;
    days.forEach(d => {
      const ref = col.doc();
      batch.set(ref, {
        date:      firebase.firestore.Timestamp.fromDate(new Date(`${timestampToDateStr(d)}T00:00:00`)),
        periodId,
        type:      _absenceType,
        comment,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    await loadAbsences(true);
    invalidateCalendarCache();
    closeModal();
    refreshAbsenceViews();
    haptic('success');
    toast(_absenceEditPeriodId ? 'Poissaolo päivitetty.' : 'Poissaolo tallennettu.', 'success');
  } catch (err) {
    console.error('saveAbsence:', err);
    toast('Tallennus epäonnistui. Yritä uudelleen.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Tallenna'; }
  }
}

// ── Poisto ────────────────────────────────────────────────────
async function deleteAbsence() {
  if (impersonating || !_absenceEditPeriodId) return;
  const yes = await confirm('Poistetaanko tämä poissaolo? Toimintoa ei voi peruuttaa.');
  if (!yes) return;
  const btn = el('absence-delete-btn');
  if (btn?.disabled) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Poistetaan…'; }
  try {
    const col = getOwnAbsences();
    const snap = await col.where('periodId', '==', _absenceEditPeriodId).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    await loadAbsences(true);
    invalidateCalendarCache();
    closeModal();
    refreshAbsenceViews();
    haptic('medium');
    toast('Poissaolo poistettu.', 'success');
  } catch (err) {
    console.error('deleteAbsence:', err);
    toast('Poisto epäonnistui.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Poista'; }
  }
}

// ── Kiinnitykset (kerran sivun latauksessa) ───────────────────
document.querySelectorAll('.entry-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.entryTab === 'poissaolo') showAbsenceTab(null);
    else showTreeniTab();
  });
});

el('absence-type-btns')?.addEventListener('click', e => {
  const b = e.target.closest('[data-abs-type]');
  if (!b) return;
  _absenceType = b.dataset.absType;
  renderAbsenceTypeBtns();
});

el('absence-start')?.addEventListener('change', () => _absUpdateEndBounds(true));
el('absence-comment')?.addEventListener('input', updateAbsenceCounter);
el('absence-form')?.addEventListener('submit', e => { e.preventDefault(); saveAbsence(); });
el('absence-delete-btn')?.addEventListener('click', deleteAbsence);

// Viikkotiilen footer-klikkaus → muokkaa (event delegation pysyvissä containereissa)
['entries-list', 'week-summary-card'].forEach(id => {
  const c = el(id);
  if (c) c.addEventListener('click', e => {
    const b = e.target.closest('[data-absence-period]');
    if (b && c.contains(b)) openAbsenceModal(b.dataset.absencePeriod);
  });
});
