// ============================================================
// NAV TABS
// ============================================================
// Lock window scroll when Trendit content fits in viewport; unlock otherwise
function updateTrenditScroll() {
  const activeTab = document.querySelector('#app-view .nav-tab.active')?.dataset.tab;
  if (activeTab !== 'trendit') {
    document.body.style.overflow = '';
    return;
  }
  // Small delay so charts have time to render before measuring
  setTimeout(() => {
    const fits = document.documentElement.scrollHeight <= window.innerHeight + 2;
    document.body.style.overflow = fits ? 'hidden' : '';
  }, 50);
}

document.querySelectorAll('#app-view .nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#app-view .nav-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('#app-view .tab-content').forEach(c => c.classList.add('hidden'));
    el('tab-' + tab).classList.remove('hidden');

    // Sub-tabs: näytä oikea setti per välilehti
    el('treenit-sub-tabs').classList.toggle('hidden', tab !== 'treenit');
    el('trendit-sub-tabs').classList.toggle('hidden', tab !== 'trendit');

    // FAB: näkyvissä Treenit/Loki -välilehdellä (ei impersonoinnin aikana)
    if (tab === 'treenit') {
      const activeSub = document.querySelector('#treenit-sub-tabs .sub-tab.active')?.dataset.subtab || 'loki';
      el('add-btn').classList.toggle('hidden', activeSub === 'kalenteri' || !!impersonating);
    } else {
      el('add-btn').classList.add('hidden');
    }

    if (tab === 'trendit') {
      const activeSub = document.querySelector('#trendit-sub-tabs .sub-tab.active')?.dataset.subtab || 'omat';
      if (activeSub === 'omat')     renderTrenditCharts();
      if (activeSub === 'vertailu') renderVertailuCharts();
    }
    if (tab === 'joukkue') renderJoukkueTab();
    updateTrenditScroll();
  });
});

// ============================================================
// SUB-TABS (Treenit → Loki / Kalenteri  |  Trendit → Omat / Vertailu)
// ============================================================
document.querySelectorAll('.sub-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    // Deaktivoi vain saman containerin sub-tabsit
    btn.closest('.sub-tabs').querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const sub      = btn.dataset.subtab;
    const isTreeni = !!btn.closest('#treenit-sub-tabs');

    if (isTreeni) {
      el('subtab-loki').classList.toggle('hidden', sub !== 'loki');
      el('subtab-kalenteri').classList.toggle('hidden', sub !== 'kalenteri');
      el('add-btn').classList.toggle('hidden', sub !== 'loki' || !!impersonating);
      if (sub === 'kalenteri') renderCalendarTab();
    } else {
      el('subtab-omat').classList.toggle('hidden', sub !== 'omat');
      el('subtab-vertailu').classList.toggle('hidden', sub !== 'vertailu');
      if (sub === 'omat')     renderTrenditCharts();
      if (sub === 'vertailu') renderVertailuCharts();
      updateTrenditScroll();
    }
  });
});

window.addEventListener('resize', updateTrenditScroll, { passive: true });

el('refresh-btn').addEventListener('click', fetchEntries);
el('joukkue-refresh-btn').addEventListener('click', () => renderJoukkueTab(true));

// Re-fetch when user returns to app (both tabs)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentUser) {
    const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
    if (activeTab === 'treenit') fetchEntries();
    if (activeTab === 'joukkue') renderJoukkueTab(); // respects TTL cache
  }
});

// ============================================================
// SWIPE NAVIGATION — swipe left/right to switch main tabs
// ============================================================
const MAIN_TABS = ['treenit', 'trendit', 'joukkue'];

function getActiveTabIndex() {
  const active = document.querySelector('#app-view .nav-tab.active');
  return active ? MAIN_TABS.indexOf(active.dataset.tab) : 0;
}

function activateTabByIndex(index) {
  const btn = document.querySelector(`#app-view [data-tab="${MAIN_TABS[index]}"]`);
  if (btn) btn.click();
}

(function initSwipe() {
  const main = document.querySelector('#app-view main');
  let startX = 0, startY = 0, moved = false;

  main.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    moved  = false;
  }, { passive: true });

  main.addEventListener('touchmove', e => {
    // Mark as moved so we can detect scroll vs swipe
    moved = true;
  }, { passive: true });

  main.addEventListener('touchend', e => {
    if (!moved) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    // Must be primarily horizontal (2:1 ratio) and at least 55 px
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 2) return;

    const current = getActiveTabIndex();
    if (dx < 0 && current < MAIN_TABS.length - 1) activateTabByIndex(current + 1); // ← vasen
    if (dx > 0 && current > 0)                     activateTabByIndex(current - 1); // → oikea
  }, { passive: true });
})();

// ============================================================
// COMBINED SCROLL LISTENER — Treenit + Joukkue infinite scroll
// ============================================================
window.addEventListener('scroll', async () => {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  const distFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;

  if (activeTab === 'treenit') {
    const activeSub = document.querySelector('#treenit-sub-tabs .sub-tab.active')?.dataset.subtab || 'loki';
    if (activeSub === 'loki') {
      if (!hasMorePages) return;
      if (distFromBottom < 120) {
        const btn = el('load-more-btn');
        if (!btn.classList.contains('hidden') && !btn.disabled) btn.click();
      }
    } else if (activeSub === 'kalenteri') {
      if (distFromBottom < 200) appendCalendarMonth();
    }
  }

  if (activeTab === 'joukkue') {
    if (joukkueLoadingPage) return;
    if (joukkueFeedRendered >= joukkueFeedItems.length) return;
    if (distFromBottom < 180) {
      joukkueLoadingPage = true;
      await appendJoukkuePage();
      joukkueLoadingPage = false;
    }
  }
}, { passive: true });
