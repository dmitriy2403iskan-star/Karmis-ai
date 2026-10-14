'use strict';
const assert = require('assert');
const { compactObs, mergeOcr } = require('../electron/screenfmt');
const rawUia = [
  'window "Блокнот"',
  '1 btn @100,200 "Зберегти"',
  '2 btn @100,200 "Зберегти"',               // дубль
  '3 edit @300,400 "Редактор" ="' + 'x'.repeat(100) + '"',
  '4 text @10,10',                            // безіменний текст
  '5 text @12,12 "·"',                        // шум
  '6 btn @50,60',                             // безіменна кнопка = значок
  '7 item @70,80 "' + 'Дуже довга назва '.repeat(8) + '"',
  'taskbar:',
  '8 btn @20,1060 "Пуск"',
].join('\n');
const c = compactObs(rawUia, { k: 0.5 });
const lines = c.text.split('\n');
assert.strictEqual(lines[0], 'window "Блокнот"');
assert.ok(!lines.some(l => /^\d+ /.test(l)), 'службові номери прибрано');
assert.strictEqual(lines.filter(l => l.includes('Зберегти')).length, 1, 'дублі прибрано');
assert.ok(lines.includes('btn @25,30'), 'безіменна кнопка лишилась, координати масштабовані');
assert.ok(lines.some(l => l.startsWith('item @35,40 "') && l.includes('…')), 'довга назва обрізана');
assert.ok(lines.some(l => l.startsWith('edit @150,200') && /="x{59}…"/.test(l)), 'значення поля обрізане до 60');
assert.strictEqual(c.dropped, 3);
assert.strictEqual(c.count, 5);

const before = rawUia.length, after = c.text.length;
console.log(`compactObs: ${before} → ${after} символів (-${Math.round(100 - after / before * 100)}%)`);

const m = mergeOcr(c.text, [
  { t: 'Зберегти', x: 90, y: 190, w: 40, h: 20 },        // вже є серед елементів
  { t: 'YouTube', x: 400, y: 100, w: 80, h: 30 },
  { t: 'ok', x: 5, y: 5, w: 10, h: 10 },
  { t: '—', x: 1, y: 1, w: 5, h: 5 },                    // не текст
  { t: 'Spotify  Premium', x: 600, y: 90, w: 120, h: 30 },
  { t: 'YouTube', x: 401, y: 101, w: 80, h: 30 },        // дубль
], { k: 0.5 });
const ml = m.text.split('\n').filter(l => l.startsWith('ocr '));
assert.deepStrictEqual(ml, ['ocr @5,5 "ok"', 'ocr @220,58 "YouTube"', 'ocr @330,53 "Spotify Premium"'], 'ocr-рядки: без дублів і не-тексту, зверху вниз');
assert.strictEqual(m.added, 3);
assert.ok(!/ocr @\d+,\d+ "Зберегти"/.test(m.text), 'OCR не дублює назви елементів');
assert.strictEqual(mergeOcr(c.text, [], {}).text, c.text);
console.log('screenfmt: OK, ocr-рядків:', m.added);
