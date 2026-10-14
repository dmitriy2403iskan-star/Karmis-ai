'use strict';
/* Кармис AI — визуальные эффекты: конфетти, салют, снег, сердечки, «матрица» и живой фон со звёздами. */
const FX = (() => {
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let cv, cx, W = 0, H = 0, dpr = 1, raf = 0, last = 0, keep = false;
  const active = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const accent = () => (getComputedStyle(document.body).getPropertyValue('--accent') || '#46e0ff').trim();
  const accent2 = () => (getComputedStyle(document.body).getPropertyValue('--accent-2') || '#8b6cff').trim();
  const PALETTE = () => [accent(), accent2(), '#ffd84d', '#ff6b9d', '#3ddc97', '#ffffff'];

  function mk(id, z) {
    const c = document.createElement('canvas');
    c.id = id;
    c.style.cssText = `position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:${z}`;
    c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    return c;
  }
  function size(c) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); }
  function resize() { dpr = Math.min(window.devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; if (cv) size(cv); if (bg) size(bg); }
  function ensure() { if (cv) return; cv = mk('fxCanvas', 9999); cx = cv.getContext('2d'); resize(); }
  addEventListener('resize', resize);

  function loop(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
    if (!keep) cx.clearRect(0, 0, W, H);
    for (let i = active.length - 1; i >= 0; i--) if (active[i](dt, t) === false) active.splice(i, 1);
    if (active.length) raf = requestAnimationFrame(loop);
    else { raf = 0; cx.clearRect(0, 0, W, H); }
  }
  function add(fn) { ensure(); active.push(fn); if (!raf) { last = performance.now(); raf = requestAnimationFrame(loop); } }

  const E = {
    confetti() {
      const cols = PALETTE(), ps = [];
      for (let k = 0; k < 2; k++) for (let i = 0; i < 90; i++) {
        const a = -Math.PI / 2 + (k ? -1 : 1) * rnd(0.1, 0.7), v = rnd(500, 1000);
        ps.push({ x: k ? W : 0, y: H, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: rnd(6, 11), h: rnd(3, 6), r: rnd(0, 6), vr: rnd(-12, 12), c: cols[i % cols.length] });
      }
      let age = 0;
      add(dt => {
        age += dt;
        for (const p of ps) {
          p.vy += 900 * dt; p.vx *= 0.992; p.vy *= 0.992; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
          cx.save(); cx.globalAlpha = Math.max(0, Math.min(1, 5.2 - age)); cx.translate(p.x, p.y); cx.rotate(p.r);
          cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); cx.restore();
        }
        return age < 5;
      });
    },
    fireworks() {
      const cols = PALETTE(), rockets = [], sparks = [];
      let age = 0, next = 0;
      add(dt => {
        age += dt; next -= dt;
        if (age < 4 && next <= 0) { next = rnd(0.25, 0.55); rockets.push({ x: rnd(W * .15, W * .85), y: H, ty: rnd(H * .15, H * .5), c: cols[Math.floor(rnd(0, cols.length))] }); }
        for (let i = rockets.length - 1; i >= 0; i--) {
          const r = rockets[i]; r.y -= 700 * dt;
          cx.fillStyle = r.c; cx.fillRect(r.x - 1.5, r.y, 3, 10);
          if (r.y <= r.ty) {
            for (let j = 0; j < 70; j++) { const a = rnd(0, 6.283), v = rnd(60, 340); sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, l: 1, c: r.c }); }
            rockets.splice(i, 1);
          }
        }
        for (let i = sparks.length - 1; i >= 0; i--) {
          const s = sparks[i]; s.vy += 220 * dt; s.vx *= 0.985; s.x += s.vx * dt; s.y += s.vy * dt; s.l -= dt * 0.7;
          if (s.l <= 0) { sparks.splice(i, 1); continue; }
          cx.globalAlpha = s.l; cx.fillStyle = s.c; cx.beginPath(); cx.arc(s.x, s.y, 2.2, 0, 6.283); cx.fill();
        }
        cx.globalAlpha = 1;
        return age < 4 || sparks.length > 0;
      });
    },
    snow() {
      const fl = Array.from({ length: 130 }, () => ({ x: rnd(0, W), y: rnd(-H, 0), r: rnd(1.5, 4), v: rnd(40, 120), ph: rnd(0, 6) }));
      let age = 0;
      add(dt => {
        age += dt;
        cx.fillStyle = '#fff';
        for (const f of fl) {
          f.y += f.v * dt; f.x += Math.sin(age * 1.4 + f.ph) * 30 * dt;
          if (f.y > H + 6) { f.y = -6; f.x = rnd(0, W); }
          cx.globalAlpha = Math.max(0, Math.min(0.9, 8.5 - age)) * (0.5 + f.r / 8);
          cx.beginPath(); cx.arc(f.x, f.y, f.r, 0, 6.283); cx.fill();
        }
        cx.globalAlpha = 1;
        return age < 8.5;
      });
    },
    hearts() {
      const hs = Array.from({ length: 36 }, () => ({ x: rnd(0, W), y: H + rnd(0, H * .6), s: rnd(18, 44), v: rnd(90, 190), ph: rnd(0, 6), e: Math.random() < .25 ? '💖' : '❤️' }));
      let age = 0;
      add(dt => {
        age += dt;
        for (const h of hs) {
          h.y -= h.v * dt; const x = h.x + Math.sin(age * 2 + h.ph) * 22;
          cx.globalAlpha = Math.max(0, Math.min(1, 5.5 - age, h.y / 120 + 0.3));
          cx.font = `${h.s}px serif`; cx.fillText(h.e, x, h.y);
        }
        cx.globalAlpha = 1;
        return age < 5.5;
      });
    },
    matrix() {
      const fs = 16, cols = Math.ceil(W / fs), drops = Array.from({ length: cols }, () => rnd(-40, 0));
      const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ｱｲｳｴｵ', col = accent();
      let age = 0, acc = 0;
      keep = true; cx.clearRect(0, 0, W, H);
      add(dt => {
        age += dt; acc += dt;
        cx.fillStyle = 'rgba(2,6,10,0.28)'; cx.fillRect(0, 0, W, H);
        if (acc > 0.045) {
          acc = 0; cx.font = fs + 'px monospace';
          drops.forEach((d, i) => {
            cx.fillStyle = Math.random() < 0.06 ? '#fff' : col;
            cx.fillText(chars[Math.floor(Math.random() * chars.length)], i * fs, d * fs);
            drops[i] = d * fs > H && Math.random() > 0.975 ? 0 : d + 1;
          });
        }
        if (age > 5.2) { cv.style.opacity = String(Math.max(0, 1 - (age - 5.2) / 1.2)); }
        if (age >= 6.4) { keep = false; cx.clearRect(0, 0, W, H); cv.style.opacity = '1'; return false; }
        return true;
      });
    },
    /* пасхалка «Джарвис, где бургеры»: бургеры скачут по экрану и отражаются от краёв (12 секунд, как мелодия) */
    burgers() {
      const N = Math.max(10, Math.min(22, Math.round(W * H / 45000)));
      const bs = Array.from({ length: N }, (_, i) => {
        const a = rnd(0, 6.283), v = rnd(220, 520);
        return { x: rnd(60, Math.max(61, W - 60)), y: rnd(60, Math.max(61, H - 60)), vx: Math.cos(a) * v, vy: Math.sin(a) * v, s: rnd(38, 88), r: rnd(0, 6.283), vr: rnd(-4, 4), t0: i * 0.12 };
      });
      let age = 0;
      add(dt => {
        age += dt;
        cx.textAlign = 'center'; cx.textBaseline = 'middle';
        for (const b of bs) {
          if (age < b.t0) continue;
          b.x += b.vx * dt; b.y += b.vy * dt; b.r += b.vr * dt;
          const h = b.s / 2;
          if (b.x < h) { b.x = h; b.vx = Math.abs(b.vx); } else if (b.x > W - h) { b.x = W - h; b.vx = -Math.abs(b.vx); }
          if (b.y < h) { b.y = h; b.vy = Math.abs(b.vy); } else if (b.y > H - h) { b.y = H - h; b.vy = -Math.abs(b.vy); }
          cx.save(); cx.globalAlpha = Math.max(0, Math.min(1, 12.8 - age, (age - b.t0) * 4));
          cx.translate(b.x, b.y); cx.rotate(b.r); cx.font = `${b.s}px serif`; cx.fillText('\u{1F354}', 0, 0); cx.restore();
        }
        return age < 12.8;
      });
    },
  };
  const names = Object.keys(E);

  function play(name) {
    if (!E[name]) return false;
    if (reduce) return true;
    ensure(); cv.style.opacity = '1';
    E[name]();
    return true;
  }

  /* ---- живой фон: мерцающие звёзды ---- */
  let bg, bx, stars = [], bgRaf = 0, bgOn = false, bgLast = 0;
  function bgLoop(t) {
    if (!bgOn) { bgRaf = 0; return; }
    bgRaf = requestAnimationFrame(bgLoop);
    if (document.hidden || t - bgLast < 33) return; // ~30 кадров в секунду, чтобы не грузить батарею
    const dt = (t - bgLast) / 1000; bgLast = t;
    bx.clearRect(0, 0, W, H);
    const col = accent();
    for (const s of stars) {
      s.y -= s.v * dt; if (s.y < -4) { s.y = H + 4; s.x = rnd(0, W); }
      const a = 0.25 + 0.35 * Math.sin(t / 1000 * s.f + s.ph);
      bx.globalAlpha = Math.max(0.04, a); bx.fillStyle = s.k ? col : '#fff';
      bx.beginPath(); bx.arc(s.x, s.y, s.r, 0, 6.283); bx.fill();
    }
    bx.globalAlpha = 1;
  }
  function ambient(on) {
    on = !!on && !reduce; bgOn = on;
    if (on) {
      if (!bg) { bg = mk('bgCanvas', -1); bx = bg.getContext('2d'); resize(); }
      bg.style.display = '';
      const n = Math.max(30, Math.min(80, Math.round(W * H / 18000)));
      stars = Array.from({ length: n }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(0.6, 1.8), v: rnd(2, 10), f: rnd(0.6, 2), ph: rnd(0, 6), k: Math.random() < 0.3 }));
      if (!bgRaf) bgRaf = requestAnimationFrame(bgLoop);
    } else if (bg) { bg.style.display = 'none'; }
  }

  /* ---- пасхалка: оригинальная 8-битная мелодия, собранная прямо в WebAudio (без файлов и чужой музыки) ---- */
  function burgerTune() {
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return { duration: 0, stop() {} }; }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const BPM = 120, STEP = 60 / BPM / 4, BARS = 6, DUR = BARS * 16 * STEP;     // 6 тактов = 12 секунд
    const t0 = ctx.currentTime + 0.08;
    const master = ctx.createGain(); master.connect(ctx.destination);
    master.gain.setValueAtTime(0.22, t0); master.gain.setValueAtTime(0.22, t0 + DUR - 0.5); master.gain.linearRampToValueAtTime(0.0001, t0 + DUR);
    const hz = m => 440 * Math.pow(2, (m - 69) / 12);
    const env = (g, s, e, vol) => { g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(vol, s + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, Math.max(e, s + 0.03)); };
    const note = (type, m, at, len, vol, cutoff) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      const s = t0 + at * STEP, e = s + len * STEP;
      o.type = type; o.frequency.value = hz(m); f.type = 'lowpass'; f.frequency.value = cutoff;
      env(g, s, e, vol); o.connect(f); f.connect(g); g.connect(master); o.start(s); o.stop(e + 0.05);
    };
    const nb = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const noise = (at, len, vol, hp) => {
      const src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      const s = t0 + at * STEP; src.buffer = nb; f.type = 'highpass'; f.frequency.value = hp;
      env(g, s, s + len, vol); src.connect(f); f.connect(g); g.connect(master); src.start(s); src.stop(s + len + 0.05);
    };
    const kick = at => {
      const o = ctx.createOscillator(), g = ctx.createGain(), s = t0 + at * STEP;
      o.type = 'sine'; o.frequency.setValueAtTime(150, s); o.frequency.exponentialRampToValueAtTime(45, s + 0.12);
      env(g, s, s + 0.2, 0.9); o.connect(g); g.connect(master); o.start(s); o.stop(s + 0.25);
    };
    const ROOT = [45, 45, 41, 43, 45, 45];                                       // A, A, F, G, A, A
    const LEAD = [
      [],
      [[0, 76, 2], [2, 74, 2], [4, 72, 2], [6, 74, 2], [8, 76, 4], [12, 72, 2], [14, 69, 2]],
      [[0, 76, 2], [2, 79, 2], [4, 76, 2], [6, 74, 2], [8, 72, 4], [12, 74, 2], [14, 76, 2]],
      [[0, 77, 2], [2, 76, 2], [4, 72, 2], [6, 69, 2], [8, 72, 4], [12, 74, 2], [14, 72, 2]],
      [[0, 79, 2], [2, 76, 2], [4, 74, 2], [6, 71, 2], [8, 74, 4], [12, 76, 2], [14, 79, 2]],
      [[0, 81, 8]],
    ];
    for (let b = 0; b < BARS; b++) {
      const o = b * 16, r = ROOT[b];
      [0, 3, 6, 8, 10, 12, 14].forEach((st, i) => note('sawtooth', r + [0, 0, 12, 0, 7, 0, 12][i], o + st, 2, 0.5, 500));
      [0, 6, 8, 10].forEach(st => kick(o + st));
      [4, 12].forEach(st => noise(o + st, 0.12, 0.35, 1200));
      for (let st = 0; st < 16; st += 2) noise(o + st, 0.04, 0.12, 6000);
      LEAD[b].forEach(([st, m, len]) => note('square', m, o + st, len, 0.16, 3200));
    }
    let done = false;
    const stop = () => {
      if (done) return; done = true;
      try { master.gain.cancelScheduledValues(ctx.currentTime); master.gain.setValueAtTime(master.gain.value, ctx.currentTime); master.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.12); } catch { /* уже закрыт */ }
      setTimeout(() => { try { ctx.close(); } catch { /* уже закрыт */ } }, 250);
    };
    setTimeout(stop, DUR * 1000 + 400);
    return { duration: DUR, stop };
  }

  return { play, names, ambient, reduce, burgerTune };
})();
