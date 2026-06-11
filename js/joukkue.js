// ============================================================
// JOUKKUE FEED
// ============================================================

// Current user's own reactions: { "ownerUid_entryId": emoji }
// Loaded once per session from users/{currentUid}.myReactions; force=true clears it.
// This avoids writing to other users' entry documents entirely.
let myGlobalReactions = {};
let myGlobalReactionsLoaded = false;

// Same sort logic as sortEntries but for plain entry objects
function sortFeedItems(items) {
  const localDay = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  return [...items].sort((a, b) => {
    const ta = a.entry.date?.toMillis ? a.entry.date.toMillis() : 0;
    const tb = b.entry.date?.toMillis ? b.entry.date.toMillis() : 0;
    const dayA = localDay(ta), dayB = localDay(tb);
    if (dayA !== dayB) return dayA > dayB ? -1 : 1;
    const haA = a.entry.hasTime ?? (ta % 86400000 !== 0);
    const haB = b.entry.hasTime ?? (tb % 86400000 !== 0);
    if (haA !== haB) return haB ? 1 : -1;
    if (haA && haB) return tb - ta;
    const ua = a.entry.updatedAt?.toMillis ? a.entry.updatedAt.toMillis() : 0;
    const ub = b.entry.updatedAt?.toMillis ? b.entry.updatedAt.toMillis() : 0;
    return ub - ua;
  });
}

function joukkueFeedItemHtml(item, myReaction, avatarCache) {
  const { ownerUid, profile, entryId, entry } = item;
  const memberName = profile.nickname || profile.firstName || profile.email || 'Pelaaja';
  const initials   = (profile.firstName?.[0] || profile.email?.[0] || '?').toUpperCase();
  const avatarSrc  = profile.photoURL || avatarCache[ownerUid];
  const avatarHtml = avatarSrc ? `<img src="${escapeHtml(avatarSrc)}" alt="">` : initials;

  const dateStr = entry.date?.toMillis ? formatDisplayDate(entry.date) : '—';

  const perfIdx   = entry.performance ? entry.performance - 1 : null;
  const perfColor = perfIdx !== null ? PERF_COLORS[perfIdx] : 'var(--blue)';
  const perfBadge = perfIdx !== null
    ? `<span class="entry-perf-badge" style="background:${PERF_COLORS[perfIdx]}22;color:${PERF_COLORS_DARK[perfIdx]};border:1px solid ${PERF_COLORS[perfIdx]}55">${PERF_ROMAN[perfIdx]} – ${PERF_LABELS[entry.performance].split(' – ')[1]}</span>`
    : '<span></span>';
  const feelBadge = entry.feeling
    ? `<span class="entry-feel-badge" style="background:${FEEL_COLORS[entry.feeling].bg};color:${FEEL_COLORS[entry.feeling].color}">${FEEL_EMOJIS[entry.feeling]} ${FEEL_LABELS[entry.feeling]}</span>`
    : '';

  const emojiCounts  = entry.reactionCounts || {};
  const reactionBtns = REACTION_EMOJIS.map(emoji => {
    const count     = emojiCounts[emoji] || 0;
    const isActive  = myReaction === emoji;
    const countHtml = count > 0 ? `<span class="reaction-count">${count}</span>` : '';
    return `<button class="reaction-btn${isActive ? ' active' : ''}" data-emoji="${emoji}" onclick="toggleReaction('${ownerUid}','${entryId}','${emoji}',this)">${emoji}${countHtml}</button>`;
  }).join('');

  return `
    <div class="joukkue-entry-card">
      <div class="entry-card-stripe" style="background:${perfColor}"></div>
      <div class="joukkue-entry-card-body">
        <div class="joukkue-entry-header">
          <div class="joukkue-avatar-sm">${avatarHtml}</div>
          <span class="joukkue-member-name">${escapeHtml(memberName)}</span>
          <span class="joukkue-entry-date">${escapeHtml(dateStr)}</span>
        </div>
        <div class="joukkue-entry-body">
          <div class="joukkue-entry-type">${escapeHtml(entry.type || '—')}</div>
          <div class="entry-stats-grid">
            <span class="entry-duration">⏱ ${entry.duration || '?'} min</span>
            <span class="stats-center">${perfBadge !== '<span></span>' ? perfBadge : ''}</span>
            <span class="stats-right">${feelBadge}</span>
            ${(entry.distance != null || entry.avgHr != null || entry.maxHr != null) ? `
            <span class="extra-col1">${entry.distance != null ? `📍 ${String(entry.distance).replace('.', ',')} km` : ''}</span>
            <span class="extra-col2">${entry.avgHr != null ? `❤️ ${entry.avgHr} bpm` : ''}</span>
            <span class="extra-col3">${entry.maxHr != null ? `🔺 ${entry.maxHr} bpm` : ''}</span>` : ''}
          </div>
          ${entry.comment && profile.shareComments && !entry.privateComment ? `<div class="entry-comment">${escapeHtml(entry.comment)}</div>` : ''}
        </div>
        <div class="joukkue-reactions">${reactionBtns}</div>
      </div>
    </div>`;
}

async function appendJoukkuePage() {
  if (joukkueFeedRendered >= joukkueFeedItems.length) return;

  const feedEl = el('joukkue-feed');
  const slice  = joukkueFeedItems.slice(joukkueFeedRendered, joukkueFeedRendered + JOUKKUE_PAGE_SIZE);

  // Determine current user's reaction from in-memory cache, then myGlobalReactions
  const myReactionsMap = {};
  slice.forEach(({ ownerUid, entryId }) => {
    const key = ownerUid + '_' + entryId;
    if (key in myReactionsCache) {
      myReactionsMap[key] = myReactionsCache[key];
    } else {
      const reacted = myGlobalReactions[key] || null;
      myReactionsMap[key] = myReactionsCache[key] = reacted;
    }
  });

  const html = slice.map(item =>
    joukkueFeedItemHtml(item, myReactionsMap[item.ownerUid + '_' + item.entryId] || null, joukkueAvatarCache)
  ).join('');

  if (joukkueFeedRendered === 0) feedEl.innerHTML = html;
  else feedEl.insertAdjacentHTML('beforeend', html);
  joukkueFeedRendered += slice.length;
}

async function renderJoukkueTab(force = false) {
  const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);

  if (myTeams.length === 0) {
    show('joukkue-no-team');
    el('joukkue-feed').innerHTML = '';
    el('joukkue-period-label').textContent = '';
    return;
  }
  hide('joukkue-no-team');

  // Period label: today back 14 days
  const periodEnd   = new Date();
  const periodStart = new Date(); periodStart.setDate(periodStart.getDate() - 14);
  const fmtP = d => d.toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric', year: 'numeric' });
  el('joukkue-period-label').textContent = `Näytetään: ${fmtP(periodStart)} – ${fmtP(periodEnd)}`;

  const cacheKey      = 'joukkue_feed_' + [...myTeams].sort().join('|');
  const cacheStoreKey = 'uppis_jf2_' + currentUser.uid + '_' + cacheKey;

  // Force refresh: clear feed + reaction caches
  if (force) {
    try { localStorage.removeItem(cacheStoreKey); } catch {}
    Object.keys(myReactionsCache).forEach(k => delete myReactionsCache[k]);
    myGlobalReactions = {};
    myGlobalReactionsLoaded = false;
  }

  // Reset pagination
  joukkueFeedItems    = [];
  joukkueFeedRendered = 0;

  // Tarkista välimuisti ennen spinnerin näyttämistä — nopea synkroninen peek
  let   cachedRaw = null;
  if (!force) {
    try {
      const raw = localStorage.getItem(cacheStoreKey);
      if (raw) {
        const p = JSON.parse(raw);
        if (Date.now() - p.ts < JOUKKUE_CACHE_TTL) cachedRaw = raw;
      }
    } catch {}
  }
  // Näytä "Ladataan…" vain jos mennään verkkoon
  if (!cachedRaw) el('joukkue-feed').innerHTML = '<div class="loading">Ladataan…</div>';

  try {
    // ── Load current user's reactions (skip if already in memory) ───
    if (!myGlobalReactionsLoaded) {
      try {
        const mySnap = await getUserDoc().get();
        myGlobalReactions = mySnap.data()?.myReactions || {};
      } catch (e) {
        myGlobalReactions = {};
      }
      myGlobalReactionsLoaded = true;
    }
    // Clear per-entry cache so appendJoukkuePage re-reads from myGlobalReactions
    Object.keys(myReactionsCache).forEach(k => delete myReactionsCache[k]);

    const now     = Date.now();
    let   rawItems = null;
    let   feedDataTs = null; // millisekuntiaikaleima datan iälle

    // ── Try cache (cacheStoreKey + cachedRaw already checked above) ─
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        feedDataTs = parsed.ts;
        rawItems = parsed.data.map(item => ({
          ...item,
          entry: {
            ...item.entry,
            date: typeof item.entry.date === 'number'
              ? { toMillis: () => item.entry.date, toDate: () => new Date(item.entry.date) }
              : item.entry.date,
          },
        }));
      } catch { cachedRaw = null; }
    }

    // ── Load avatar cache ─────────────────────────────────────────
    try {
      const av = localStorage.getItem('uppis_av_' + currentUser.uid);
      if (av) { const p = JSON.parse(av); if (now - p.ts < 86400000) joukkueAvatarCache = p.data; }
    } catch {}

    // ── Fetch from Firestore if no cache ──────────────────────────
    if (!rawItems) {
      const usersSnap = await db.collection('users')
        .where('profile.teams', 'array-contains-any', myTeams).get();

      const members = [];
      usersSnap.forEach(doc => {
        if (doc.id !== currentUser.uid && doc.data()?.profile?.shareActivities === true)
          members.push({ uid: doc.id, profile: doc.data()?.profile || {} });
      });

      const cutoff   = new Date(); cutoff.setDate(cutoff.getDate() - 14);
      const cutoffTs = firebase.firestore.Timestamp.fromDate(cutoff);

      rawItems = [];
      await Promise.all(members.map(async ({ uid, profile }) => {
        const snap = await db.collection('users').doc(uid).collection('entries')
          .where('date', '>=', cutoffTs).orderBy('date', 'desc').get();
        snap.forEach(doc => rawItems.push({ ownerUid: uid, profile, entryId: doc.id, entry: doc.data() }));
      }));

      // Cache avatars separately (24h)
      const avatarMap = {};
      members.forEach(({ uid, profile }) => { if (profile.photoURL) avatarMap[uid] = profile.photoURL; });
      joukkueAvatarCache = avatarMap;
      try { localStorage.setItem('uppis_av_' + currentUser.uid, JSON.stringify({ ts: now, data: avatarMap })); } catch {}

      feedDataTs = now;
      // Cache feed
      try {
        localStorage.setItem(cacheStoreKey,
          JSON.stringify({ ts: now, data: rawItems.map(item => ({
            ...item,
            profile: { ...item.profile, avatar: undefined },
            entry:   { ...item.entry, date: item.entry.date?.toMillis?.() ?? item.entry.date },
          })) }));
      } catch {}
    }

    if (rawItems.length === 0) {
      el('joukkue-feed').innerHTML = '<p style="padding:1rem;color:var(--text-muted);font-size:0.9rem;">Ei joukkueen treenejä viimeiseltä 14 päivältä.</p>';
      return;
    }

    joukkueFeedItems = sortFeedItems(rawItems);
    await appendJoukkuePage();

    // Näytä datan aikaleima
    const tsEl = el('joukkue-cache-ts');
    if (tsEl && feedDataTs) {
      const d  = new Date(feedDataTs);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      tsEl.textContent = `${hh}.${mm}`;
    }

  } catch (err) {
    console.error('Joukkue feed error:', err);
    el('joukkue-feed').innerHTML = '<p style="padding:1rem;color:var(--text-muted);">Lataus epäonnistui.</p>';
  }
}

// Suojautuminen rinnakkaisilta toggle-kutsuilta saman entryn yli — race conditioneilla
// laskurit driftaavat ja revert lukee virheellisen optimistisen tilan.
const _reactionPending = new Set();

window.toggleReaction = async function toggleReaction(ownerUid, entryId, emoji, btnEl) {
  const cacheKey    = ownerUid + '_' + entryId;
  // Jos sama entry on jo pendingissä, ohita kunnes edellinen pyyntö valmistuu
  if (_reactionPending.has(cacheKey)) return;
  _reactionPending.add(cacheKey);

  haptic('light');
  const entryRef    = db.collection('users').doc(ownerUid).collection('entries').doc(entryId);
  const reactionRef = entryRef.collection('reactions').doc(currentUser.uid);
  const myUserRef   = getUserDoc();
  let isActive      = btnEl.classList.contains('active');
  const inc         = firebase.firestore.FieldValue.increment;
  const fdel        = firebase.firestore.FieldValue.delete;

  const reactionRow = btnEl.closest('.joukkue-reactions');
  // Disabloi koko rivin napit kunnes toggle valmistuu (no-op jos rowia ei löydy)
  const buttons = reactionRow ? reactionRow.querySelectorAll('.reaction-btn') : [];
  buttons.forEach(b => b.disabled = true);

  // If adding a reaction, check Firestore for any existing reaction not yet in local caches.
  // This handles reactions made in previous sessions before myReactions tracking was added.
  let firestoreExistingEmoji = null;
  if (!isActive && !myReactionsCache[cacheKey] && !myGlobalReactions[cacheKey]) {
    try {
      const snap = await reactionRef.get();
      if (snap.exists) firestoreExistingEmoji = snap.data().emoji || null;
    } catch (e) { /* ignore, best-effort */ }
  }

  // Sync discovered existing reaction into caches and mark its button active
  if (firestoreExistingEmoji && firestoreExistingEmoji !== emoji) {
    myGlobalReactions[cacheKey] = firestoreExistingEmoji;
    myReactionsCache[cacheKey]  = firestoreExistingEmoji;
    // Mark the old button active in the DOM so the switch logic below works
    const oldBtn = reactionRow?.querySelector(`[data-emoji="${firestoreExistingEmoji}"]`);
    if (oldBtn) oldBtn.classList.add('active');
  }
  // Jos käyttäjä klikkasi jo olevaa emojia → pakota toggle-off ilman rekursiota
  if (firestoreExistingEmoji === emoji) {
    isActive = true;
    btnEl.classList.add('active');
  }

  // Find the currently active button (for switching: remove old, add new)
  const oldActiveBtn = !isActive ? reactionRow?.querySelector('.reaction-btn.active') : null;
  const oldEmoji     = oldActiveBtn?.dataset.emoji
                    || (!isActive && myReactionsCache[cacheKey] && myReactionsCache[cacheKey] !== emoji
                        ? myReactionsCache[cacheKey] : null)
                    || (!isActive && myGlobalReactions[cacheKey] && myGlobalReactions[cacheKey] !== emoji
                        ? myGlobalReactions[cacheKey] : null)
                    || null;

  // ── Optimistic UI update ──────────────────────────────────────
  const prevCached = myReactionsCache[cacheKey];
  const prevGlobal = myGlobalReactions[cacheKey];
  myReactionsCache[cacheKey] = isActive ? null : emoji;
  myGlobalReactions[cacheKey] = isActive ? null : emoji;

  btnEl.classList.toggle('active', !isActive);
  adjustReactionCount(btnEl, isActive ? -1 : 1);
  if (oldActiveBtn) { oldActiveBtn.classList.remove('active'); adjustReactionCount(oldActiveBtn, -1); }

  try {
    const batch = db.batch();

    if (isActive) {
      // Remove reaction entirely
      batch.delete(reactionRef);
      batch.update(entryRef, { [`reactionCounts.${emoji}`]: inc(-1) });
      // Remove from own reactions map
      batch.update(myUserRef, { [`myReactions.${cacheKey}`]: fdel() });
    } else {
      // Add or switch — reactionRef is keyed by currentUser.uid so only one per user
      batch.set(reactionRef, { emoji, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
      const entryUpdates = { [`reactionCounts.${emoji}`]: inc(1) };
      if (oldEmoji) entryUpdates[`reactionCounts.${oldEmoji}`] = inc(-1);
      batch.update(entryRef, entryUpdates);
      // Store in own user doc — no cross-user writes needed
      batch.set(myUserRef, { myReactions: { [cacheKey]: emoji } }, { merge: true });
    }

    await batch.commit();

    // Invalidate feed cache so next open has fresh reactionCounts
    const myTeams = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
    const feedKey = 'uppis_jf2_' + currentUser.uid + '_joukkue_feed_' + [...myTeams].sort().join('|');
    try { localStorage.removeItem(feedKey); } catch {}

  } catch (err) {
    console.error('Reaction error:', err);
    // Revert optimistic update
    myReactionsCache[cacheKey] = prevCached;
    myGlobalReactions[cacheKey] = prevGlobal;
    btnEl.classList.toggle('active', isActive);
    adjustReactionCount(btnEl, isActive ? 1 : -1);
    if (oldActiveBtn) { oldActiveBtn.classList.add('active'); adjustReactionCount(oldActiveBtn, 1); }
    toast('Reaktion tallennus epäonnistui.', 'error');
  } finally {
    _reactionPending.delete(cacheKey);
    buttons.forEach(b => b.disabled = false);
  }
};

function adjustReactionCount(btn, delta) {
  let countEl = btn.querySelector('.reaction-count');
  const current = countEl ? (parseInt(countEl.textContent) || 0) : 0;
  const next    = Math.max(0, current + delta);
  if (next > 0) {
    if (!countEl) { countEl = document.createElement('span'); countEl.className = 'reaction-count'; btn.appendChild(countEl); }
    countEl.textContent = next;
  } else if (countEl) {
    countEl.remove();
  }
}
