// ============================================================
// HELPERS
// ============================================================
function show(id)  { document.getElementById(id).classList.remove('hidden'); }
function hide(id)  { document.getElementById(id).classList.add('hidden'); }
function el(id)    { return document.getElementById(id); }

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDisplayDate(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);

  // Local date key helpers
  const localKey = dt => `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
  const today     = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const dKey      = localKey(d);

  let dateStr;
  if (dKey === localKey(today))     dateStr = 'tänään';
  else if (dKey === localKey(yesterday)) dateStr = 'eilen';
  else dateStr = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;

  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (hasTime) {
    return dateStr + ' · ' + d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
  }
  return dateStr;
}

function starsHtml(n, total = 5) {
  const filled = Math.min(Math.max(Math.round(n), 0), total);
  return `<span class="stars-filled">${'★'.repeat(filled)}</span><span>${'★'.repeat(total - filled)}</span>`;
}

function timestampToDateStr(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  // Format as YYYY-MM-DD in local time
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

function timestampToTimeStr(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function checkHasTime(timestamp) {
  const d = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return d.getHours() !== 0 || d.getMinutes() !== 0;
}

function confirm(message) {
  return new Promise(resolve => {
    const dialog  = el('confirm-dialog');
    const msgEl   = dialog.querySelector('p');
    const okBtn   = el('confirm-ok');
    const cancelBtn = el('confirm-cancel');
    msgEl.textContent = message;
    dialog.classList.remove('hidden');
    function cleanup(result) {
      dialog.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// ============================================================
// DANGER CONFIRM DIALOG (requires typing a confirmation word)
// confirmWord defaults to 'Poista'; pass e.g. 'Korjaa' for maintenance actions
// ============================================================
function dangerConfirm(message, confirmWord = 'Poista') {
  return new Promise((resolve) => {
    el('danger-dialog-msg').textContent = message;
    el('danger-confirm-input').value = '';
    el('danger-confirm-input').placeholder = confirmWord;
    el('danger-confirm-hint-word').textContent = confirmWord;
    el('danger-ok').disabled = true;
    show('danger-dialog');
    setTimeout(() => el('danger-confirm-input').focus(), 100);

    function onInput() {
      el('danger-ok').disabled = el('danger-confirm-input').value.trim() !== confirmWord;
    }
    function onOk() {
      if (el('danger-confirm-input').value.trim() !== confirmWord) return;
      cleanup(true);
    }
    function onCancel() { cleanup(false); }
    function cleanup(result) {
      hide('danger-dialog');
      el('danger-confirm-input').removeEventListener('input', onInput);
      el('danger-ok').removeEventListener('click', onOk);
      el('danger-cancel').removeEventListener('click', onCancel);
      resolve(result);
    }
    el('danger-confirm-input').addEventListener('input', onInput);
    el('danger-ok').addEventListener('click', onOk);
    el('danger-cancel').addEventListener('click', onCancel);
  });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================
function toast(message, type = 'error') {
  // Remove any existing toast
  document.querySelector('.toast-notification')?.remove();

  const t = document.createElement('div');
  t.className = `toast-notification toast-${type}`;
  t.textContent = message;
  document.body.appendChild(t);

  // Animate in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => t.classList.add('toast-visible'));
  });

  // Auto-dismiss after 3.5s
  const timer = setTimeout(dismissToast, 3500);
  t.addEventListener('click', () => { clearTimeout(timer); dismissToast(); });

  function dismissToast() {
    t.classList.remove('toast-visible');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  }
}
