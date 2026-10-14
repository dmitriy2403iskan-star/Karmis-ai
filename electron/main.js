'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, session, screen } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const pc = require('./pc');

let mainWin = null;
let miniWin = null;

// Разрешённые схемы для открытия во внешних приложениях (всё остальное блокируется)
const OPEN_PROTOCOLS = new Set([
  'http:', 'https:', 'mailto:', 'tel:', 'sms:', 'tg:', 'whatsapp:', 'spotify:', 'discord:', 'steam:',
  'viber:', 'skype:', 'msteams:', 'ms-settings:', 'ms-calculator:', 'microsoft.windows.camera:',
]);

// Белый список программ, которые Кармис может запускать
const APPS = {
  notepad: 'notepad.exe',
  paint: 'mspaint.exe',
  explorer: 'explorer.exe',
  taskmanager: 'taskmgr.exe',
};

function openSafe(url) {
  try {
    const u = new URL(url);
    if (!OPEN_PROTOCOLS.has(u.protocol)) return false;
    shell.openExternal(url);
    return true;
  } catch { return false; }
}


// ---- Установленные программы Windows (меню «Пуск»: классические и Microsoft Store) ----
let startApps = null, startAppsAt = 0;
function listStartApps() {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve([]);
    if (startApps && Date.now() - startAppsAt < 5 * 60 * 1000) return resolve(startApps);
    const cmd = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, out) => {
        let list = [];
        try { const j = JSON.parse(String(out || '').replace(/^\uFEFF/, '')); list = Array.isArray(j) ? j : [j]; } catch { /* пусто */ }
        list = list.filter(x => x && x.Name && x.AppID && !/uninstall|удал|видал|деинстал/i.test(x.Name));
        if (list.length) { startApps = list; startAppsAt = Date.now(); }
        resolve(list);
      });
  });
}
const normApp = s => String(s || '').toLowerCase().replace(/[^a-z0-9а-яіїєґё]+/g, '');
async function findStartApp(names) {
  const list = await listStartApps();
  const want = (Array.isArray(names) ? names : [names]).map(normApp).filter(x => x.length >= 2);
  for (const w of want) {   // 1) точное совпадение, 2) название начинается с запроса, 3) содержит запрос
    let hit = list.find(a => normApp(a.Name) === w);
    if (!hit) hit = list.filter(a => normApp(a.Name).startsWith(w)).sort((a, b) => a.Name.length - b.Name.length)[0];
    if (!hit && w.length >= 4) hit = list.filter(a => normApp(a.Name).includes(w)).sort((a, b) => a.Name.length - b.Name.length)[0];
    if (hit) return { name: hit.Name, id: hit.AppID };
  }
  return null;
}
function launchStartApp(id) {
  id = String(id || '');
  if (process.platform !== 'win32' || !id || /["<>|&;`\r\n]/.test(id)) return false;
  try {
    if (/^[a-z]:\\.*\.exe$/i.test(id) && fs.existsSync(id)) spawn(id, [], { detached: true, stdio: 'ignore' }).unref();
    else spawn('explorer.exe', ['shell:AppsFolder\\' + id], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { return false; }
}


// ---- Міні-вікно: компактний чат поверх усіх вікон. Відкривається ТІЛЬКИ кнопкою в застосунку ----
const MINI_CMDS = new Set(['ready', 'send', 'listen', 'mic', 'mute', 'stop']);
const MINI_EVTS = new Set(['init', 'msg', 'act', 'typing', 'state']);

function sendToMain(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}
function closeMini() {
  if (miniWin && !miniWin.isDestroyed()) miniWin.destroy();
  miniWin = null;
}
function openMini() {
  if (miniWin && !miniWin.isDestroyed()) { miniWin.show(); miniWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 380, h = 560;
  const win = new BrowserWindow({
    width: w, height: h, x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16,
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: true, title: 'Кармис AI',
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  miniWin = win;
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, '..', 'www', 'mini.html'));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  win.on('closed', () => { if (miniWin === win) miniWin = null; sendToMain('mini-closed'); });
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); openSafe(url); }
  });
}
function registerMini() {
  // головне вікно просить відкрити / закрити міні-вікно
  ipcMain.handle('mini-open', (e, opts = {}) => {
    if (!mainWin || e.sender !== mainWin.webContents) return false;
    openMini();
    if (opts && opts.minimizeMain && !mainWin.isDestroyed()) mainWin.minimize();
    return true;
  });
  ipcMain.handle('mini-close', e => {
    const ok = (miniWin && e.sender === miniWin.webContents) || (mainWin && e.sender === mainWin.webContents);
    if (ok) closeMini();
    return !!ok;
  });
  // «розгорнути»: повертаємо головне вікно, міні закриваємо
  ipcMain.handle('mini-expand', e => {
    if (!miniWin || e.sender !== miniWin.webContents) return false;
    if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.show(); mainWin.focus(); }
    closeMini();
    return true;
  });
  // команди з міні-вікна → головне вікно (там уся логіка: модель, дії, голос)
  ipcMain.on('mini-cmd', (e, cmd) => {
    if (!miniWin || e.sender !== miniWin.webContents) return;
    if (!cmd || typeof cmd !== 'object' || !MINI_CMDS.has(cmd.type)) return;
    sendToMain('mini-cmd', { type: cmd.type, text: typeof cmd.text === 'string' ? cmd.text.slice(0, 2000) : undefined });
  });
  // події з головного вікна → міні-вікно (повідомлення, стан, мова інтерфейсу)
  ipcMain.on('mini-evt', (e, evt) => {
    if (!mainWin || e.sender !== mainWin.webContents) return;
    if (!miniWin || miniWin.isDestroyed()) return;
    if (!evt || typeof evt !== 'object' || !MINI_EVTS.has(evt.type)) return;
    miniWin.webContents.send('mini-evt', evt);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120, height: 780, minWidth: 380, minHeight: 560,
    backgroundColor: '#06080d', title: 'Кармис AI', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,   // під час керування ПК вікно згорнуте, але голос і цикл дій мають працювати
    },
  });
  mainWin = win;
  win.on('closed', () => { if (mainWin === win) mainWin = null; closeMini(); });
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); openSafe(url); }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // микрофон, уведомления и буфер обмена — только для нашего локального окна
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));

  // сетевые запросы к API идут через главный процесс, чтобы не упираться в CORS
  ipcMain.handle('http', async (_e, url, opts = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const u = new URL(url);
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Недопустимый адрес');
      let body = opts.body;
      if (body && typeof body === 'object' && body.__form) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(body.__form.fields || {})) fd.append(k, v);
        const f = body.__form.file;
        if (f) fd.append(f.field, new Blob([Buffer.from(f.b64, 'base64')], { type: f.type }), f.name);
        body = fd;
      }
      const res = await fetch(url, { method: opts.method || 'GET', headers: opts.headers || {}, body, signal: ctl.signal });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
      return { ok: false, status: 0, body: JSON.stringify({ message: String((e && e.message) || e) }) };
    } finally { clearTimeout(timer); }
  });

  // то же, но ответ — бинарный (озвучка OpenAI возвращает MP3): отдаём base64
  ipcMain.handle('http-bin', async (_e, url, opts = {}) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const u = new URL(url);
      if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Недопустимый адрес');
      const res = await fetch(url, { method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body, signal: ctl.signal });
      return { ok: res.ok, status: res.status, b64: Buffer.from(await res.arrayBuffer()).toString('base64') };
    } catch (e) {
      return { ok: false, status: 0, b64: Buffer.from(String((e && e.message) || e)).toString('base64') };
    } finally { clearTimeout(timer); }
  });

  ipcMain.handle('open-external', (_e, url) => openSafe(String(url)));

  ipcMain.handle('find-app', (_e, names) => findStartApp(names).catch(() => null));
  ipcMain.handle('launch-start-app', (_e, id) => launchStartApp(id));

  ipcMain.handle('launch-app', (_e, name) => {
    const exe = APPS[name];
    if (!exe || process.platform !== 'win32') return false;
    try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
  });

  registerMini();
  pc.register(() => mainWin);   // керування ноутбуком: екран, мишка, клавіатура, буфер обміну

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => pc.shutdown());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
