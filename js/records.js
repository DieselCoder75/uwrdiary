// ============================================================
// RECORDS — käyttäjän aggregaatti-statistiikat
// ============================================================
// users/{uid}.records = {
//   bootstrapped: true,
//   totalEntries:  number,
//   totalMinutes:  number,
//   firstEntryDate: Timestamp | null,
//   longestEntry:   { duration, date (Timestamp), type } | null,
//   weeks: {
//     "2025-W23": { sessions, minutes, uppoMinutes }
//   }
// }
//
// Saavutukset-välilehti lukee tämän kentän → 0 entry-readia.
// Päivitetään inkrementaalisesti save/edit/delete -operaatioissa.
//
// Backwards-compat: jos `records.bootstrapped !== true`, käytetään vanhaa
// polkua (lue kaikki entryt). Tämä mahdollistaa migraation osittaisen ajon
// ilman vaikutusta käyttäjäkokemukseen.
// ============================================================

// ── ISO-viikkoavain ──────────────────────────────────────────
function recordsWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ── Onko records bootstrapattu tälle käyttäjälle? ────────────
function recordsReady() {
  return userProfile?.records?.bootstrapped === true;
}

// ── Apuri: poimi entrystä vain ne kentät joita aggregaatit tarvitsevat ─
function _entrySnap(data) {
  const date = data.date?.toDate ? data.date.toDate() : new Date(data.date);
  return {
    duration: Number(data.duration) || 0,
    type:     data.type || '',
    date,
    weekKey:  recordsWeekKey(date),
    isUppo:   data.type === 'Uppopallo',
  };
}

// ── Päivittää records-kentän inkrementaalisesti ─────────────
// op: 'add' | 'remove' | 'edit'  (edit = remove old + add new)
// Palauttaa update-objektin jonka voi liittää batchiin TAI päivittää myös
// paikallinen userProfile.records vastaavasti.
//
// HUOM: kutsu vain jos recordsReady() === true.
//
async function buildRecordsUpdate(op, oldData, newData) {
  if (!recordsReady()) return null;

  const r = userProfile.records;
  const updates = {};
  const FV = firebase.firestore.FieldValue;
  // Accumulate per-weekKey deltas so same-week edit doesn't overwrite FV.increment calls
  const weekDeltas = {};

  function applyDelta(weekKey, dSessions, dMinutes, dUppoMinutes) {
    if (!r.weeks) r.weeks = {};
    if (!r.weeks[weekKey]) r.weeks[weekKey] = { sessions: 0, minutes: 0, uppoMinutes: 0 };
    r.weeks[weekKey].sessions    += dSessions;
    r.weeks[weekKey].minutes     += dMinutes;
    r.weeks[weekKey].uppoMinutes += dUppoMinutes;
    if (!weekDeltas[weekKey]) weekDeltas[weekKey] = { sessions: 0, minutes: 0, uppoMinutes: 0 };
    weekDeltas[weekKey].sessions    += dSessions;
    weekDeltas[weekKey].minutes     += dMinutes;
    weekDeltas[weekKey].uppoMinutes += dUppoMinutes;
  }

  // ─── Add ────────────────────────────────────────────────
  if (op === 'add' || op === 'edit') {
    const e = _entrySnap(newData);
    if (op === 'add') {
      updates['records.totalEntries'] = FV.increment(1);
      updates['records.totalMinutes'] = FV.increment(e.duration);
      r.totalEntries = (r.totalEntries || 0) + 1;
      r.totalMinutes = (r.totalMinutes || 0) + e.duration;
      if (!r.firstEntryDate || e.date < (r.firstEntryDate.toDate ? r.firstEntryDate.toDate() : new Date(r.firstEntryDate))) {
        const ts = firebase.firestore.Timestamp.fromDate(e.date);
        updates['records.firstEntryDate'] = ts;
        r.firstEntryDate = ts;
      }
      if (!r.longestEntry || e.duration > r.longestEntry.duration) {
        const longest = { duration: e.duration, date: firebase.firestore.Timestamp.fromDate(e.date), type: e.type };
        updates['records.longestEntry'] = longest;
        r.longestEntry = longest;
      }
    }
    applyDelta(e.weekKey, 1, e.duration, e.isUppo ? e.duration : 0);
  }

  // ─── Remove (myös editissä, vanhan poisto) ──────────────
  if (op === 'remove' || op === 'edit') {
    const e = _entrySnap(oldData);
    if (op === 'remove') {
      updates['records.totalEntries'] = FV.increment(-1);
      updates['records.totalMinutes'] = FV.increment(-e.duration);
      r.totalEntries = Math.max(0, (r.totalEntries || 0) - 1);
      r.totalMinutes = Math.max(0, (r.totalMinutes || 0) - e.duration);
    }
    applyDelta(e.weekKey, -1, -e.duration, e.isUppo ? -e.duration : 0);
    if (op === 'remove' && r.longestEntry &&
        r.longestEntry.duration === e.duration &&
        sameDay(r.longestEntry.date, e.date) &&
        r.longestEntry.type === e.type) {
      updates._needsLongestRescan = true;
    }
    if (op === 'remove' && r.firstEntryDate && sameDay(r.firstEntryDate, e.date)) {
      updates._needsFirstRescan = true;
    }
  }

  // ─── Edit: totalMinutes, longestEntry, firstEntryDate ───
  if (op === 'edit') {
    const newE = _entrySnap(newData);
    const oldE = _entrySnap(oldData);

    const dMin = newE.duration - oldE.duration;
    if (dMin !== 0) {
      updates['records.totalMinutes'] = FV.increment(dMin);
      r.totalMinutes = Math.max(0, (r.totalMinutes || 0) + dMin);
    }

    if (newE.duration >= (r.longestEntry?.duration || 0)) {
      const longest = { duration: newE.duration, date: firebase.firestore.Timestamp.fromDate(newE.date), type: newE.type };
      updates['records.longestEntry'] = longest;
      r.longestEntry = longest;
    } else if (r.longestEntry &&
               r.longestEntry.duration === oldE.duration &&
               sameDay(r.longestEntry.date, oldE.date) &&
               r.longestEntry.type === oldE.type) {
      updates._needsLongestRescan = true;
    }

    const newTime = newE.date.getTime();
    const oldTime = oldE.date.getTime();
    if (newTime !== oldTime) {
      const curFirst = r.firstEntryDate?.toDate ? r.firstEntryDate.toDate().getTime() : null;
      if (curFirst === null || newTime < curFirst) {
        const ts = firebase.firestore.Timestamp.fromDate(newE.date);
        updates['records.firstEntryDate'] = ts;
        r.firstEntryDate = ts;
      } else if (curFirst !== null && oldTime === curFirst) {
        updates._needsFirstRescan = true;
      }
    }
  }

  // ─── Viimeistele viikko-incrementit (1 FV.increment per avain) ─
  Object.entries(weekDeltas).forEach(([weekKey, d]) => {
    const path = `records.weeks.${weekKey}`;
    updates[`${path}.sessions`]    = FV.increment(d.sessions);
    updates[`${path}.minutes`]     = FV.increment(d.minutes);
    updates[`${path}.uppoMinutes`] = FV.increment(d.uppoMinutes);
  });

  return updates;
}

// ── Apuri: kaksi Timestampia samana päivänä? ────────────────
function sameDay(a, b) {
  const da = a?.toDate ? a.toDate() : new Date(a);
  const db = b?.toDate ? b.toDate() : new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

// ── Rescan longest/firstEntry kun nykyinen poistettiin ───────
async function rescanLongestAndFirst() {
  // 1 read max kummallekin
  const updates = {};
  const longestSnap = await getUserEntries().orderBy('duration', 'desc').limit(1).get();
  if (!longestSnap.empty) {
    const d = longestSnap.docs[0].data();
    const longest = {
      duration: d.duration,
      date: d.date,
      type: d.type || '',
    };
    updates['records.longestEntry'] = longest;
    userProfile.records.longestEntry = longest;
  } else {
    updates['records.longestEntry'] = null;
    userProfile.records.longestEntry = null;
  }

  const firstSnap = await getUserEntries().orderBy('date', 'asc').limit(1).get();
  if (!firstSnap.empty) {
    const d = firstSnap.docs[0].data();
    updates['records.firstEntryDate'] = d.date;
    userProfile.records.firstEntryDate = d.date;
  } else {
    updates['records.firstEntryDate'] = null;
    userProfile.records.firstEntryDate = null;
  }

  if (Object.keys(updates).length > 0) {
    await getUserDoc().update(updates);
  }
}

// ── Sync userProfile-cache localStorageen ───────────────────
function syncRecordsCache() {
  if (currentUser?.uid && userProfile) {
    try { Cache.set(currentUser.uid, 'profile', userProfile); } catch {}
  }
}

// ── Laske täysi records-objekti entryjen joukosta (migraatio) ─
function computeRecordsFromEntries(entries) {
  const records = {
    bootstrapped: true,
    bootstrappedAt: firebase.firestore.FieldValue.serverTimestamp(),
    totalEntries: entries.length,
    totalMinutes: 0,
    firstEntryDate: null,
    longestEntry: null,
    weeks: {},
  };

  for (const e of entries) {
    const date = e.date?.toDate ? e.date.toDate() : new Date(e.date);
    const dur  = Number(e.duration) || 0;
    const isUppo = e.type === 'Uppopallo';

    records.totalMinutes += dur;

    if (!records.firstEntryDate || date < records.firstEntryDate.toDate()) {
      records.firstEntryDate = firebase.firestore.Timestamp.fromDate(date);
    }
    if (!records.longestEntry || dur > records.longestEntry.duration) {
      records.longestEntry = {
        duration: dur,
        date: firebase.firestore.Timestamp.fromDate(date),
        type: e.type || '',
      };
    }
    const wk = recordsWeekKey(date);
    if (!records.weeks[wk]) records.weeks[wk] = { sessions: 0, minutes: 0, uppoMinutes: 0 };
    records.weeks[wk].sessions    += 1;
    records.weeks[wk].minutes     += dur;
    if (isUppo) records.weeks[wk].uppoMinutes += dur;
  }

  return records;
}
