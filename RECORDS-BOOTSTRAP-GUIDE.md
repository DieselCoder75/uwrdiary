# Task: Self-bootstrap the records aggregate in UWR Diary

Guidance for a Claude Code session working in the UWR Diary repo. Read `CLAUDE.md`
first — it contains the deploy workflow you MUST follow. This document describes one
specific, scoped fix. Do not refactor beyond it.

## Goal

Make the Saavutukset (achievements) tab **write back the `records` aggregate** after
its one-time full-history scan, so every subsequent open uses the existing 0-read fast
path. Today the full scan (`users/{uid}/entries` — the user's *entire* training
history) repeats on every 24 h localStorage cache miss, on every device, forever.
After this fix it happens at most once per user account.

## Background — what already works (do not re-implement)

The aggregate system is fully built and was repaired in deploys v183–v184:

- **Schema**: `users/{uid}.records` at the user-doc **root** (NOT inside `profile`):
  `{ bootstrapped: true, bootstrappedAt, totalEntries, totalMinutes, firstEntryDate
  (Timestamp|null), longestEntry: {duration, date, type}|null, weeks: { "YYYY-Wnn":
  {sessions, minutes, uppoMinutes} } }`. Documented in the header of `js/records.js`.
- **Loading**: `loadProfile()` (`js/profile.js`, ~line 10) reads root `records` into
  `userProfile.records`. Works.
- **Fast path**: `renderEnnatykset()` (`js/profile.js`, ~line 655) — if
  `!impersonating && userProfile?.records?.bootstrapped`, it calls
  `renderEnnatyksetFromRecords()` (~line 581) with **zero entry reads**. The renderer
  is null-safe (`r.weeks || {}`, optional chaining on `longestEntry`/`firstEntryDate`)
  and never reads `bootstrappedAt`. Works.
- **Incremental updates**: `buildRecordsUpdate()` in `js/records.js` keeps the
  aggregate current on every entry save/edit/delete (wired in `js/entries.js`
  ~lines 1046–1141, including `rescanLongestAndFirst()` when the longest/first entry
  is removed or edited). Works — verified in review.
- **The gap (this task)**: `computeRecordsFromEntries(entries)` (`js/records.js`,
  ~line 219) — the function that builds the full aggregate from a list of entries —
  has **zero call sites**. Nothing in the app ever sets `records.bootstrapped = true`,
  so users who weren't migrated by an out-of-band admin script never reach the fast
  path.

## The fix

File: `js/profile.js`, inside `renderEnnatykset()`'s fallback branch. The full scan
happens at ~line 704:

```js
const snap = await getUserEntries().orderBy('date', 'asc').get();
const entries = snap.docs.map(d => { ... });   // {date: JS Date, duration, performance, type}
```

Immediately **after** the `if (!entries.length) { ...; return; }` early-return
(~line 711–715), add the self-bootstrap — the scan is already paid for, so writing
the aggregate now makes it the last scan this account ever does:

```js
// Self-bootstrap: koko historia on jo luettu — kirjoita aggregaatti talteen,
// jotta seuraavat avaukset käyttävät fast pathia (0 entry-readia).
if (!impersonating && !userProfile?.records?.bootstrapped) {
  try {
    const rec = computeRecordsFromEntries(entries);
    await getUserDoc().update({ records: rec });
    userProfile.records = rec;
    syncRecordsCache();
  } catch (err) {
    console.warn('records bootstrap failed:', err);   // ei saa estää renderöintiä
  }
}
```

Then let the existing rendering code continue unchanged (it should still render from
the freshly scanned entries on this first visit; only *subsequent* visits take the
fast path).

### Why each piece matters

- **`!impersonating` guard is the single most important line.** The fallback also
  runs when an admin impersonates a non-bootstrapped player: `getUserEntries()` then
  returns the *player's* entries, but `getUserDoc()` is ALWAYS the admin's own doc
  (see `js/entries.js:11-18`). Without the guard you would write the player's
  statistics into the admin's `records` — silent data corruption. This is the same
  pitfall class as the documented impersonation-cache bug in `CLAUDE.md`.
- **Entry shape is compatible**: the mapped objects carry `date` (JS Date),
  `duration`, `type` — exactly what `computeRecordsFromEntries` needs (it handles
  both `Timestamp` and `Date` via `e.date?.toDate ? ... : new Date(e.date)`).
- **`update()` not `set()`**: the user doc always exists at this point (`loadProfile`
  runs at login and writes `email` if missing). Owner write is allowed by
  `firestore.rules` line 12.
- **`syncRecordsCache()`** (defined in `js/records.js` ~line 212) refreshes the
  localStorage profile cache so a reload doesn't resurrect the un-bootstrapped state.
- **Failure must be non-fatal**: wrap in try/catch and keep rendering. A user with
  flaky connectivity should still see their stats from the scan they just did.

### Known wrinkle (accept it, or handle it — your choice)

`computeRecordsFromEntries` sets
`bootstrappedAt: firebase.firestore.FieldValue.serverTimestamp()` — a write
**sentinel**. Storing `rec` into the local `userProfile.records` therefore leaves a
sentinel object in memory and (via `syncRecordsCache`) JSON-garbage in localStorage.
Nothing reads `bootstrappedAt` client-side (verified), so this is harmless. If you
want it clean, assign the local copy as
`userProfile.records = { ...rec, bootstrappedAt: null };`. Do NOT remove the sentinel
from the Firestore write.

### Deliberately out of scope

- Do NOT bootstrap users with zero entries (the early-return path). An empty-
  collection scan costs ~1 read; not worth the extra write/edge cases.
- Do NOT bootstrap during impersonation "on behalf of" the player — admin writes to
  other users' docs are restricted by rules to
  `myReactions`/`coachOf`/`records` (`firestore.rules:21-23`), so it *would* be
  technically possible for `records`, but writing to `getViewDoc()` here adds an
  easy-to-get-wrong code path for marginal benefit. Skip it.
- Do NOT touch `buildRecordsUpdate`, `rescanLongestAndFirst`, the fast path, or the
  localStorage HTML cache logic. They are correct as of v184.

## Deploy checklist (from CLAUDE.md — cache-first SW serves stale files otherwise)

1. `node --check js/profile.js`
2. Bump `js/profile.js?v=` in `index.html`. It was `v=67` as of deploy-v184 —
   **verify the actual current number with grep, never trust documentation.**
3. Bump `CACHE_NAME` in `sw.js` (was `uwr-diary-v184` — verify, then +1).
4. Deploy with `./deploy.sh` from the project directory (it commits, tags, pushes,
   and runs `firebase deploy --only hosting`).
5. No user-visible feature change → no Käyttöohje/version-number update needed.

## Verification

1. **Normal user, first open**: log in as a user whose Firestore doc has no
   `records.bootstrapped`. Open Profiili → Saavutukset. Check the Firebase console:
   `users/{uid}.records` now exists with `bootstrapped: true` and plausible
   `totalEntries`/`totalMinutes`/`weeks`.
2. **Fast path engages**: delete the `uppis_records_{uid}` localStorage key (it
   caches rendered HTML for 24 h and would mask the test), reload, reopen
   Saavutukset. Confirm no `entries` collection scan fires (Network tab, or a
   temporary log in the fast path). Stats must match step 1's rendering — the fast
   path and the scan path compute the same numbers (both use ISO-week grouping;
   compare `recordsWeekKey` in records.js with the inline week math in profile.js).
3. **Impersonation safety (critical)**: as admin (`janne.lind@gmail.com`),
   impersonate a player who is NOT bootstrapped, open their Saavutukset. Confirm:
   (a) the stats shown are the player's, (b) the **admin's own**
   `users/{adminUid}.records` is unchanged in the console, (c) the player's doc is
   also unchanged (no bootstrap during impersonation).
4. **Incremental updates keep working**: after step 1, add a training entry, then
   check Saavutukset reflects it (totalEntries +1) without a full scan; edit the
   entry's duration and re-check; delete it and re-check.

## Quick reference

| What | Where |
|---|---|
| Fallback full scan | `js/profile.js` ~704 (`renderEnnatykset`) |
| Early-return for empty history | `js/profile.js` ~711 |
| Fast path | `js/profile.js` ~661 |
| `computeRecordsFromEntries` | `js/records.js` ~219 |
| `syncRecordsCache` | `js/records.js` ~212 |
| `getUserDoc` (always own) vs `getUserEntries`/`getViewDoc` (viewed) | `js/entries.js` 11–18 |
| Owner/admin write rules | `firestore.rules` 12, 21–23 |
