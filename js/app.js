// ============================================================
// NAV TABS
// ============================================================
const TAB_TITLES = { treenit: 'Treenit', trendit: 'Trendit', joukkue: 'Joukkue' };

function setHeaderTabTitle(tab) {
  const t = el('header-tab-title');
  if (t) t.textContent = TAB_TITLES[tab] || tab;
}
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
    el('joukkue-sub-tabs').classList.toggle('hidden', tab !== 'joukkue');

    // FAB: näkyvissä vain Treenit/Loki -välilehdellä (ei impersonoinnin aikana)
    if (tab === 'treenit') {
      const activeSub = document.querySelector('#treenit-sub-tabs .sub-tab.active')?.dataset.subtab || 'loki';
      el('add-btn').classList.toggle('hidden', activeSub !== 'loki' || !!impersonating);
      if (activeSub === 'aicoach') renderAiCoachTab();
    } else {
      el('add-btn').classList.add('hidden');
    }

    if (tab === 'trendit') {
      const activeSub = document.querySelector('#trendit-sub-tabs .sub-tab.active')?.dataset.subtab || 'omat';
      if (activeSub === 'omat')     renderTrenditCharts();
      if (activeSub === 'vertailu') renderVertailuCharts();
      if (activeSub === 'kuorma')   renderKuormaTab();
    }
    if (tab === 'joukkue') renderJoukkueTab();
    setHeaderTabTitle(tab);
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
    const sub       = btn.dataset.subtab;
    const isTreeni  = !!btn.closest('#treenit-sub-tabs');
    const isJoukkue = !!btn.closest('#joukkue-sub-tabs');

    if (isTreeni) {
      el('subtab-loki').classList.toggle('hidden', sub !== 'loki');
      el('subtab-kalenteri').classList.toggle('hidden', sub !== 'kalenteri');
      el('subtab-aicoach').classList.toggle('hidden', sub !== 'aicoach');
      el('add-btn').classList.toggle('hidden', sub !== 'loki' || !!impersonating);
      if (sub === 'kalenteri') renderCalendarTab();
      if (sub === 'aicoach')   renderAiCoachTab();
    } else if (isJoukkue) {
      el('subtab-fiidi').classList.toggle('hidden', sub !== 'fiidi');
      el('subtab-tapahtumat').classList.toggle('hidden', sub !== 'tapahtumat');
      el('subtab-viikkoohje').classList.toggle('hidden', sub !== 'viikkoohje');
      if (sub === 'tapahtumat') renderTapahtumatTab();
      if (sub === 'viikkoohje') renderViikkoOhjeTab();
    } else {
      el('subtab-omat').classList.toggle('hidden', sub !== 'omat');
      el('subtab-vertailu').classList.toggle('hidden', sub !== 'vertailu');
      el('subtab-kuorma').classList.toggle('hidden', sub !== 'kuorma');
      if (sub === 'omat')     renderTrenditCharts();
      if (sub === 'vertailu') renderVertailuCharts();
      if (sub === 'kuorma')   renderKuormaTab();
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
// SWIPE NAVIGATION — sivujärjestys: Loki→Kalenteri→Omat→Vertailu→Kuorma→Fiidi→Tapahtumat
// ============================================================
const PAGES = [
  { tab: 'treenit', sub: 'loki' },
  { tab: 'treenit', sub: 'kalenteri' },
  { tab: 'treenit', sub: 'aicoach' },
  { tab: 'trendit', sub: 'omat' },
  { tab: 'trendit', sub: 'vertailu' },
  { tab: 'trendit', sub: 'kuorma' },
  { tab: 'joukkue', sub: 'fiidi' },
  { tab: 'joukkue', sub: 'viikkoohje' },
  { tab: 'joukkue', sub: 'tapahtumat' },
];

// Onko sivun ali-tab-nappi piilotettu (esim. admin-only AI Coach muilta)?
function pageBtnHidden(page) {
  const btn = document.querySelector(`#${page.tab}-sub-tabs [data-subtab="${page.sub}"]`);
  return !btn || btn.classList.contains('hidden');
}

// Seuraava NÄKYVÄ sivu suuntaan dir (+1 / -1), tai -1 jos ei löydy
function nextVisiblePageIndex(current, dir) {
  for (let i = current + dir; i >= 0 && i < PAGES.length; i += dir) {
    if (!pageBtnHidden(PAGES[i])) return i;
  }
  return -1;
}

// Takaisinyhteensopivuus (käytetään muualla)
const MAIN_TABS = ['treenit', 'trendit', 'joukkue'];

function getActivePageIndex() {
  const activeTab = document.querySelector('#app-view .nav-tab.active')?.dataset.tab || 'treenit';
  const subTabsId = activeTab + '-sub-tabs';
  const activeSub = document.querySelector(`#${subTabsId} .sub-tab.active`)?.dataset.subtab || '';
  const idx = PAGES.findIndex(p => p.tab === activeTab && p.sub === activeSub);
  return idx >= 0 ? idx : PAGES.findIndex(p => p.tab === activeTab);
}

function activatePageByIndex(index) {
  const page = PAGES[index];
  if (!page) return;
  const currentTab = document.querySelector('#app-view .nav-tab.active')?.dataset.tab;
  if (currentTab !== page.tab) {
    const tabBtn = document.querySelector(`#app-view [data-tab="${page.tab}"]`);
    if (tabBtn) tabBtn.click();
  }
  const subBtn = document.querySelector(`#${page.tab}-sub-tabs [data-subtab="${page.sub}"]`);
  if (subBtn) subBtn.click();
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
    moved = true;
  }, { passive: true });

  main.addEventListener('touchend', e => {
    if (!moved) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;

    // Must be primarily horizontal (2:1 ratio) and at least 55 px
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 2) return;

    const current = getActivePageIndex();
    const target  = nextVisiblePageIndex(current, dx < 0 ? 1 : -1);
    if (target >= 0) activatePageByIndex(target);
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
    const activeSub = document.querySelector('#joukkue-sub-tabs .sub-tab.active')?.dataset.subtab || 'fiidi';
    if (activeSub !== 'fiidi') return;
    if (joukkueLoadingPage) return;
    if (joukkueFeedRendered >= joukkueFeedItems.length) return;
    if (distFromBottom < 180) {
      joukkueLoadingPage = true;
      await appendJoukkuePage();
      joukkueLoadingPage = false;
    }
  }
}, { passive: true });

// ============================================================
// OFFLINE / ONLINE -tilanhallinta
// ============================================================
const PENDING_KEY = 'uppis_pending_count';

function getPendingCount() {
  return parseInt(localStorage.getItem(PENDING_KEY) || '0', 10);
}
function setPendingCount(n) {
  if (n <= 0) localStorage.removeItem(PENDING_KEY);
  else localStorage.setItem(PENDING_KEY, String(n));
}

function updateOfflineBanner(isOffline) {
  el('offline-banner')?.classList.toggle('hidden', !isOffline);
}

window.addEventListener('offline', () => {
  updateOfflineBanner(true);
});

window.addEventListener('online', () => {
  updateOfflineBanner(false);
  const count = getPendingCount();
  if (count > 0) {
    toast(`✅ Yhteys palautettu — ${count} ${count === 1 ? 'treenikirjaus' : 'treenikirjausta'} synkattu`, 'success');
    setPendingCount(0);
  }
});

// Tarkista tila heti käynnistyksessä
updateOfflineBanner(!navigator.onLine);
