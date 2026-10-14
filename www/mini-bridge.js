'use strict';
/* =====================================================================
   Кармис AI — міст до міні-вікна (mini-bridge.js)
   Міні-вікно (mini.html) відкривається ТІЛЬКИ кнопкою «Міні-вікно» в застосунку.
   Закриття головного вікна його не викликає.
   Тут: копіюємо в міні-вікно повідомлення й стан, а його команди
   (текст, голосове керування, озвучка) виконуємо тут, у головному вікні.
   Працює лише у Windows-застосунку (window.karmis.mini).
   Підключається після app.js.
   ===================================================================== */
(function () {
  const api = (window.karmis && window.karmis.mini) || window.__phoneMini;
  if (!api) { const b = document.getElementById('btnMini'); if (b) b.hidden = true; return; }

  Object.assign(I18N.ru, {
    'mini.open': 'Мини-окно', 'mini.ph': 'Напиши Кармису…', 'mini.expand': 'Развернуть', 'mini.close': 'Закрыть мини-окно',
    'mini.ear': 'Голосовое управление (слово-активатор)', 'mini.mic': 'Одна голосовая команда', 'mini.timer5': 'Таймер 5 мин', 'mini.timer5Q': 'Таймер на 5 минут',
  });
  Object.assign(I18N.uk, {
    'mini.open': 'Міні-вікно', 'mini.ph': 'Напиши Кармису…', 'mini.expand': 'Розгорнути', 'mini.close': 'Закрити міні-вікно',
    'mini.ear': 'Голосове керування (слово-активатор)', 'mini.mic': 'Одна голосова команда', 'mini.timer5': 'Таймер 5 хв', 'mini.timer5Q': 'Таймер на 5 хвилин',
  });
  Object.assign(I18N.be, {
    'mini.open': 'Міні-акно', 'mini.ph': 'Напішы Кармісу…', 'mini.expand': 'Разгарнуць', 'mini.close': 'Закрыць міні-акно',
    'mini.ear': 'Галасавое кіраванне (слова-актывацыя)', 'mini.mic': 'Адна галасавая каманда', 'mini.timer5': 'Таймер 5 хв', 'mini.timer5Q': 'Таймер на 5 хвілін',
  });
  Object.assign(I18N.en, {
    'mini.open': 'Mini window', 'mini.ph': 'Message Karmis…', 'mini.expand': 'Expand', 'mini.close': 'Close mini window',
    'mini.ear': 'Voice control (wake word)', 'mini.mic': 'One voice command', 'mini.timer5': 'Timer 5 min', 'mini.timer5Q': 'Set a timer for 5 minutes',
  });

  const log = [];                       // останні повідомлення, щоб міні-вікно показало історію при відкритті
  const keep = e => { log.push(e); if (log.length > 40) log.shift(); };
  let isTyping = false;
  const push = e => { try { api.push(e); } catch { /* вікно закрите */ } };

  function stateObj() {
    const live = document.getElementById('liveText');
    return {
      status: (document.getElementById('statusText') || {}).textContent || '',
      dataState: document.body.dataset.state || 'idle',
      listen: !!(typeof listen !== 'undefined' && listen.on),
      mic: typeof recording !== 'undefined' && !!recording,
      tts: !!state.cfg.tts,
      live: live && !live.hidden ? live.textContent : '',
    };
  }
  const pushState = () => push({ type: 'state', st: stateObj() });
  function labels() {
    return {
      lang: state.cfg.lang, ph: T('mini.ph'), ear: T('mini.ear'), mute: T('top.mute'), expand: T('mini.expand'), close: T('mini.close'),
      mic: T('mini.mic'), stop: T('top.orb'),
      chips: [
        { label: T('q.weather'), text: T('q.weatherQ') },
        { label: T('q.joke'), text: T('q.jokeQ') },
        { label: T('q.time'), text: T('q.timeQ') },
        { label: T('mini.timer5'), text: T('mini.timer5Q') },
      ].filter(c => c.text && !c.text.endsWith(' ')),
    };
  }

  /* --- копіюємо вихід головного вікна --- */
  const wrap = (name, fn) => { const orig = window[name]; if (typeof orig !== 'function') return; window[name] = function (...a) { const r = orig.apply(this, a); try { fn(a, r); } catch { /* не критично */ } return r; }; };

  wrap('addMsg', ([role, text]) => { if (!text) return; keep({ kind: role, text: String(text) }); push({ type: 'msg', role, text: String(text) }); });
  wrap('addAct', ([text, kind]) => { keep({ kind: 'act', text: String(text), k: kind || '' }); push({ type: 'act', text: String(text), kind: kind || '' }); });
  wrap('addCard', ([c]) => {
    const lines = [c.title, c.sub, ...(c.rows || []).map(([k, v]) => k + ': ' + v), ...(c.days || []).map(d => `${d.title}: ${d.big} ${d.small || ''}`.trim())].filter(Boolean);
    const text = lines.join('\n'); keep({ kind: 'assistant', text }); push({ type: 'msg', role: 'assistant', text });
  });
  wrap('showTyping', () => { isTyping = true; push({ type: 'typing', on: true }); });
  wrap('hideTyping', () => { isTyping = false; push({ type: 'typing', on: false }); });
  /* історія перемальовується (мова, очищення чату) — скидаємо копію й оновлюємо міні-вікно */
  const origRH = window.renderHistory;
  if (typeof origRH === 'function') window.renderHistory = function (...a) { log.length = 0; return origRH.apply(this, a); };
  wrap('clearChat', () => { log.length = 0; push({ type: 'init', labels: labels(), log: [], st: stateObj(), typing: false }); });
  ['refreshState', 'syncListenUI', 'syncSettingsUI', 'setLive'].forEach(n => wrap(n, pushState));
  if (!window.__phoneMini) window.addEventListener('beforeunload', () => { try { api.close(); } catch { /* ignore */ } });

  /* --- команди з міні-вікна --- */
  api.onCmd(c => {
    if (!c) return;
    if (c.type === 'ready') { push({ type: 'init', labels: labels(), log: log.slice(), st: stateObj(), typing: isTyping }); return; }
    if (c.type === 'send') { if (c.text) submitText(c.text); return; }
    if (c.type === 'listen') { toggleListening(); return; }                       // вмикає / вимикає голосове керування
    if (c.type === 'mic') { toggleMic(); return; }
    if (c.type === 'mute') { const b = document.getElementById('btnMute'); if (b) b.click(); return; }
    if (c.type === 'expand' || c.type === 'close') return;    // Android: міні-вікно саме відкриває додаток / закривається
    if (c.type === 'stop') { const o = document.getElementById('miniOrb'); if (o) o.click(); return; }
  });

  /* --- кнопка в головному вікні --- */
  const btn = document.getElementById('btnMini');
  if (btn) { btn.title = T('mini.open'); btn.onclick = () => api.open({ minimizeMain: true }); }
  const oldApply = window.applyI18n;
  if (typeof oldApply === 'function') window.applyI18n = function (...a) { const r = oldApply.apply(this, a); if (btn) btn.title = T('mini.open'); return r; };
})();
