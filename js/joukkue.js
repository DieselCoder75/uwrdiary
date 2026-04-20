// ============================================================
// JOUKKUE FEED
// ============================================================

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
  const avatarHtml = avatarSrc ? `<img src="${avatarSrc}" alt="">` : initials;

  const dateStr = entry.date?.toMillis ? formatDisplayDate(entry.date) : '—';

  const perfIdx   = entry.performance ? entry.performance - 1 : null;
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
        ${entry.comment && profile.shareComments ? `<div class="entry-comment">${escapeHtml(entry.comment)}</div>` : ''}
      </div>
      <div class="joukkue-reactions">${reactionBtns}</div>
    </div>`;
}

async function appendJoukkuePage() {
  if (joukkueFeedRendered >= joukkueFeedItems.length) return;

  const feedEl = el('joukkue-feed');
  const slice  = joukkueFeedItems.slice(joukkueFeedRendered, joukkueFeedRendered + JOUKKUE_PAGE_SIZE);

  // Fetch current user's own reaction per entry — use in-memory cache to skip re-reads on tab switch
  // Reaction counts come free from entry.reactionCounts — zero extra reads for display
  const myReactionsMap = {};
  await Promise.all(slice.map(async ({ ownerUid, entryId }) => {
    const key = ownerUid + '_' + entryId;
    if (key in myReactionsCache) {
      myReactionsMap[key] = myReactionsCache[key];
      return;
    }
    try {
      const doc = await db.collection('users').doc(ownerUid)
        .collection('entries').doc(entryId)
        .collection('reactions').doc(currentUser.uid).get();
      myReactionsMap[key] = myReactionsCache[key] = doc.exists ? doc.data().emoji : null;
    } catch { myReactionsMap[key] = myReactionsCache[key] = null; }
  }));

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

  // Force refresh: clear feed + reaction caches
  if (force) {
    const cacheKey = 'joukkue_feed_' + [...myTeams].sort().join('|');
    try { localStorage.removeItem('uppis_jf_' + currentUser.uid + '_' + cacheKey); } catch {}
    Object.keys(myReactionsCache).forEach(k => delete myReactionsCache[k]);
  }

  // Reset pagination
  joukkueFeedItems    = [];
  joukkueFeedRendered = 0;
  el('joukkue-feed').innerHTML = '<div class="loading">Ladataan…</div>';

  try {
    const cacheKey = 'joukkue_feed_' + [...myTeams].sort().join('|');
    const now      = Date.now();
    let   rawItems = null;

    // ── Try cache ─────────────────────────────────────────────
    const cachedRaw = localStorage.getItem('uppis_jf_' + currentUser.uid + '_' + cacheKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (now - parsed.ts < JOUKKUE_CACHE_TTL) {
          rawItems = parsed.data.map(item => ({
            ...item,
            entry: {
              ...item.entry,
              date: typeof item.entry.date === 'number'
                ? { toMillis: () => item.entry.date, toDate: () => new Date(item.entry.date) }
                : item.entry.date,
            },
          }));
        }
      } catch {}
    }

    // ── Load avatar cache ─────────────────────────────────────
    try {
      const av = localStorage.getItem('uppis_av_' + currentUser.uid);
      if (av) { const p = JSON.parse(av); if (now - p.ts < 86400000) joukkueAvatarCache = p.data; }
    } catch {}

    // ── Fetch from Firestore if no cache ──────────────────────
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

      // Cache feed (strip avatar to save space)
      try {
        localStorage.setItem('uppis_jf_' + currentUser.uid + '_' + cacheKey,
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

  } catch (err) {
    console.error('Joukkue feed error:', err);
    el('joukkue-feed').innerHTML = '<p style="padding:1rem;color:var(--text-muted);">Lataus epäonnistui.</p>';
  }
}

window.toggleReaction = async function toggleReaction(ownerUid, entryId, emoji, btnEl) {
  const entryRef    = db.collection('users').doc(ownerUid).collection('entries').doc(entryId);
  const reactionRef = entryRef.collection('reactions').doc(currentUser.uid);
  const isActive    = btnEl.classList.contains('active');
  const inc         = firebase.firestore.FieldValue.increment;

  // Find old active reaction button (for switching emojis)
  const reactionRow = btnEl.closest('.joukkue-reactions');
  const oldActiveBtn = !isActive ? reactionRow?.querySelector('.reaction-btn.active') : null;
  const oldEmoji     = oldActiveBtn?.dataset.emoji || null;

  // ── Optimistic UI + in-memory reaction cache update ──────────
  const cacheKey = ownerUid + '_' + entryId;
  const prevCached = myReactionsCache[cacheKey];
  myReactionsCache[cacheKey] = isActive ? null : emoji;

  btnEl.classList.toggle('active', !isActive);
  adjustReactionCount(btnEl, isActive ? -1 : 1);
  if (oldActiveBtn) { oldActiveBtn.classList.remove('active'); adjustReactionCount(oldActiveBtn, -1); }

  try {
    const batch = db.batch();
    if (isActive) {
      batch.delete(reactionRef);
      batch.update(entryRef, { [`reactionCounts.${emoji}`]: inc(-1) });
    } else {
      batch.set(reactionRef, { emoji, timestamp: firebase.firestore.FieldValue.serverTimestamp() });
      const updates = { [`reactionCounts.${emoji}`]: inc(1) };
      if (oldEmoji) updates[`reactionCounts.${oldEmoji}`] = inc(-1);
      batch.update(entryRef, updates);
    }
    await batch.commit();

    // Invalidate joukkue feed cache so next open has fresh counts
    const myTeams  = userProfile.teams || (userProfile.team ? [userProfile.team] : []);
    const feedKey  = 'uppis_jf_' + currentUser.uid + '_joukkue_feed_' + [...myTeams].sort().join('|');
    try { localStorage.removeItem(feedKey); } catch {}
  } catch (err) {
    console.error('Reaction error:', err);
    // Revert optimistic update
    myReactionsCache[cacheKey] = prevCached;
    btnEl.classList.toggle('active', isActive);
    adjustReactionCount(btnEl, isActive ? 1 : -1);
    if (oldActiveBtn) { oldActiveBtn.classList.add('active'); adjustReactionCount(oldActiveBtn, 1); }
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
