// ============================================================
// NAV TABS
// ============================================================
document.querySelectorAll('.nav-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    el('tab-' + tab).classList.remove('hidden');
    // FAB only on treenit
    el('add-btn').classList.toggle('hidden', tab !== 'treenit');
    if (tab === 'vertailu') renderVertailuCharts();
    if (tab === 'trendit')  renderTrenditCharts();
    if (tab === 'joukkue')  renderJoukkueTab();
  });
});

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
// COMBINED SCROLL LISTENER — Treenit + Joukkue infinite scroll
// ============================================================
window.addEventListener('scroll', async () => {
  const activeTab = document.querySelector('.nav-tab.active')?.dataset.tab;
  const distFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;

  if (activeTab === 'treenit') {
    if (!hasMorePages) return;
    if (distFromBottom < 120) {
      const btn = el('load-more-btn');
      if (!btn.classList.contains('hidden') && !btn.disabled) btn.click();
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
