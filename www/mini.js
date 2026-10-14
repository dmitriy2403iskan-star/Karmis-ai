'use strict';
/* Міні-вікно Кармиса. Уся логіка (модель, дії, голос) живе в головному вікні,
   тут лише показ повідомлень і відправка команд через karmisMini (electron/mini-preload.js). */
const api = window.karmisMini;
const $ = s => document.querySelector(s);
const msgs = $('#msgs');
let L = {};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

function down() { msgs.scrollTop = msgs.scrollHeight; }
function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'm ' + (role === 'user' ? 'user' : role === 'error' ? 'error' : 'bot');
  d.innerHTML = fmt(text);
  msgs.appendChild(d); down();
}
function addAct(text, kind) {
  const d = document.createElement('div');
  d.className = 'm act ' + (kind || '');
  d.textContent = text;
  msgs.appendChild(d); down();
}
function typing(on) {
  const t = $('#typing');
  if (!on) { if (t) t.remove(); return; }
  if (t) return;
  const d = document.createElement('div');
  d.className = 'm typing'; d.id = 'typing'; d.innerHTML = '<i></i><i></i><i></i>';
  msgs.appendChild(d); down();
}
function setState(s) {
  if (!s) return;
  if (s.status != null) $('#status').textContent = s.status;
  if (s.dataState) $('#mini').dataset.state = s.dataState;
  if (s.listen != null) { const b = $('#bEar'); b.classList.toggle('on', !!s.listen); b.setAttribute('aria-pressed', String(!!s.listen)); }
  if (s.mic != null) $('#mini').dataset.mic = s.mic ? 'on' : 'off';
  if (s.tts != null) {
    $('#bMute').classList.toggle('off', !s.tts);
    $('#icVol').innerHTML = s.tts
      ? '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>'
      : '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>';
  }
  if (s.live !== undefined) { const l = $('#live'); l.hidden = !s.live; l.textContent = s.live || ''; }
}
function labels(l) {
  L = l || {};
  document.documentElement.lang = L.lang || 'uk';
  $('#inp').placeholder = L.ph || '';
  $('#bEar').title = L.ear || ''; $('#bMute').title = L.mute || ''; $('#bExpand').title = L.expand || '';
  $('#bClose').title = L.close || ''; $('#bMic').title = L.mic || ''; $('#orb').title = L.stop || '';
  const c = $('#chips'); c.innerHTML = '';
  (L.chips || []).forEach(x => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = x.label;
    b.onclick = () => api.send({ type: 'send', text: x.text });
    c.appendChild(b);
  });
}

api.onEvt(e => {
  if (e.type === 'init') {
    labels(e.labels); msgs.innerHTML = '';
    (e.log || []).forEach(m => m.kind === 'act' ? addAct(m.text, m.k) : addMsg(m.kind, m.text));
    setState(e.st); typing(!!e.typing);
  } else if (e.type === 'msg') addMsg(e.role, e.text);
  else if (e.type === 'act') addAct(e.text, e.kind);
  else if (e.type === 'typing') typing(!!e.on);
  else if (e.type === 'state') setState(e.st);
});

$('#form').addEventListener('submit', ev => {
  ev.preventDefault();
  const t = $('#inp').value.trim(); if (!t) return;
  $('#inp').value = '';
  api.send({ type: 'send', text: t });
});
$('#bEar').onclick = () => api.send({ type: 'listen' });   // постійне прослуховування: «Джарвіс, …»
$('#bMic').onclick = () => api.send({ type: 'mic' });      // одна голосова команда без слова-активатора
$('#bMute').onclick = () => api.send({ type: 'mute' });
$('#orb').onclick = () => api.send({ type: 'stop' });
$('#bExpand').onclick = () => api.expand();
$('#bClose').onclick = () => api.close();
document.addEventListener('keydown', e => { if (e.key === 'Escape') api.close(); });

const tick = () => { const d = new Date(); $('#clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
tick(); setInterval(tick, 10000);

api.send({ type: 'ready' });   // головне вікно відповість подією init
