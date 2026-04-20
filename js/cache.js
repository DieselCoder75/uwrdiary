// ============================================================
// LOCAL CACHE  (localStorage, keyed by uid)
// ============================================================
const Cache = {
  _key(uid, suffix) { return `uppis_${uid}_${suffix}`; },

  set(uid, suffix, data) {
    try {
      localStorage.setItem(this._key(uid, suffix), JSON.stringify({ ts: Date.now(), data }));
    } catch (e) { /* storage full — ignore */ }
  },

  get(uid, suffix) {
    try {
      const raw = localStorage.getItem(this._key(uid, suffix));
      return raw ? JSON.parse(raw).data : null;
    } catch { return null; }
  },

  // Returns a lightweight fingerprint of serialisable data for change detection
  fingerprint(data) {
    return JSON.stringify(data);
  },

  clear(uid) {
    Object.keys(localStorage)
      .filter(k => k.startsWith(`uppis_${uid}_`))
      .forEach(k => localStorage.removeItem(k));
  },
};
