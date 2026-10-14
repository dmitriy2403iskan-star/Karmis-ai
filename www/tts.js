'use strict';
/* =====================================================================
   Кармис AI — озвучка (tts.js)

   Почему на телефоне молчало: в Android WebView speechSynthesis часто
   «есть, но не говорит» (нет голосов, onend не приходит), из-за чего
   флаг «Кармис говорит» зависал и глушил микрофон.

   Теперь движки пробуются по очереди и сами переключаются при сбое:
     1. native — системный синтезатор Android (плагин
        @capacitor-community/text-to-speech)
     2. web    — speechSynthesis (браузер, Windows/Electron) с обходом багов:
        ждём голоса, режем текст на фразы, держим ссылку на utterance,
        сторожевой таймер на onstart/onend
     3. cloud  — озвучка через ключ Gemini или OpenAI (WAV/MP3 → WebAudio)

   Подключение: KTTS.init({...}) в app.js. Зависимости передаются снаружи,
   поэтому файл не зависит от внутренностей app.js и легко переносится
   в новую версию.
   ===================================================================== */
const KTTS = (() => {
  const S = {
    gen: 0, queue: [], running: false, speaking: false, cancel: null, u: null,
    failed: {}, lastError: '', lastEngine: '', ctx: null, unlocked: false,
    cache: new Map(), geminiModel: '', nativeVoices: null,
  };
  let D = null;

  const GEMINI_VOICES = ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Callirrhoe', 'Sulafat'];
  const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'];
  const GEMINI_TTS_DEFAULT = 'gemini-2.5-flash-preview-tts';
  const FAIL_COOLDOWN = 5 * 60 * 1000;   // сломавшийся движок не трогаем 5 минут, пока есть другие
  const LIMIT = { native: 500, web: 170, cloud: 260 };

  const cfg = () => D.cfg();
  const rate = () => Math.min(2, Math.max(0.5, Number(cfg().rate) || 1));
  const hasWeb = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const nativePlugin = () => (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech) || null;
  const estMs = text => Math.round(text.length * 90 / rate());
  const errText = e => String((e && e.message) || e || 'ошибка');

  function withTimeout(p, ms, msg) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
  }

  /* ---------- текст ---------- */
  function cleanText(t) {
    return String(t || '')
      .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, D ? D.linkWord() : 'link')
      .replace(/[*_`#>~|]/g, '')
      .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  /* режем на фразы ≤ max символов: длинный текст целиком Chrome обрывает, а облако дольше ждать */
  function split(text, max) {
    const sentences = text.replace(/([.!?…]+)\s+/g, '$1\u0001').split(/\u0001|\n+/).map(s => s.trim()).filter(Boolean);
    const out = []; let cur = '';
    const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (let s of sentences) {
      while (s.length > max) {
        let cut = s.lastIndexOf(' ', max);
        if (cut < max * 0.4) cut = max;
        flush(); out.push(s.slice(0, cut).trim()); s = s.slice(cut).trim();
      }
      if (!s) continue;
      if ((cur + ' ' + s).trim().length > max) { flush(); cur = s; } else cur = (cur + ' ' + s).trim();
    }
    flush();
    return out;
  }

  /* ---------- аудио ---------- */
  function audioCtx() {
    if (!S.ctx || S.ctx.state === 'closed') S.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return S.ctx;
  }
  /* вызывать на первое касание: без этого таймеры и ответы без жеста остаются немыми */
  function unlock() {
    if (S.unlocked) return;
    try {
      const c = audioCtx(); if (c.resume) c.resume();
      const s = c.createBufferSource(); s.buffer = c.createBuffer(1, 1, 22050); s.connect(c.destination); s.start(0);
      S.unlocked = true;
    } catch { /* ничего страшного, попробуем при следующем касании */ }
  }

  function pcm16ToWav(pcm, sampleRate) {
    const n = pcm.byteLength, buf = new ArrayBuffer(44 + n), dv = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, 'data'); dv.setUint32(40, n, true);
    new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, n));
    return buf;
  }
  /* Gemini TTS дописывает к фразе «хвост»: короткий тихий шум или щелчок после паузы (звучит как конец передачи в рации).
     Находим участки звука по громкости, отбрасываем последний короткий и заметно тихий участок, режем тишину по краям
     и плавно гасим конец. Речь не трогаем: сегмент считается хвостом только если он короче 0,4 с и втрое тише речи. */
  function trimPcm(pcm, sr) {
    const n = pcm.byteLength >> 1;
    const win = Math.max(1, Math.round(sr * 0.01)), nw = Math.floor(n / win);
    if (nw < 20) return pcm;
    const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
    const rms = new Float32Array(nw);
    for (let w = 0; w < nw; w++) {
      let sum = 0;
      for (let i = 0; i < win; i++) { const v = dv.getInt16((w * win + i) * 2, true); sum += v * v; }
      rms[w] = Math.sqrt(sum / win);
    }
    const loud = Array.from(rms).sort((a, b) => a - b)[Math.floor(nw * 0.9)] || 0;   // уровень речи
    if (loud < 200) return pcm;                                                         // почти тишина: не трогаем
    const thr = Math.max(60, loud * 0.12), GAP = 15;                                     // разрыв короче 150 мс считаем одним словом
    const segs = []; let a = -1, last = -1;
    for (let w = 0; w < nw; w++) {
      if (rms[w] <= thr) continue;
      if (a < 0) a = w; else if (w - last > GAP) { segs.push([a, last]); a = w; }
      last = w;
    }
    if (a >= 0) segs.push([a, last]);
    if (!segs.length) return pcm;
    while (segs.length > 1) {
      const [x, y] = segs[segs.length - 1]; let m = 0;
      for (let w = x; w <= y; w++) m += rms[w];
      m /= (y - x + 1);
      if (y - x + 1 < 40 && m < loud * 0.33) segs.pop(); else break;
    }
    const from = Math.max(0, segs[0][0] * win - Math.round(sr * 0.08));
    const to = Math.min(n, (segs[segs.length - 1][1] + 1) * win + Math.round(sr * 0.12));
    const len = to - from;
    if (len <= 0 || len >= n - Math.round(sr * 0.02)) return pcm;                        // обрезать нечего
    const out = new Uint8Array(len * 2), od = new DataView(out.buffer);
    const fin = Math.round(sr * 0.005), fout = Math.round(sr * 0.04);
    for (let i = 0; i < len; i++) {
      let v = dv.getInt16((from + i) * 2, true);
      if (i < fin) v = Math.round(v * i / fin);
      if (i >= len - fout) v = Math.round(v * (len - i) / fout);
      od.setInt16(i * 2, v, true);
    }
    return out;
  }
  function b64ToBytes(b64) {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  /* Gemini 3.8 отдаёт готовый WAV (с заголовком RIFF), старые модели — «сырой» PCM. Если принять WAV за PCM,
     заголовок превращается в щелчок/шум, а смещение данных портит поиск хвоста. */
  function parseWav(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sr = dv.getUint32(24, true) || 24000, ch = dv.getUint16(22, true) || 1, bits = dv.getUint16(34, true) || 16;
    let pos = 12, start = 44, len = bytes.length - 44;
    while (pos + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]), sz = dv.getUint32(pos + 4, true);
      if (id === 'data') { start = pos + 8; len = Math.min(sz, bytes.length - start); break; }
      pos += 8 + sz + (sz & 1);
    }
    return { pcm: bytes.subarray(start, start + (len & ~1)), sr, ch, bits };
  }

  /* Любой синтез (Gemini, OpenAI mp3) может закончиться коротким «шипением»: обрезаем его уже после декодирования.
     Хвост — это последний короткий кусок после паузы ≥ 80 мс, который шумоподобен (много переходов через ноль)
     или заметно тише речи. Затем плавно гасим конец, а начало плавно поднимаем: без щелчков на стыке фраз. */
  function cleanBuffer(ctx, buf) {
    try {
      const sr = buf.sampleRate, n = buf.length, chans = buf.numberOfChannels;
      const x = buf.getChannelData(0), win = Math.max(1, Math.round(sr * 0.01)), nw = Math.floor(n / win);
      let end = n;
      if (nw >= 12) {
        const rms = new Float32Array(nw), zcr = new Float32Array(nw);
        for (let w = 0; w < nw; w++) {
          let sum = 0, z = 0, prev = x[w * win];
          for (let k = 0; k < win; k++) { const v = x[w * win + k]; sum += v * v; if ((v > 0) !== (prev > 0)) z++; prev = v; }
          rms[w] = Math.sqrt(sum / win); zcr[w] = z / win;
        }
        const loud = Array.from(rms).sort((a, b) => a - b)[Math.floor(nw * 0.9)] || 0;
        if (loud > 0.01) {
          const thr = Math.max(0.004, loud * 0.1), GAP = 8, segs = []; let a = -1, last = -1;
          for (let w = 0; w < nw; w++) {
            if (rms[w] <= thr) continue;
            if (a < 0) a = w; else if (w - last > GAP) { segs.push([a, last]); a = w; }
            last = w;
          }
          if (a >= 0) segs.push([a, last]);
          for (let pass = 0; pass < 2 && segs.length > 1; pass++) {
            const [p, q] = segs[segs.length - 1], len = q - p + 1;
            let m = 0, zz = 0; for (let w = p; w <= q; w++) { m += rms[w]; zz += zcr[w]; } m /= len; zz /= len;
            if (len < 60 && (zz > 0.3 || m < loud * 0.4)) segs.pop(); else break;
          }
          if (segs.length) end = Math.min(n, (segs[segs.length - 1][1] + 1) * win + Math.round(sr * 0.1));
        }
      }
      const fin = Math.min(Math.round(sr * 0.006), end >> 1), fout = Math.min(Math.round(sr * 0.045), end >> 1);
      const out = ctx.createBuffer(chans, end, sr);
      for (let c = 0; c < chans; c++) {
        const src = buf.getChannelData(c), dst = out.getChannelData(c);
        for (let i = 0; i < end; i++) {
          let v = src[i];
          if (i < fin) v *= i / fin;
          if (i >= end - fout) v *= (end - i) / fout;
          dst[i] = v;
        }
      }
      return out;
    } catch { return buf; }
  }

  async function playBuffer(ab, mul) {
    const ctx = audioCtx();
    if (ctx.state === 'suspended') { try { await withTimeout(ctx.resume(), 1500, 'resume'); } catch { /* проверим ниже */ } }
    if (ctx.state !== 'running') throw new Error('звук заблокирован до первого касания экрана');
    const buf = cleanBuffer(ctx, await new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej)));
    await new Promise(resolve => {
      const src = ctx.createBufferSource(); src.buffer = buf;
      if (mul && mul !== 1) src.playbackRate.value = mul;
      src.connect(ctx.destination);
      const to = setTimeout(() => finish(), buf.duration * 1000 / (mul || 1) + 4000);
      const finish = () => { clearTimeout(to); S.cancel = null; src.onended = null; resolve(); };
      S.cancel = () => { try { src.stop(); } catch { /* уже остановлен */ } finish(); };
      src.onended = finish;
      src.start();
    });
  }

  /* ---------- движок 1: системный синтезатор Android ---------- */
  async function nativeVoices() {
    if (S.nativeVoices) return S.nativeVoices;
    const P = nativePlugin();
    try { const r = await P.getSupportedVoices(); S.nativeVoices = (r && r.voices) || []; } catch { S.nativeVoices = []; }
    return S.nativeVoices;
  }
  /* белорусских голосов в Android почти нет: берём первый язык из списка, который синтезатор поддерживает */
  async function nativeLang() {
    if (S.nativeLang) return S.nativeLang;
    const list = D.bcpList ? D.bcpList() : [D.bcp()];
    for (const l of list) {
      try { const r = await nativePlugin().isLanguageSupported({ lang: l }); if (r && r.supported) return (S.nativeLang = l); } catch { /* пробуем следующий */ }
    }
    return list[0];
  }
  async function nativePlay(text) {
    const P = nativePlugin();
    if (!P) throw new Error('плагин TextToSpeech не найден (нужна пересборка приложения с npm install и cap sync)');
    const opts = { text, lang: await nativeLang(), rate: rate(), pitch: 1.0, volume: 1.0 };
    const want = (cfg().ttsVoice || {}).native;
    if (want) { const i = (await nativeVoices()).findIndex(v => (v.name || v.voiceURI) === want); if (i >= 0) opts.voice = i; }
    S.cancel = () => { try { const r = P.stop(); if (r && r.catch) r.catch(() => {}); } catch { /* ignore */ } };
    try { await withTimeout(P.speak(opts), estMs(text) + 8000, 'системный синтезатор не ответил'); }
    finally { S.cancel = null; }
  }

  /* ---------- движок 2: speechSynthesis ---------- */
  async function webVoices() {
    let v = speechSynthesis.getVoices();
    if (v.length) return v;
    await new Promise(r => { const h = () => r(); speechSynthesis.addEventListener('voiceschanged', h, { once: true }); setTimeout(r, 1500); });
    return speechSynthesis.getVoices();
  }
  async function webPlay(text) {
    if (!hasWeb()) throw new Error('speechSynthesis недоступен');
    const voices = await webVoices();
    if (!voices.length && D.isNative) throw new Error('в WebView нет голосов speechSynthesis');
    const list = D.bcpList ? D.bcpList() : [D.bcp()];
    const lang = list.find(l => voices.some(v => v.lang.replace('_', '-').toLowerCase().startsWith(l.slice(0, 2).toLowerCase()))) || list[0];
    const want = (cfg().ttsVoice || {}).web;
    const voice = voices.find(v => v.name === want) || null;
    await new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      S.u = u;   // держим ссылку: если сборщик мусора заберёт utterance, onend не придёт никогда
      u.lang = lang; u.rate = rate();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      let started = false, done = false, t1, t2;
      const fin = err => { if (done) return; done = true; clearTimeout(t1); clearTimeout(t2); S.cancel = null; S.u = null; err ? reject(err) : resolve(); };
      const kill = () => { try { speechSynthesis.cancel(); } catch { /* ignore */ } };
      t1 = setTimeout(() => { if (!started) { kill(); fin(new Error('озвучка браузера не стартовала за 3,5 с')); } }, 3500);
      t2 = setTimeout(() => { kill(); fin(started ? null : new Error('таймаут озвучки браузера')); }, estMs(text) + 6000);
      u.onstart = () => { started = true; clearTimeout(t1); };
      u.onend = () => fin();
      u.onerror = e => (e.error === 'interrupted' || e.error === 'canceled') ? fin() : fin(new Error('speechSynthesis: ' + (e.error || 'ошибка')));
      S.cancel = () => { kill(); fin(); };
      try { if (speechSynthesis.paused) speechSynthesis.resume(); speechSynthesis.speak(u); } catch (e) { fin(e); }
    });
  }

  /* ---------- движок 3: облако (Gemini / OpenAI) ---------- */
  function cloudProvider() {
    const pref = cfg().ttsCloud || 'auto', has = id => !!D.provider(id).key;
    if (pref === 'gemini') return has('gemini') ? 'gemini' : null;
    if (pref === 'openai') return has('openai') ? 'openai' : null;
    return has('gemini') ? 'gemini' : has('openai') ? 'openai' : null;
  }
  const cloudVoice = prov => (cfg().ttsVoice || {})[prov] || (prov === 'gemini' ? 'Kore' : 'alloy');

  async function geminiModel(c, force) {
    if (S.geminiModel && !force) return S.geminiModel;
    let m = GEMINI_TTS_DEFAULT;
    try {
      const ids = (await D.listModels(c)).filter(id => /tts/i.test(id));
      /* для озвучки ответов важна скорость: сначала flash-lite, потом flash, потом остальные */
      const pick = re => D.sortNewest(ids.filter(id => re.test(id)));
      const best = pick(/flash-lite/i)[0] || pick(/flash/i)[0] || D.sortNewest(ids)[0];
      if (best) m = best;
    } catch { /* список недоступен — берём модель по умолчанию */ }
    return (S.geminiModel = m);
  }
  /* у моделей 3.x голос задаётся как voiceConfig.voice, у 2.5 — prebuiltVoiceConfig.voiceName */
  const geminiVoiceCfg = (model, legacy) => {
    const v = cloudVoice('gemini'), isNew = /gemini-3/i.test(model) !== !!legacy;
    return isNew ? { voiceConfig: { voice: v } } : { voiceConfig: { prebuiltVoiceConfig: { voiceName: v } } };
  };
  async function geminiSynth(text, retry, legacy) {
    const c = D.provider('gemini'), model = await geminiModel(c, retry === 'model');
    const r = await D.http(`${c.base}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: geminiVoiceCfg(model, legacy) },
      }),
    });
    const raw = await r.text();
    let j = {}; try { j = JSON.parse(raw); } catch { /* не JSON */ }
    if (!r.ok) {
      if (r.status === 400 && !legacy) return geminiSynth(text, retry, true);            // другой формат голоса
      if (!retry && (r.status === 404 || r.status === 400)) return geminiSynth(text, 'model', false);   // модель устарела — берём актуальную
      throw new Error(D.apiError(r.status, j));
    }
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const p = parts.find(x => x.inlineData || x.inline_data);
    if (!p) throw new Error('Gemini не вернул аудио');
    const d = p.inlineData || p.inline_data;
    const bytes = b64ToBytes(d.data);
    let pcm = bytes, sr = Number((String(d.mimeType || d.mime_type || '').match(/rate=(\d+)/) || [])[1]) || 24000;
    if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) { const w = parseWav(bytes); pcm = w.pcm; sr = w.sr; }
    return { buf: pcm16ToWav(pcm, sr), mul: rate() };   // у Gemini нет параметра скорости — меняем скорость воспроизведения
  }
  async function openaiSynth(text) {
    const c = D.provider('openai');
    const call = model => D.httpBin(`${c.base}/audio/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model, input: text, voice: cloudVoice('openai'), response_format: 'mp3', speed: rate() }),
    });
    try { return { buf: await call('gpt-4o-mini-tts'), mul: 1 }; }
    catch (e) { if (e && (e.status === 400 || e.status === 404)) return { buf: await call('tts-1'), mul: 1 }; throw e; }
  }
  function cloudSynth(text, prov) {
    const key = `${prov}|${cloudVoice(prov)}|${rate()}|${text}`;
    if (S.cache.has(key)) return S.cache.get(key);
    const p = prov === 'gemini' ? geminiSynth(text) : openaiSynth(text);
    S.cache.set(key, p); p.catch(() => S.cache.delete(key));
    if (S.cache.size > 8) S.cache.delete(S.cache.keys().next().value);
    return p;
  }
  async function cloudPlay(text, my) {
    const prov = cloudProvider();
    if (!prov) throw new Error('нет ключа Gemini или OpenAI');
    const r = await withTimeout(cloudSynth(text, prov), 30000, 'облако не ответило за 30 с');
    if (my !== S.gen) return;
    S.queue.slice(0, 2).forEach(q => cloudSynth(q, prov).catch(() => {}));   // заранее готовим две следующие фразы
    await playBuffer(r.buf, r.mul);
  }

  const ENG = { native: nativePlay, web: webPlay, cloud: cloudPlay };
  const avail = {
    native: () => !!(D.isNative && nativePlugin()),
    web: () => hasWeb(),
    cloud: () => !!cloudProvider(),
  };

  /* порядок попыток: выбранный вручную, затем остальные доступные */
  function order() {
    const pref = cfg().ttsEngine || 'auto';
    const base = ['native', 'web', 'cloud'];
    const list = pref !== 'auto' && base.includes(pref) ? [pref, ...base.filter(x => x !== pref)] : base;
    return list.filter(e => avail[e]());
  }

  /* ---------- очередь ---------- */
  function setSpeaking(v) { if (S.speaking === v) return; S.speaking = v; try { D.onState(v); } catch { /* ignore */ } }

  async function playChunk(text, my) {
    const all = order();
    const fresh = all.filter(e => !(S.failed[e] && Date.now() - S.failed[e] < FAIL_COOLDOWN));
    const list = fresh.length ? fresh : all;
    for (const eng of list) {
      if (my !== S.gen) return;
      try { await ENG[eng](text, my); S.lastEngine = eng; return; }
      catch (e) {
        if (my !== S.gen) return;
        S.failed[eng] = Date.now(); S.lastError = `${eng}: ${errText(e)}`;
        try { D.log && D.log('tts', S.lastError); } catch { /* ignore */ }
      }
    }
    if (my === S.gen) { try { D.onError && D.onError(S.lastError || 'нет доступного движка озвучки'); } catch { /* ignore */ } }
  }

  async function run() {
    if (S.running) return;
    S.running = true;
    const my = S.gen;
    setSpeaking(true);
    try {
      while (S.queue.length && my === S.gen) await playChunk(S.queue.shift(), my);
    } finally {
      if (my === S.gen) { S.running = false; setSpeaking(false); }   // флаг «говорит» гарантированно сбрасывается
    }
  }

  function speak(text) {
    const clean = cleanText(text);
    if (!clean) return;
    const eng = order()[0] || 'web';
    let parts = split(clean, LIMIT[eng] || 170);
    /* облако: первая фраза короткая, чтобы голос начался почти сразу после появления текста */
    if (eng === 'cloud' && !S.running && !S.queue.length && parts[0] && parts[0].length > 110) { const f = split(parts[0], 110); parts = f.concat(parts.slice(1)); }
    S.queue.push(...parts);
    run();
  }

  function stop() {
    S.gen++; S.queue = []; S.running = false;
    const c = S.cancel; S.cancel = null;
    try { c && c(); } catch { /* ignore */ }
    try { const P = D && D.isNative && nativePlugin(); if (P) { const r = P.stop(); if (r && r.catch) r.catch(() => {}); } } catch { /* ignore */ }
    if (hasWeb()) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
    setSpeaking(false);
  }

  /* ---------- голоса для настроек ---------- */
  async function voiceOptions() {
    const eng = order()[0], langs = (D.bcpList ? D.bcpList() : [D.bcp()]).map(l => l.slice(0, 2).toLowerCase());
    const same = l => langs.some(x => String(l || '').toLowerCase().replace('_', '-').startsWith(x));
    if (eng === 'native') {
      const v = (await nativeVoices()).filter(x => same(x.lang)).map(x => ({ value: x.name || x.voiceURI, label: `${x.name || x.voiceURI} (${x.lang})` }));
      return { key: 'native', list: v };
    }
    if (eng === 'web') {
      const v = hasWeb() ? speechSynthesis.getVoices().filter(x => same(x.lang)).map(x => ({ value: x.name, label: `${x.name} (${x.lang})` })) : [];
      return { key: 'web', list: v };
    }
    if (eng === 'cloud') {
      const prov = cloudProvider();
      return { key: prov, list: (prov === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES).map(x => ({ value: x, label: x })) };
    }
    return { key: 'web', list: [] };
  }

  /* ---------- диагностика: на телефоне сразу видно, какой движок жив ---------- */
  async function diagnose(log) {
    stop(); S.failed = {};
    log(`Платформа: ${D.isNative ? 'Android-приложение' : D.isElectron ? 'Windows-приложение' : 'браузер'}`);
    const P = nativePlugin();
    if (D.isNative) {
      if (!P) log('native: плагин TextToSpeech НЕ найден → пересобери приложение (npm install, cap sync)');
      else {
        try { const r = await P.isLanguageSupported({ lang: D.bcp() }); log(`native: плагин есть, язык ${D.bcp()} ${r && r.supported ? 'поддерживается' : 'НЕ поддерживается (Настройки Android → Синтез речи → Голоса)'}`); }
        catch (e) { log(`native: плагин есть, но синтезатор не отвечает: ${errText(e)}`); }
        S.nativeVoices = null; log(`native: голосов в системе — ${(await nativeVoices()).length}`);
      }
    }
    if (hasWeb()) log(`web: speechSynthesis есть, голосов — ${(await webVoices()).length}`); else log('web: speechSynthesis нет');
    const cp = cloudProvider();
    log(cp ? `cloud: доступно через ${cp}` : 'cloud: нет ключа Gemini/OpenAI');
    const phrase = D.testPhrase();
    for (const eng of Object.keys(ENG)) {
      if (!avail[eng]()) { log(`→ ${eng}: пропуск (недоступен)`); continue; }
      const t0 = Date.now(), my = ++S.gen;
      try { await ENG[eng](phrase, my); log(`→ ${eng}: OK за ${Date.now() - t0} мс (слышно было?)`); }
      catch (e) { log(`→ ${eng}: ОШИБКА — ${errText(e)}`); }
      stop();
    }
    log(`Порядок в режиме «авто»: ${order().join(' → ') || 'пусто'}`);
  }

  function init(deps) {
    D = deps;
    if (hasWeb()) { try { speechSynthesis.getVoices(); } catch { /* прогрев списка голосов */ } }
  }
  function onVoicesChanged(cb) { if (hasWeb()) speechSynthesis.addEventListener('voiceschanged', cb); }

  return {
    init, speak, stop, unlock, order, voiceOptions, diagnose, onVoicesChanged,
    isSpeaking: () => S.speaking, resetFailures: () => { S.failed = {}; S.nativeVoices = null; S.nativeLang = ''; S.geminiModel = ''; },
    lastError: () => S.lastError, lastEngine: () => S.lastEngine,
    _t: { cleanText, split, pcm16ToWav, trimPcm, cleanBuffer, parseWav, ENG, S, setDeps: d => { D = d; } },
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = KTTS;
