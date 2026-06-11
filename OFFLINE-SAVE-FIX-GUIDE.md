# Task: Fix the offline save/delete hang in UWR Diary

Guidance for a Claude Code session working in the UWR Diary repo. Read `CLAUDE.md`
first — it contains the deploy workflow you MUST follow. This is a scoped fix; do not
refactor beyond it.

## The bug

Underwater rugby happens in swimming halls with poor connectivity — exactly where
entries get logged. The offline banner (index.html ~line 97) promises:
*"📵 Ei yhteyttä — treenikirjaukset tallennetaan ja synkataan automaattisesti kun
yhteys palaa"*. The code cannot deliver on that promise:

- **Save handler** (`js/entries.js` ~1044–1110, `entry-form` submit): every write —
  `getUserEntries().add(data)`, `.update(data)`, or `batch.commit()` — is `await`ed.
  With the Firestore web SDK these promises resolve **only on server
  acknowledgment**, never while offline. So offline the `await` (lines ~1061, 1063,
  1073, 1075) hangs forever: the button sticks at "Tallennetaan…", the modal never
  closes, and the `if (!navigator.onLine && !currentEntryId)` queue branch at
  line ~1095 is **unreachable** in the very state it was written for (it only runs
  after the await resolves, i.e. after reconnect — when its message is wrong).
- **Delete handler** (~1115–1159): same structure, same hang at lines ~1132/1134.
- **Consequences**: the user force-closes the modal via ✕ and re-enters the workout
  → duplicate entry on reconnect. The reconnect toast in `js/app.js` (~243–250,
  "✅ Yhteys palautettu — N treenikirjausta synkattu") is effectively dead code.

## Key fact the fix builds on (do not build a custom queue)

`db.enablePersistence({ synchronizeTabs: true })` is already enabled
(`js/config.js:18`). Firestore's offline persistence makes every write **durable in
IndexedDB immediately**: it survives page reloads and syncs automatically when
connectivity returns. The unresolved promise is *only* the missing server ack — the
data is already safe locally. Reads are also fine offline: `.get()` falls back to
the local cache (including pending writes), so the post-save `fetchEntries()` will
correctly show the new entry. **Do NOT implement a custom IndexedDB/localStorage
write queue — that would duplicate what persistence already does.**

Therefore the fix is purely a UI-flow change: stop blocking the UI on server ack.

## The fix

### 1. Add an ack-race helper (in `js/entries.js`, near the top, or `js/utils.js`)

```js
// Odota Firestore-kirjoituksen serverikuittausta enintään `ms` millisekuntia.
// true = serveri kuittasi, false = kirjoitus jäi paikalliseen jonoon
// (offline TAI hidas yhteys — persistence synkkaa sen automaattisesti).
function awaitWriteAck(promise, ms = 4000) {
  return Promise.race([
    promise.then(() => true, () => true), // myös virhe "ratkeaa" — virhe käsitellään .catchissa
    new Promise(res => setTimeout(() => res(false), ms)),
  ]);
}
```

Use a **timeout race, not `navigator.onLine`**, as the primary mechanism:
`navigator.onLine` can be `true` with no real connectivity (hall basement wifi with
no internet), and the original hang occurs in exactly that state.

### 2. Restructure the save handler (~1054–1101)

Replace the four awaited write sites with a single `writePromise`, attach an error
handler, then race:

```js
let writePromise;
if (currentEntryId) {
  if (/* records batch, as now */) {
    const batch = db.batch();
    batch.update(getUserEntries().doc(currentEntryId), data);
    batch.update(getUserDoc(), cleanUpdates);
    writePromise = batch.commit();
  } else {
    writePromise = getUserEntries().doc(currentEntryId).update(data);
  }
} else {
  data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
  /* same structure for the add + records-batch case */
  writePromise = /* batch.commit() tai getUserEntries().add(data) */;
}

// Aito virhe (esim. säännöt hylkää) voi ilmetä vasta kuittauksessa — näytä se silloin.
writePromise.catch(err => {
  console.error('entry write failed on sync:', err);
  toast('⚠️ Treenin synkronointi epäonnistui — tarkista kirjaus', 'error');
});

const acked = await awaitWriteAck(writePromise);
```

Then run the existing post-save block (cache invalidations, `closeModal()`,
`haptic`, `fetchEntries()`) **unconditionally**, and base the toast on `acked`
instead of `navigator.onLine`:

```js
if (!acked) {
  setPendingCount(getPendingCount() + 1);   // app.js:n helperit, ks. kohta 4
  writePromise.then(() => setPendingCount(Math.max(0, getPendingCount() - 1)));
  toast('📵 Tallennettu jonoon — synkataan kun yhteys palaa', 'success');
} else {
  toast(currentEntryId ? 'Treeni päivitetty.' : 'Treeni tallennettu!', 'success');
}
```

Notes:
- Keep `recordsUpdate` computation (`buildRecordsUpdate`) where it is — it's pure
  local computation, no reads, no hang risk.
- The local-cache invalidation + `fetchEntries()` work offline: the query `get()`
  serves cached data including the pending write, so the list updates immediately.
- Remove the now-dead `if (!navigator.onLine && !currentEntryId)` branch entirely.
  The new logic also covers offline **edits** and **deletes**, which the old branch
  ignored.

### 3. Same restructure for the delete handler (~1127–1135)

`writePromise = batch.commit()` / `.delete()`, attach `.catch`, race with
`awaitWriteAck`, then proceed with the existing invalidation + `closeModal()`. Toast:
`acked ? (nykyinen käytös) : '📵 Poisto jonossa — synkataan kun yhteys palaa'`.

### 4. The rescan trap (`rescanLongestAndFirst`) — easy to miss

In both handlers there is:

```js
if (recordsUpdate && (recordsUpdate._needsLongestRescan || recordsUpdate._needsFirstRescan)) {
  try { await rescanLongestAndFirst(); } catch (e) { ... }
}
```

`rescanLongestAndFirst()` (js/records.js ~178) ends with an **awaited
`getUserDoc().update(updates)`** — a write that hangs offline exactly like the main
one, and the surrounding `try/catch` does NOT help (a hang is not an exception).
Restructure:

```js
if (recordsUpdate && (recordsUpdate._needsLongestRescan || recordsUpdate._needsFirstRescan)) {
  if (acked) {
    try { await rescanLongestAndFirst(); } catch (e) { console.warn('rescan failed:', e); }
  } else {
    // Aja rescan vasta kun jonossa ollut kirjoitus on synkattu serverille
    writePromise.then(() => rescanLongestAndFirst()).catch(e => console.warn('deferred rescan failed:', e));
  }
}
```

(The deferred rescan is lost if the page is closed before reconnect — acceptable:
it only affects the cached longest/first stat, and the next qualifying edit/delete
re-triggers it. The reads inside rescan fall back to cache, that part is safe.)

### 5. Pending-count bookkeeping (`js/app.js` ~225–250)

`PENDING_KEY`/`getPendingCount`/`setPendingCount` and the `'online'` handler already
exist — with this fix they finally become reachable. Two adjustments:

- The count is now incremented for adds, edits AND deletes (step 2/3), and
  decremented in `writePromise.then(...)` when a queued write actually acks while
  the page is still open.
- Soften the reconnect toast copy: the handler fires on the `online` event, which
  does not guarantee the sync has completed. Suggested:
  `'✅ Yhteys palautettu — jonossa olleet kirjaukset synkronoidaan'` (and reset the
  count, as now). Be aware the localStorage count is **cosmetic only** — the source
  of truth is Firestore persistence; if the page reloads while offline, queued
  writes still sync on next load even though the counter/toast may be off. Do not
  try to make the counter perfect; it's not worth the complexity.

### 6. Fix the typo in the offline banner while you're here

index.html ~line 98: "treenikerjaukset" → "treenikirjaukset".

## Deliberately out of scope

- No custom write queue (persistence handles it).
- Do not touch `fetchEntries`/`loadEntries`, sw.js, or the records logic
  (`buildRecordsUpdate` internals) — they are correct as of deploy-v185.
- Do not switch reads to `getDocsFromCache`/listeners in this task.

## Deploy checklist (from CLAUDE.md — cache-first SW serves stale files otherwise)

1. `node --check js/entries.js && node --check js/app.js` (+ utils.js jos helper sinne).
2. Bump `?v=` in index.html for every touched JS file. As of deploy-v185:
   `entries.js?v=42`, `app.js?v=19`, `utils.js?v=5` — **verify actual numbers with
   grep, never trust documentation.** index.html itself needs no `?v=`.
3. Bump `CACHE_NAME` in sw.js (was `uwr-diary-v185` — verify, then +1).
4. Deploy with `./deploy.sh` from the project directory.
5. This is a user-visible behavior fix → add a line to the Versiot tab in
   `#help-modal` (index.html) per CLAUDE.md's versioning section; bumping the app
   version number (auth.js + profile.js, two places) is optional for a fix.

## Verification

Use Chrome DevTools → Network → "Offline" (and ideally a real phone in airplane
mode, since this is an iOS-centric PWA):

1. **Offline add**: go offline, create an entry → modal must close within ~4 s,
   "📵 Tallennettu jonoon" toast shows, the entry appears in the Loki list
   immediately (served from local cache).
2. **Durability**: still offline, reload the page → the entry is still in the list
   (persistence). Go online → entry appears in the Firebase console, reconnect
   toast shows, no duplicates.
3. **Offline edit + delete**: repeat for editing an existing entry and deleting
   one. Modal must never hang.
4. **Online regression**: with normal connectivity, add/edit/delete still show the
   normal toasts ("Treeni tallennettu!" etc.) — the ack race resolves via the ack,
   not the timeout.
5. **Records integrity**: as a bootstrapped user, do an offline edit of your
   longest entry (shorten it), reconnect, wait a few seconds → check
   `users/{uid}.records.longestEntry` in the console was rescanned correctly
   (deferred rescan path, step 4).
6. **Slow-network case**: DevTools "Slow 3G" — a save slower than 4 s shows the
   queue toast but the write still completes server-side; verify no duplicate and
   no error.

## Quick reference

| What | Where |
|---|---|
| Save handler (4 awaited writes) | `js/entries.js` ~1044–1110 |
| Dead offline branch to remove | `js/entries.js` ~1095–1098 |
| Delete handler | `js/entries.js` ~1115–1159 |
| Hidden hanging write in rescan | `js/records.js` ~178–209 (`rescanLongestAndFirst`) |
| Pending-count helpers + online toast | `js/app.js` ~225–250 |
| Offline banner (incl. typo) | `index.html` ~97–98 |
| Persistence already enabled | `js/config.js:18` |
