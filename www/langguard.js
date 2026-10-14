'use strict';
/* =====================================================================
   Кармис AI — языковая защита (langguard.js)

   Языки приложения: украинский, белорусский, английский.
   Три слоя защиты от «дичи» слабых моделей:
     1. isWeak(id)       — мелкие и узкоспециализированные модели не попадают
                           в автоподбор и в список выбора (эвристика по названию);
     2. looksGarbled()   — проверка каждого ответа: иероглифы, арабица и т.п.
                           среди кириллицы, зацикливание, «кракозябры»;
     3. checkLanguages() — ручной тест выбранной модели: 3 коротких вопроса
                           (uk / be / en) и проверка, что ответ на нужном языке.
   Файл не зависит от app.js: нужные вещи передаются аргументами.
   ===================================================================== */
const KGUARD = (() => {
  /* мелкие (≤3B), «кодерские» и устаревшие модели плохо держат украинский и белорусский */
  const WEAK_RE = new RegExp([
    '(^|[^a-z0-9])(0\\.5|1|1\\.5|2|3)b([^a-z0-9]|$)',           // qwen-1.5b, llama-3.2-3b, gemma-2b …
    'tinyllama|smollm|phi-?[123]|gemma-?[12]-?[0-9]*b|mini-?lm|opt-',
    'coder|codestral|starcoder|code-?llama|deepseek-coder',
    'llama-?2|gpt-?3|davinci|babbage|curie',
    'distil|tiny',
  ].join('|'), 'i');
  const isWeak = id => WEAK_RE.test(String(id || ''));

  /* ---------- скрипты ---------- */
  const RE = {
    cyr: /[\u0400-\u04FF]/g,
    lat: /[A-Za-z\u00C0-\u024F]/g,
    // всё, чему не место в ответе на uk/be/en: CJK, хангыль, кана, арабица, иврит, тайский, деванагари, греческий
    foreign: /[\u0370-\u03FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/g,
  };
  const count = (s, re) => (s.match(re) || []).length;

  /* убираем то, что не язык: теги действий, ссылки, код */
  const prose = t => String(t || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');

  /* true — ответ похож на «дичь» */
  function looksGarbled(text) {
    const t = prose(text);
    const foreign = count(t, RE.foreign), letters = count(t, RE.cyr) + count(t, RE.lat) + foreign;
    if (foreign >= 4 && foreign / Math.max(1, letters) > 0.06) return true;           // иероглифы/арабица среди обычного текста
    if ((t.match(/\uFFFD/g) || []).length >= 3) return true;                          // «кракозябры»
    const words = t.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length >= 24) {                                                         // зацикливание: одно слово/фраза много раз подряд
      let run = 1;
      for (let i = 1; i < words.length; i++) { run = words[i] === words[i - 1] ? run + 1 : 1; if (run >= 8) return true; }
      const uniq = new Set(words).size;
      if (uniq / words.length < 0.12) return true;
    }
    return false;
  }

  /* ---------- ручной тест языков ---------- */
  const TESTS = [
    { lang: 'uk', q: 'Дай відповідь двома короткими реченнями українською: яка столиця України і чим вона відома?',
      ok: s => count(s, RE.cyr) / Math.max(1, count(s, RE.cyr) + count(s, RE.lat)) > 0.6 && /[іїєґІЇЄҐ]/.test(s) && !/[ыэъЫЭЪ]/.test(s) },
    { lang: 'be', q: 'Адкажы двума кароткімі сказамі па-беларуску: якая сталіца Беларусі і чым яна вядомая?',
      ok: s => count(s, RE.cyr) / Math.max(1, count(s, RE.cyr) + count(s, RE.lat)) > 0.6 && /[ўіЎІ]/.test(s) && !/[їєґЇЄҐ]/.test(s) },
    { lang: 'ru', q: 'Ответь двумя короткими предложениями по-русски: какая столица России и чем она известна?',
      ok: s => count(s, RE.cyr) / Math.max(1, count(s, RE.cyr) + count(s, RE.lat)) > 0.6 && !/[іїєґўІЇЄҐЎ]/.test(s) },
    { lang: 'en', q: 'Answer in two short English sentences: what is the capital of France and what is it known for?',
      ok: s => count(s, RE.lat) / Math.max(1, count(s, RE.cyr) + count(s, RE.lat)) > 0.85 },
  ];

  /* ask(question) → Promise<string>: передаёт app.js, он знает, как позвать выбранную модель */
  async function checkLanguages(ask) {
    const out = [];
    for (const t of TESTS) {
      try {
        const a = String(await ask(t.q) || '').trim();
        const bad = looksGarbled(a);
        out.push({ lang: t.lang, ok: !bad && t.ok(prose(a)), garbled: bad, sample: a.replace(/\s+/g, ' ').slice(0, 90) });
      } catch (e) { out.push({ lang: t.lang, ok: false, error: String((e && e.message) || e) }); }
    }
    return out;
  }

  return { isWeak, looksGarbled, checkLanguages, _t: { prose, TESTS } };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = KGUARD;
