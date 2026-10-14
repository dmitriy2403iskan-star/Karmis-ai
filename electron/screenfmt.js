'use strict';
/* Кармис AI — формат «стану екрана» для нейромережі (electron/screenfmt.js).
   Чисті функції без Electron: їх можна тестувати окремо (див. test/screenfmt.test.js).

   Мета: передати моделі якнайменше токенів.
   • compactObs: список елементів UI Automation без службових номерів, без дублів і шуму,
     з обрізаними назвами. Безіменні кнопки лишаються: це значки без підпису (їх можна розглянути через pc_zoom).
   • mergeOcr: рядки, прочитані локальним OCR Windows з екрана (текст на логотипах, картинках, у іграх),
     додаються тим самим форматом «ocr @x,y "текст"»; усе, що вже є серед назв елементів, відкидається. */

const NAME_MAX = 48, OCR_MAX = 50;
const ELEM = /^\d+ (\S+) @(-?\d+),(-?\d+)(.*)$/;

function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function compactObs(text, o) {
  const k = (o && o.k) || 1;
  const seen = new Set(), out = [];
  let count = 0, dropped = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const m = ELEM.exec(line);
    if (!m) { out.push(line); continue; }
    const role = m[1], x = Math.round(+m[2] * k), y = Math.round(+m[3] * k);
    let rest = m[4], name = '';
    const nm = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
    if (nm) { name = nm[1].replace(/\s+/g, ' ').trim(); rest = rest.slice(nm[0].length); }
    if (!name && (role === 'text' || role === 'item')) { dropped++; continue; }        // безіменний текст: нічого не повідомляє
    if (name && !/[\p{L}\p{N}]/u.test(name) && name.length < 3 && role === 'text') { dropped++; continue; }
    const key = role + '|' + name.toLowerCase() + '|' + Math.round(x / 12) + ',' + Math.round(y / 12);
    if (seen.has(key)) { dropped++; continue; }
    seen.add(key); count++;
    out.push(`${role} @${x},${y}` + (name ? ` "${clip(name, NAME_MAX)}"` : '') + rest.replace(/="((?:[^"\\]|\\.)*)"/, (_, v) => `="${clip(v, 60)}"`));
  }
  return { text: out.join('\n'), count, dropped };
}

/* items: [{ t, x, y, w, h }] у фізичних пікселях екрана; k — множник у простір знімка/координат моделі */
function mergeOcr(compactText, items, o) {
  const k = (o && o.k) || 1;
  const names = [];
  String(compactText || '').replace(/"((?:[^"\\]|\\.)*)"/g, (_, n) => { names.push(n.toLowerCase()); return ''; });
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const lines = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    const t = norm(it && it.t);
    if (t.length < 2 || !/[\p{L}\p{N}]/u.test(t)) continue;
    if (names.some(n => n === t || (t.length >= 4 && n.includes(t)) || (n.length >= 4 && t.includes(n) && n.length / t.length > 0.7))) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    const cx = Math.round((+it.x + (+it.w || 0) / 2) * k), cy = Math.round((+it.y + (+it.h || 0) / 2) * k);
    lines.push({ cx, cy, s: `ocr @${cx},${cy} "${clip(String(it.t).replace(/\s+/g, ' ').trim(), 60)}"` });
  }
  lines.sort((a, b) => (Math.round(a.cy / 14) - Math.round(b.cy / 14)) || (a.cx - b.cx));
  const take = lines.slice(0, OCR_MAX);
  return { text: take.length ? compactText + '\n' + take.map(l => l.s).join('\n') : compactText, added: take.length };
}

module.exports = { compactObs, mergeOcr, NAME_MAX, OCR_MAX };
