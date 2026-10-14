'use strict';
/* =====================================================================
   Кармис AI для Android: керування телефоном і міні-вікно поверх додатків.
   Нативна частина: scripts/android-src (KarmisPhonePlugin, KarmisAccessibilityService, PhoneOverlayService).
   Тут два адаптери з тим самим інтерфейсом, що й у Windows-версії:
     window.__phonePc   — «pcApi» для computer.js (екран текстом, тап, свайп, ввід, кнопки)
     window.__phoneMini — «mini» для mini-bridge.js (міні-вікно)
   Тож уся логіка (режими «Авто / текст / знімки», моделі з зором, ключі, підтвердження) спільна з комп'ютерною.
   Підключається ПЕРЕД computer.js і mini-bridge.js.
   ===================================================================== */
(function () {
  const Cap = window.Capacitor;
  const P = Cap && Cap.Plugins && Cap.Plugins.KarmisPhone;
  if (!(Cap && Cap.isNativePlatform && Cap.isNativePlatform()) || !P) return;

  window.__phoneTexts = null; // заповнюється в phone-texts.js (після computer.js, щоб перекрити його тексти)
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tt = (k, v) => (typeof T === 'function' ? T(k, v) : k);
  const errText = e => {
    const m = String((e && e.message) || e || '?');
    return m === 'a11y_off' ? tt('ph.needA11y') : m;
  };
  let lastShot = null;      // простір координат останнього стану екрана: { w, h, sw, sh }
  let stopCb = null;
  let session = false;

  const map = (x, y) => {
    if (!lastShot) throw new Error('Спочатку потрібен стан екрана (pc_look)');
    x = Number(x); y = Number(y);
    if (!isFinite(x) || !isFinite(y)) throw new Error('Некоректні координати');
    return [Math.round(x * lastShot.sw / lastShot.w), Math.round(y * lastShot.sh / lastShot.h)];
  };
  const wrap = fn => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, error: errText(e) }; } };

  /* ---- керування телефоном (інтерфейс pcApi) ---- */
  window.__phonePc = {
    info: async () => ({ ok: true, platform: 'android' }),
    warmup: async () => true,
    onStopped: cb => { stopCb = cb; },
    window: async mode => { try { if (mode === 'show') await P.toFront(); else if (mode === 'hide') await P.toBack(); } catch { /* ignore */ } return { ok: true }; },
    status: desc => { try { P.overlayPush({ json: JSON.stringify({ type: 'state', st: { live: String(desc || '').slice(0, 80) } }) }); } catch { /* ignore */ } },

    start: wrap(async () => {
      const s = await P.status();
      if (!s.a11y) { try { await P.openAccessibilitySettings(); } catch { /* ignore */ } return { ok: false, error: tt('ph.needA11y') }; }
      await P.overlayOpen({ control: true });          // сповіщення «Стоп» (+ міні-вікно, якщо дозволено поверх вікон)
      await sleep(350);
      await P.act({ op: 'key', keys: 'home' });         // виходимо з Кармиса на головний екран
      await sleep(600);
      session = true;
      return { ok: true, hotkey: null, overlay: !!s.overlay };
    }),
    stop: wrap(async () => {
      const was = session;
      session = false;
      if (was) { try { await P.overlayOpen({ control: false }); } catch { /* оновлює сповіщення: керування завершено */ } }
      return { ok: true };
    }),

    /* стан екрана: текст (служба доступності) і/або знімок. Координати в тексті = простір знімка, якщо він є, інакше пікселі екрана */
    observe: wrap(async (o) => {
      o = o || {};
      const mode = ['text', 'auto', 'both', 'image'].includes(o.image) ? o.image : 'auto';
      let text = null, scanErr = '', count = 0, sw = 0, sh = 0;
      if (mode !== 'image') {
        try { const r = await P.scan({ max: 90 }); text = r.text; count = r.count; sw = r.w; sh = r.h; }
        catch (e) { scanErr = errText(e).slice(0, 160); if (String(e && e.message) === 'a11y_off') throw e; }
      }
      const res = { ok: true, count, scanErr };
      if (mode === 'image' || mode === 'both' || (mode === 'auto' && count < 6)) {
        try {
          const s = await P.shot({ maxW: 720, quality: 60 });
          res.image = { mime: s.mime, b64: s.b64 }; res.w = s.w; res.h = s.h; sw = s.sw; sh = s.sh;
          lastShot = { w: s.w, h: s.h, sw: s.sw, sh: s.sh };
        } catch (e) { if (mode === 'image') throw e; /* без знімка (Android < 11): лишається текст */ }
      }
      if (!res.image) {
        if (!sw) { const st = await P.status(); sw = st.w || 1080; sh = st.h || 2400; }
        lastShot = { w: sw, h: sh, sw, sh }; res.w = sw; res.h = sh;
      }
      if (text) {
        if (res.w !== sw) {
          const k = res.w / sw;
          text = text.replace(/^(\d+ \S+ )@(\d+),(\d+)/gm, (m, a, x, y) => a + '@' + Math.round(x * k) + ',' + Math.round(y * k));
        }
        res.text = text.trim();
      }
      return res;
    }),
    screenshot: wrap(async () => {
      const s = await P.shot({ maxW: 720, quality: 60 });
      lastShot = { w: s.w, h: s.h, sw: s.sw, sh: s.sh };
      return s;
    }),

    mouse: wrap(async o => {
      const op = o.op;
      if (op === 'move') return { ok: true };
      if (op === 'scroll') {
        const a = { op: 'scroll', amount: o.amount, horizontal: !!o.horizontal };
        if (o.x != null && o.y != null) { const [x, y] = map(o.x, o.y); a.x = x; a.y = y; }
        return P.act(a);
      }
      const [x, y] = map(o.x, o.y);
      if (op === 'drag') { const [x2, y2] = map(o.x2, o.y2); return P.act({ op: 'swipe', x, y, x2, y2, ms: 500 }); }
      return P.act({ op: op === 'double' ? 'double' : op === 'right' ? 'long' : 'tap', x, y });
    }),
    type: wrap(text => P.act({ op: 'type', text: String(text) })),
    key: wrap(async keys => {
      const parts = String(keys).split(/\s*,\s*|\s+/).filter(Boolean);   // «back home» → послідовно
      for (const k of parts) { await P.act({ op: 'key', keys: k }); await sleep(250); }
      return { ok: true };
    }),
    clipRead: wrap(async () => { const r = await P.act({ op: 'clipRead' }); return { ok: true, text: (r && r.text) || '' }; }),
    clipWrite: wrap(text => P.act({ op: 'clipWrite', text: String(text) })),

    selftest: wrap(async () => {
      const s = await P.status();
      const lines = [s.a11y ? tt('ph.a11yOk') : tt('ph.a11yOff'), s.overlay ? tt('ph.overlayOk') : tt('ph.overlayOff')];
      if (!s.a11y) return { ok: false, error: lines.join(' · ') };
      const r = await P.scan({ max: 40 });
      return { ok: true, screen: `${r.w}×${r.h}`, cursor: '—', clipboard: '—', uia: r.count + ' ел.' + (s.overlay ? '' : ' · ' + tt('ph.overlayOff')) };
    }),
  };

  /* ---- міні-вікно поверх додатків (інтерфейс mini) ---- */
  const miniCbs = { cmd: [], closed: [] };
  try {
    P.addListener('overlayCmd', e => {
      if (e && (e.type === 'stop' || e.type === 'close') && session && stopCb) { session = false; stopCb('user'); }
      miniCbs.cmd.forEach(cb => cb(e));
    });
    P.addListener('overlayClosed', () => miniCbs.closed.forEach(cb => cb()));
  } catch { /* старий плагін без подій */ }

  window.__phoneMini = {
    open: async o => {
      const s = await P.status();
      if (!s.overlay) { try { if (typeof toast === 'function') toast(tt('ph.needOverlay'), 6000); await P.requestOverlay(); } catch { /* ignore */ } return false; }
      await P.overlayOpen({ control: false });
      if (o && o.minimizeMain) { await sleep(450); try { await P.toBack(); } catch { /* ignore */ } }
      return true;
    },
    close: async () => { try { await P.overlayClose(); } catch { /* ignore */ } },
    push: evt => { try { P.overlayPush({ json: JSON.stringify(evt) }); } catch { /* ignore */ } },
    onCmd: cb => { miniCbs.cmd.push(cb); },
    onClosed: cb => { miniCbs.closed.push(cb); },
  };
})();
