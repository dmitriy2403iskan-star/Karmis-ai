'use strict';
/* =====================================================================
   Кармис AI — генерация изображений (imagegen.js)

   Работает на тех же API-ключах, что и чат. Провайдеры по очереди:
     gemini      — модель с выводом картинок (подбирается из списка моделей)
     openai      — gpt-image-1, затем dall-e-3
     openrouter  — модели с выводом изображений (modalities: image)
     free        — Pollinations без ключа (запасной вариант, можно отключить)

   Подключение: KIMG.init({...}) в app.js, действие generate_image
   вызывает KIMG.generate(...) и показывает KIMG.buildNode(...) в карточке.
   ===================================================================== */
const KIMG = (() => {
  let D = null;
  const S = { geminiList: null };

  const SIZES = {
    square:    { hint: 'square 1:1 composition',            oai: '1024x1024', dalle: '1024x1024', w: 1024, h: 1024 },
    portrait:  { hint: 'vertical portrait 3:4 composition', oai: '1024x1536', dalle: '1024x1792', w: 768,  h: 1024 },
    landscape: { hint: 'horizontal landscape 4:3 composition', oai: '1536x1024', dalle: '1792x1024', w: 1024, h: 768 },
  };
  const LABEL = { gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter', free: 'Pollinations' };
  const GEMINI_IMG_DEFAULT = 'gemini-2.5-flash-image';
  const OPENROUTER_DEFAULT = 'google/gemini-2.5-flash-image';

  const cfg = () => D.cfg();
  const hasKey = id => !!D.provider(id).key;
  const T = (k, v) => D.T(k, v);
  const safeJson = t => { try { return JSON.parse(t); } catch { return {}; } };
  const withTimeout = (p, ms, msg) => { let t; return Promise.race([p, new Promise((_, r) => { t = setTimeout(() => r(new Error(msg)), ms); })]).finally(() => clearTimeout(t)); };
  const customModel = id => (cfg().imgProvider === id && (cfg().imgModel || '').trim()) || '';

  /* ---------- провайдеры ---------- */
  async function geminiModels(c) {
    if (S.geminiList) return S.geminiList;
    let list = [];
    try {
      // в списке остаются только модели с generateContent, imagen (predict) сюда не попадает
      const ids = (await D.listModels(c)).filter(id => /image/i.test(id) && !/imagen|vision|embed/i.test(id));
      list = D.sortNewest(ids).slice(0, 3);
    } catch { /* список недоступен — модель по умолчанию */ }
    if (!list.includes(GEMINI_IMG_DEFAULT)) list.push(GEMINI_IMG_DEFAULT);
    return (S.geminiList = list);
  }
  async function geminiCall(c, model, prompt, size, modalities) {
    const r = await D.http(`${c.base}/models/${model}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}\n\n(${SIZES[size].hint})` }] }],
        generationConfig: { responseModalities: modalities },
      }),
    });
    const j = safeJson(await r.text());
    if (!r.ok) { const e = new Error(D.apiError(r.status, j)); e.status = r.status; throw e; }
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find(p => p.inlineData || p.inline_data);
    if (!img) {
      const why = parts.map(p => p.text).filter(Boolean).join(' ') || (j.promptFeedback ? JSON.stringify(j.promptFeedback) : '');
      const e = new Error(T('img.noImage') + (why ? `: ${why.slice(0, 200)}` : '')); e.noImage = true; throw e;
    }
    const d = img.inlineData || img.inline_data;
    return { b64: d.data, mime: d.mimeType || d.mime_type || 'image/png', provider: 'gemini', model };
  }
  async function gemini(prompt, size) {
    const c = D.provider('gemini');
    const own = customModel('gemini');
    const models = own ? [own] : await geminiModels(c);
    let last;
    for (const model of models) {
      for (const mod of [['TEXT', 'IMAGE'], ['IMAGE']]) {
        try { return await geminiCall(c, model, prompt, size, mod); }
        catch (e) {
          last = e;
          // 401/403/429: ключ или лимит, другая модель не поможет; 400 — пробуем только картинку; остальное — следующая модель
          if (e.status === 401 || e.status === 403 || e.status === 429) { S.geminiList = null; throw e; }
          if ((e.status === 400 || e.noImage) && mod.length === 2) continue;   // 400 или ответ одним текстом — просим только картинку
          break;
        }
      }
    }
    S.geminiList = null;
    throw last || new Error(T('img.noImage'));
  }

  async function openai(prompt, size) {
    const c = D.provider('openai');
    const call = async (model, extra) => {
      const r = await D.http(`${c.base}/images/generations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
        body: JSON.stringify(Object.assign({ model, prompt, n: 1 }, extra)),
      });
      const j = safeJson(await r.text());
      if (!r.ok) { const e = new Error(D.apiError(r.status, j)); e.status = r.status; throw e; }
      const d = (j.data || [])[0] || {};
      if (d.b64_json) return { b64: d.b64_json, mime: 'image/png', provider: 'openai', model };
      if (d.url) return { url: d.url, mime: 'image/png', provider: 'openai', model };
      throw new Error(T('img.noImage'));
    };
    const own = customModel('openai');
    if (own) return call(own, { size: SIZES[size].oai });
    try { return await call('gpt-image-1', { size: SIZES[size].oai }); }
    catch (e) {
      // gpt-image-1 требует верифицированную организацию: при отказе пробуем dall-e-3
      if (e.status === 400 || e.status === 403 || e.status === 404) return call('dall-e-3', { size: SIZES[size].dalle, response_format: 'b64_json' });
      throw e;
    }
  }

  async function openrouter(prompt, size) {
    const c = D.provider('openrouter');
    const model = customModel('openrouter') || OPENROUTER_DEFAULT;
    const r = await D.http(`${c.base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
      body: JSON.stringify({ model, modalities: ['image', 'text'], messages: [{ role: 'user', content: `${prompt}\n\n(${SIZES[size].hint})` }] }),
    });
    const j = safeJson(await r.text());
    if (!r.ok) throw new Error(D.apiError(r.status, j));
    const msg = ((j.choices || [])[0] || {}).message || {};
    const im = (msg.images || [])[0];
    const url = im && ((im.image_url && im.image_url.url) || im.url);
    const m = /^data:([^;]+);base64,(.+)$/.exec(url || '');
    if (m) return { b64: m[2], mime: m[1], provider: 'openrouter', model };
    if (url) return { url, mime: 'image/png', provider: 'openrouter', model };
    throw new Error(T('img.noImage') + (msg.content ? `: ${String(msg.content).slice(0, 200)}` : ''));
  }

  function preload(url, ms) {
    return new Promise((resolve, reject) => {
      const im = new Image(), t = setTimeout(() => { im.src = ''; reject(new Error(T('img.timeout'))); }, ms);
      im.onload = () => { clearTimeout(t); resolve(); };
      im.onerror = () => { clearTimeout(t); reject(new Error(T('img.loadFail'))); };
      im.src = url;
    });
  }
  async function free(prompt, size) {
    const s = SIZES[size];
    const mk = () => `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 800))}?width=${s.w}&height=${s.h}&nologo=true&private=true&seed=${Math.floor(Math.random() * 1e9)}`;
    let url = mk();
    try { await preload(url, 60000); }
    catch (e) {
      // анонимный уровень ограничен по частоте: ждём и пробуем один раз ещё
      await new Promise(r => setTimeout(r, 15000));
      url = mk();
      await preload(url, 45000);
    }
    return { url, mime: 'image/jpeg', provider: 'free', model: 'pollinations' };
  }

  const PROV = { gemini, openai, openrouter, free };

  /* порядок: выбранный вручную; в «авто» — все провайдеры с ключами, в конце бесплатный запасной */
  function order() {
    const pref = cfg().imgProvider || 'auto';
    if (pref !== 'auto') return pref === 'free' || hasKey(pref) ? [pref] : [];
    const ids = ['gemini', 'openai', 'openrouter'].filter(hasKey);
    if (cfg().imgFree !== false) ids.push('free');
    return ids;
  }

  async function generate({ prompt, size }) {
    prompt = String(prompt || '').trim().slice(0, 1500);
    if (!prompt) throw new Error(T('img.noPrompt'));
    size = SIZES[size] ? size : 'square';
    const chain = order();
    if (!chain.length) throw new Error(T('img.noProvider'));
    const errs = [];
    for (const id of chain) {
      try { return await withTimeout(PROV[id](prompt, size), id === 'free' ? 130000 : 120000, T('img.timeout')); }
      catch (e) { errs.push(`${LABEL[id]}: ${(e && e.message) || e}`); }
    }
    throw new Error(T('img.allFailed', { e: errs.join(' | ') }));
  }

  /* ---------- показ, сохранение ---------- */
  const srcOf = r => r.b64 ? `data:${r.mime};base64,${r.b64}` : r.url;

  async function toB64(r) {
    if (r.b64) return r.b64;
    const blob = await (await fetch(r.url)).blob();
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  }

  async function save(r) {
    const ext = /jpe?g/.test(r.mime) ? 'jpg' : 'png', name = `karmis-${Date.now()}.${ext}`;
    let b64;
    try { b64 = await toB64(r); } catch { if (r.url) { D.openExternal(r.url); return; } throw new Error(T('img.saveFail')); }
    const P = (window.Capacitor && window.Capacitor.Plugins) || {};
    if (D.isNative && P.Filesystem && P.Share) {
      // Android WebView не умеет скачивать data:-ссылки: кладём файл в кэш и открываем системное меню «Поделиться / Сохранить»
      const w = await P.Filesystem.writeFile({ path: name, data: b64, directory: 'CACHE' });
      await P.Share.share({ title: 'Karmis AI', files: [w.uri] });
      return;
    }
    const a = document.createElement('a');
    a.href = `data:${r.mime};base64,${b64}`; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    D.toast(T('img.saved'));
  }

  function buildNode(res, prompt, size) {
    const wrap = document.createElement('div'); wrap.className = 'imgcard';
    const img = document.createElement('img'); img.alt = prompt; img.src = srcOf(res);
    wrap.appendChild(img);
    const row = document.createElement('div'); row.className = 'imgbtns';
    const mk = (txt, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost sm'; b.textContent = txt; b.onclick = fn; row.appendChild(b); return b; };
    mk(T('img.save'), async () => { try { await save(res); } catch (e) { D.toast(e.message || String(e), 5000); } });
    const again = mk(T('img.again'), async () => {
      again.disabled = true; D.toast(T('img.working'), 2500);
      try { res = await generate({ prompt, size }); img.src = srcOf(res); }
      catch (e) { D.toast(e.message || String(e), 6000); }
      finally { again.disabled = false; }
    });
    wrap.appendChild(row);
    return wrap;
  }

  function init(deps) { D = deps; }
  return {
    init, generate, buildNode, order,
    resetModels: () => { S.geminiList = null; },
    _t: { SIZES, PROV, setDeps: d => { D = d; } },
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = KIMG;
