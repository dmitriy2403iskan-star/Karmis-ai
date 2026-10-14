'use strict';
/* =====================================================================
   Кармис AI: постоянный ID установки (KA-XXXXX-XXXXX) в углу экрана.
   • Создаётся один раз при первом запуске и хранится на устройстве.
   • Ключ называется «karmisid.v1» (без префикса «karmis.»), поэтому «Стереть всё» в настройках его не трогает.
   • Рядом лежит секрет установки (его не видно и никуда не отправляется). Когда появится сервер
     (права админа, премиум), запрос подписывается секретом, и чужой ID подделать нельзя:
     window.karmisIdentity.sign(текст) → HMAC-SHA256 в hex.
   • Если стереть данные приложения или переустановить его без сохранения данных, ID будет новым.
   ===================================================================== */
(function () {
  const KEY = 'karmisid.v1';
  const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';          // 32 символа без 0/O/1/I: ровное распределение и без путаницы
  const ID_RE = /^KA-[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;
  const rnd = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; };

  function make() {
    const c = Array.from(rnd(10), x => ALPHA[x % 32]).join('');
    return {
      id: 'KA-' + c.slice(0, 5) + '-' + c.slice(5),
      secret: Array.from(rnd(32), x => x.toString(16).padStart(2, '0')).join(''),
      created: Date.now(),
    };
  }

  let ident = null;
  try { ident = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { ident = null; }
  if (!ident || !ID_RE.test(String(ident.id)) || !/^[0-9a-f]{64}$/.test(String(ident.secret))) {
    ident = make();
    try { localStorage.setItem(KEY, JSON.stringify(ident)); } catch { /* хранилище недоступно: ID будет жить до перезапуска */ }
  }

  window.karmisIdentity = Object.freeze({
    id: ident.id,
    created: ident.created,
    async sign(message) {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(ident.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(message)));
      return Array.from(new Uint8Array(sig), x => x.toString(16).padStart(2, '0')).join('');
    },
  });

  async function copyId() {
    try { await navigator.clipboard.writeText(ident.id); }
    catch {
      const t = document.createElement('textarea');
      t.value = ident.id; t.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(t);
      t.select(); try { document.execCommand('copy'); } catch { /* ignore */ } t.remove();
    }
    if (typeof toast === 'function') toast(T('id.copied'), 2500);
  }

  function mount() {
    const badge = document.createElement('div');
    badge.id = 'uidBadge';
    badge.textContent = ident.id;
    badge.title = T('id.copy');
    badge.onclick = copyId;
    document.body.appendChild(badge);

    const txt = document.getElementById('uidText'); if (txt) txt.textContent = ident.id;
    const btn = document.getElementById('btnUidCopy'); if (btn) btn.onclick = copyId;
    setInterval(() => { badge.title = T('id.copy'); }, 4000);   // подпись следует за языком
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
