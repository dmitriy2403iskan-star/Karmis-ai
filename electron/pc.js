'use strict';
/* =====================================================================
   Кармис AI — керування ноутбуком (головний процес Electron)

   Що вміє: знімок екрана, мишка, клавіатура (в т.ч. кирилиця), буфер обміну.
   Лише Windows. Зовнішніх npm-залежностей немає: введення виконує один
   постійний процес PowerShell (user32.dll: SendInput / mouse_event).

   Запобіжники:
   • усі дії керування працюють тільки всередині «сеансу» (pc-start), який
     renderer відкриває після дозволу користувача;
   • під час сеансу зверху екрана висить червона плашка (на знімках її немає);
   • Ctrl+Alt+Q — аварійна зупинка з будь-якого місця;
   • курсор у лівий верхній кут екрана — теж зупинка (як fail-safe у pyautogui);
   • сеанс сам завершується, якщо 3 хвилини немає жодної дії, і не може
     виконати більше MAX_ACTIONS дій;
   • вікно Кармиса на час сеансу згортається, щоб не заважати і не потрапляти в кадр.
   ===================================================================== */
const { app, BrowserWindow, clipboard, desktopCapturer, screen, globalShortcut, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOTKEY = 'CommandOrControl+Alt+Q';
const MAX_ACTIONS = 400;
const IDLE_MS = 3 * 60 * 1000;
const SHOT_MAX_W = 1120;      // повний знімок за вимогою (режим «Лише знімки», pc_look image)
const SHOT_LOW_W = 768;       // запасний знімок в авто-режимі: рівно одна «плитка» зору в Gemini, вдвічі дешевше
const ZOOM_MAX = 384;         // найбільша сторона фрагмента pc_zoom
const fmt = require('./screenfmt');
const ocr = require('./ocr');
const IS_WIN = process.platform === 'win32';

/* ---------- C#: введення (сумісний з компілятором PowerShell 5.1, тобто C# 5) ---------- */
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class KInput {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  static Dictionary<string, int> K = new Dictionary<string, int>();
  static KInput() {
    K["ctrl"] = 0x11; K["control"] = 0x11; K["shift"] = 0x10; K["alt"] = 0x12;
    K["win"] = 0x5B; K["windows"] = 0x5B; K["cmd"] = 0x5B; K["meta"] = 0x5B; K["super"] = 0x5B;
    K["enter"] = 0x0D; K["return"] = 0x0D; K["tab"] = 0x09; K["esc"] = 0x1B; K["escape"] = 0x1B;
    K["space"] = 0x20; K["backspace"] = 0x08; K["delete"] = 0x2E; K["del"] = 0x2E; K["insert"] = 0x2D;
    K["home"] = 0x24; K["end"] = 0x23; K["pageup"] = 0x21; K["pagedown"] = 0x22;
    K["left"] = 0x25; K["up"] = 0x26; K["right"] = 0x27; K["down"] = 0x28;
    K["printscreen"] = 0x2C; K["capslock"] = 0x14; K["menu"] = 0x5D;
    for (int i = 1; i <= 12; i++) K["f" + i] = 0x6F + i;
    for (char c = 'a'; c <= 'z'; c++) K[c.ToString()] = (int)char.ToUpper(c);
    for (char c = '0'; c <= '9'; c++) K[c.ToString()] = (int)c;
  }

  public static void Init() { SetProcessDPIAware(); }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static string Pos() { POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }

  public static void Button(string b, bool down) {
    uint f;
    if (b == "right") f = down ? 0x0008u : 0x0010u;
    else if (b == "middle") f = down ? 0x0020u : 0x0040u;
    else f = down ? 0x0002u : 0x0004u;
    mouse_event(f, 0, 0, 0, UIntPtr.Zero);
  }

  public static void Wheel(int delta, bool horizontal) {
    mouse_event(horizontal ? 0x01000u : 0x0800u, 0, 0, delta, UIntPtr.Zero);
  }

  static bool Ext(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D;
  }
  static void Key(int vk, bool up) {
    uint f = up ? 2u : 0u;
    if (Ext(vk)) f |= 1u;
    keybd_event((byte)vk, 0, f, UIntPtr.Zero);
  }
  static int Resolve(string p) {
    int v;
    if (K.TryGetValue(p, out v)) return v;
    if (p.Length == 1) { short s = VkKeyScan(p[0]); if (s != -1) return s & 0xFF; }
    throw new Exception("unknown key: " + p);
  }

  public static void Combo(string combo) {
    string[] parts = combo.ToLower().Split('+');
    List<int> vks = new List<int>();
    foreach (string raw in parts) {
      string p = raw.Trim();
      if (p.Length == 0) continue;
      vks.Add(Resolve(p));
    }
    int pressed = 0;
    try {
      for (int i = 0; i < vks.Count; i++) { Key(vks[i], false); pressed++; Thread.Sleep(12); }
    } finally {
      for (int i = pressed - 1; i >= 0; i--) { Key(vks[i], true); Thread.Sleep(8); }
    }
  }

  static INPUT UniIn(char c, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = 0;
    i.u.ki.wScan = (ushort)c;
    i.u.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u);
    return i;
  }
  static INPUT VkIn(ushort vk, bool up) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.dwFlags = up ? 0x0002u : 0u;
    return i;
  }

  public static void TypeText(string s) {
    List<INPUT> list = new List<INPUT>();
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { list.Add(VkIn(0x0D, false)); list.Add(VkIn(0x0D, true)); }
      else if (c == '\t') { list.Add(VkIn(0x09, false)); list.Add(VkIn(0x09, true)); }
      else { list.Add(UniIn(c, false)); list.Add(UniIn(c, true)); }
    }
    int size = Marshal.SizeOf(typeof(INPUT));
    for (int i = 0; i < list.Count; i += 40) {
      int n = Math.Min(40, list.Count - i);
      INPUT[] chunk = new INPUT[n];
      list.CopyTo(i, chunk, 0, n);
      SendInput((uint)n, chunk, size);
      Thread.Sleep(8);
    }
  }
}
`;

/* ---------- PowerShell: читає команди зі stdin по рядку, відповідає рядком ---------- */
const PS_HEAD = String.raw`$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
`;
const PS_TAIL = String.raw`
'@
[KInput]::Init()
} catch {
  [Console]::Out.WriteLine('fail ' + ($_.Exception.Message -replace '[\r\n]+', ' '))
  exit 1
}
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $p = $line.Trim().Split(' ')
    $r = 'ok'
    switch ($p[0]) {
      'move'  { [KInput]::Move([int]$p[1], [int]$p[2]) }
      'down'  { [KInput]::Button($p[1], $true) }
      'up'    { [KInput]::Button($p[1], $false) }
      'wheel' { [KInput]::Wheel([int]$p[1], ($p[2] -eq 'h')) }
      'key'   { [KInput]::Combo($p[1]) }
      'type'  { [KInput]::TypeText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
      'pos'   { $r = [KInput]::Pos() }
      'scan'  { if (-not $script:uia) { throw 'UI Automation недоступний' }; $r = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([KScan]::Scan([int]$p[1], [int]$p[2]))) }
      default { throw ('unknown command ' + $p[0]) }
    }
    [Console]::Out.WriteLine($r)
  } catch {
    [Console]::Out.WriteLine('err ' + ($_.Exception.Message -replace '[\r\n]+', ' '))
  }
}
`;

/* ---------- читання екрана текстом: Windows UI Automation (замість знімка: у рази менше токенів, працює з будь-якою моделлю) ---------- */
const PS_UIA = String.raw`
$script:uia = $true
try {
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -ReferencedAssemblies 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class KScan {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);

  class Ctx {
    public StringBuilder Sb = new StringBuilder();
    public Stopwatch Sw = Stopwatch.StartNew();
    public int Max, BudgetMs, Count, Nodes, Edits, W, H;
    public Dictionary<string, bool> Seen = new Dictionary<string, bool>();
    public bool Done() { return Count >= Max || Sw.ElapsedMilliseconds > BudgetMs || Nodes > 6000; }
  }

  static string Clip(string s, int n) {
    if (s == null) return "";
    s = s.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ").Replace("\"", "'").Trim();
    return s.Length > n ? s.Substring(0, n) + "..." : s;
  }

  static string Role(ControlType t, out bool interactive) {
    interactive = true;
    if (t == ControlType.Button) return "btn";
    if (t == ControlType.Edit) return "edit";
    if (t == ControlType.CheckBox) return "check";
    if (t == ControlType.RadioButton) return "radio";
    if (t == ControlType.ComboBox) return "combo";
    if (t == ControlType.ListItem) return "item";
    if (t == ControlType.MenuItem) return "menu";
    if (t == ControlType.TabItem) return "tab";
    if (t == ControlType.Hyperlink) return "link";
    if (t == ControlType.TreeItem) return "tree";
    if (t == ControlType.DataItem) return "row";
    if (t == ControlType.Slider) return "slider";
    if (t == ControlType.SplitButton) return "btn";
    if (t == ControlType.Spinner) return "spin";
    interactive = false;
    if (t == ControlType.Text) return "text";
    if (t == ControlType.Header || t == ControlType.HeaderItem) return "head";
    if (t == ControlType.Image) return "img";
    return null;
  }

  static void Visit(AutomationElement el, Ctx c) {
    c.Nodes++;
    ControlType t = el.Cached.ControlType;
    bool inter;
    string role = Role(t, out inter);
    if (role == null) return;
    string name = Clip(el.Cached.Name, 48);
    if (!inter && name.Length < 2) return;
    if (inter && name.Length == 0 && t != ControlType.Edit && t != ControlType.ComboBox) return;
    System.Windows.Rect r = el.Cached.BoundingRectangle;
    if (r.IsEmpty || double.IsInfinity(r.Width) || r.Width < 4 || r.Height < 4) return;
    int cx = (int)(r.X + r.Width / 2), cy = (int)(r.Y + r.Height / 2);
    if (cx < 0 || cy < 0 || cx >= c.W || cy >= c.H) return;
    string key = role + "|" + name + "|" + cx + "|" + cy;
    if (c.Seen.ContainsKey(key)) return;
    c.Seen[key] = true;
    c.Count++;
    c.Sb.Append(c.Count).Append(' ').Append(role).Append(" @").Append(cx).Append(',').Append(cy);
    if (name.Length > 0) c.Sb.Append(" \"").Append(name).Append('"');
    if (!el.Cached.IsEnabled) c.Sb.Append(" [off]");
    try {
      if (t == ControlType.Edit && c.Edits < 10) {
        if (el.Cached.IsPassword) { c.Sb.Append(" [password]"); }
        else {
          object po;
          if (el.TryGetCurrentPattern(ValuePattern.Pattern, out po)) {
            string v = Clip(((ValuePattern)po).Current.Value, 60);
            if (v.Length > 0) c.Sb.Append(" =\"").Append(v).Append('"');
          }
        }
        c.Edits++;
      } else if (t == ControlType.CheckBox || t == ControlType.RadioButton) {
        object po2;
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out po2)) {
          ToggleState st = ((TogglePattern)po2).Current.ToggleState;
          if (st == ToggleState.On) c.Sb.Append(" [on]");
        }
      }
    } catch (Exception) { }
    c.Sb.Append('\n');
  }

  static void Walk(AutomationElement el, int depth, CacheRequest cr, TreeWalker tw, Ctx c) {
    if (c.Done()) return;
    try { if (el.Cached.IsOffscreen) return; } catch (Exception) { }
    try { Visit(el, c); } catch (Exception) { }
    if (depth >= 30) return;
    AutomationElement ch;
    try { ch = tw.GetFirstChild(el, cr); } catch (Exception) { return; }
    while (ch != null) {
      if (c.Done()) return;
      Walk(ch, depth + 1, cr, tw, c);
      try { ch = tw.GetNextSibling(ch, cr); } catch (Exception) { break; }
    }
  }

  public static string Scan(int maxItems, int budgetMs) {
    Ctx c = new Ctx();
    c.Max = maxItems; c.BudgetMs = budgetMs;
    c.W = GetSystemMetrics(0); c.H = GetSystemMetrics(1);
    IntPtr fg = GetForegroundWindow();
    string title = "";
    if (fg != IntPtr.Zero) { StringBuilder tb = new StringBuilder(300); GetWindowText(fg, tb, 300); title = tb.ToString(); }
    CacheRequest cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.IsOffscreenProperty);
    cr.Add(AutomationElement.IsEnabledProperty);
    cr.Add(AutomationElement.IsPasswordProperty);
    TreeWalker tw = TreeWalker.ControlViewWalker;
    c.Sb.Append("window \"").Append(Clip(title, 80)).Append("\"\n");
    if (fg != IntPtr.Zero) {
      try { Walk(AutomationElement.FromHandle(fg).GetUpdatedCache(cr), 0, cr, tw, c); } catch (Exception) { }
    }
    /* панель завдань: Пуск, запущені програми, годинник */
    try {
      AutomationElement tray = AutomationElement.RootElement.FindFirst(TreeScope.Children,
        new PropertyCondition(AutomationElement.ClassNameProperty, "Shell_TrayWnd"));
      if (tray != null) {
        c.Max = c.Count + 25;
        c.Sw = Stopwatch.StartNew();
        c.Sb.Append("taskbar:\n");
        Walk(tray.GetUpdatedCache(cr), 0, cr, tw, c);
      }
    } catch (Exception) { }
    return c.Sb.ToString();
  }
}
'@
} catch { $script:uia = $false }
`;

/* ---------- постійний процес введення ---------- */
let proc = null, ready = false, readyP = null, readyRes = null, readyRej = null, buf = '';
let queue = [];
let errBuf = '';
const errTail = () => { const t = errBuf.replace(/\s+/g, ' ').trim(); return t ? ': ' + t.slice(-300) : ''; };

function ensureInput() {
  if (readyP) return readyP;
  if (!IS_WIN) return Promise.reject(new Error('Керування ПК поки працює лише у Windows'));
  errBuf = '';
  readyP = new Promise((res, rej) => { readyRes = res; readyRej = rej; });
  readyP.catch(() => { /* помилку обробить той, хто чекає */ });
  try {
    const file = path.join(app.getPath('userData'), 'karmis-input.ps1');
    const MARK = "[Console]::Out.WriteLine('ready')", cut = PS_TAIL.indexOf(MARK);
    fs.writeFileSync(file, '\ufeff' + PS_HEAD + CSHARP + PS_TAIL.slice(0, cut) + PS_UIA + PS_TAIL.slice(cut), 'utf8');
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const p = readyP; readyP = null; readyRej(e); return p;
  }
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!ready) {
        if (line === 'ready') { ready = true; readyRes(); }
        else if (line.startsWith('fail')) { readyRej(new Error(line.slice(5) || 'не вдалося запустити помічник введення')); }
        continue;
      }
      const cb = queue.shift(); if (cb) cb(line);
    }
  });
  proc.stderr.on('data', d => { errBuf = (errBuf + String(d)).slice(-2000); });
  proc.on('error', e => { if (!ready) readyRej(e); proc = null; ready = false; readyP = null; });
  proc.on('exit', code => {
    const wasReady = ready;
    proc = null; ready = false; readyP = null; buf = '';
    if (!wasReady) readyRej(new Error('помічник введення завершився (код ' + code + ')' + errTail()));
    const q = queue; queue = []; q.forEach(cb => cb('err помічник введення зупинився'));
  });
  setTimeout(() => {
    if (ready) return;
    readyRej(new Error('помічник введення не запустився за 90 с (перший запуск довгий: антивірус перевіряє компіляцію C#)' + errTail()));
    if (proc) { try { proc.kill(); } catch { /* ignore */ } }   // 'exit' скине стан, наступна спроба запустить його знову
  }, 90000);
  return readyP;
}

function send(cmd) {
  return ensureInput().then(() => new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('помічник введення не відповідає')), 15000);
    queue.push(line => {
      clearTimeout(timer);
      if (line.startsWith('err')) rej(new Error(line.slice(4))); else res(line);
    });
    proc.stdin.write(cmd + '\n');
  }));
}

/* ---------- стан сеансу ---------- */
const session = { active: false, started: 0, actions: 0 };
let lastShot = null, idleTimer = null, failTimer = null, overlay = null, getWin = () => null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const touch = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stop('idle'), IDLE_MS);
};

function needSession() {
  if (!session.active) throw new Error('Сеанс керування не запущено');
  if (++session.actions > MAX_ACTIONS) { stop('limit'); throw new Error('Перевищено ліміт дій за сеанс'); }
  touch();
}

/* ---------- плашка «Кармис керує ПК» ---------- */
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function showOverlay(label, goal, hint) {
  closeOverlay();
  const d = screen.getPrimaryDisplay(), W = 560, H = 58;
  overlay = new BrowserWindow({
    x: d.bounds.x + Math.round((d.bounds.width - W) / 2), y: d.bounds.y + 8, width: W, height: H,
    frame: false, transparent: true, resizable: false, movable: false, focusable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  try { overlay.setContentProtection(true); } catch { /* не критично */ }
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:transparent;font:13px 'Segoe UI',system-ui,sans-serif;overflow:hidden}
    .b{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:10px;padding:0 16px;border-radius:14px;
       background:rgba(120,12,22,.94);color:#fff;border:1px solid rgba(255,255,255,.25)}
    .d{width:10px;height:10px;border-radius:50%;background:#ff5a5f;animation:p 1s infinite}
    @keyframes p{50%{opacity:.25}}
    .t{flex:1;min-width:0}.t b{display:block;font-size:13px}.t span{display:block;opacity:.85;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    kbd{font:600 11px 'Segoe UI';background:rgba(255,255,255,.18);border-radius:6px;padding:3px 7px;white-space:nowrap}
  </style><div class="b"><i class="d"></i><div class="t"><b>${esc(label)}</b><span id="s">${esc(goal)}</span></div><kbd>${esc(hint)}</kbd></div>`;
  overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  overlay.once('ready-to-show', () => { if (overlay && !overlay.isDestroyed()) overlay.showInactive(); });
}
function overlayStatus(text) {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.executeJavaScript(`document.getElementById('s').textContent=${JSON.stringify(String(text || '').slice(0, 120))}`).catch(() => {});
}
function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  overlay = null;
}

/* ---------- зупинка сеансу ---------- */
function stop(reason) {
  if (!session.active) return false;
  session.active = false;
  clearTimeout(idleTimer); clearInterval(failTimer);
  try { globalShortcut.unregister(HOTKEY); } catch { /* ignore */ }
  if (proc && ready) { send('up left').catch(() => {}); send('up right').catch(() => {}); }   // не залишати кнопку затиснутою
  closeOverlay();
  const w = getWin();
  if (w && !w.isDestroyed()) {
    if (w.isMinimized()) w.restore();
    w.show(); w.focus();
    w.webContents.send('pc-stopped', reason || 'user');
  }
  return true;
}

/* ---------- знімок екрана ---------- */
async function grabNative() {
  const d = screen.getPrimaryDisplay(), sf = d.scaleFactor || 1;
  const sw = Math.round(d.size.width * sf), sh = Math.round(d.size.height * sf);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sw, height: sh }, fetchWindowIcons: false });
  const src = sources.find(s => String(s.display_id) === String(d.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Не вдалося зняти екран');
  return { img: src.thumbnail, sw, sh };
}

async function shot(o = {}) {
  const { img: full, sw, sh } = await grabNative();
  let img = full;
  const real = img.getSize();
  const maxW = o.maxW || SHOT_MAX_W;
  const w = Math.min(maxW, real.width), h = Math.max(1, Math.round(real.height * w / real.width));
  if (w !== real.width) img = img.resize({ width: w, height: h, quality: 'good' });
  lastShot = { w, h, sw, sh };
  return { ok: true, mime: 'image/jpeg', b64: img.toJPEG(o.quality || 65).toString('base64'), w, h, sw, sh };
}

/* маленький фрагмент екрана (логотип, значок, картинка): координати в просторі останнього стану, ≤ ZOOM_MAX px */
async function zoomShot(o = {}) {
  if (!lastShot) throw new Error('Спочатку потрібен стан екрана');
  const { img, sw, sh } = await grabNative();
  const k = lastShot.sw / lastShot.w;
  let w = Number(o.w) || 0, h = Number(o.h) || 0;
  const cx = Number(o.x), cy = Number(o.y);
  if (!isFinite(cx) || !isFinite(cy)) throw new Error('x, y?');
  if (!w) w = 160; if (!h) h = w;
  w = clamp(Math.round(w * k), 24, sw); h = clamp(Math.round(h * k), 24, sh);
  const x = clamp(Math.round(cx * k - w / 2), 0, sw - w), y = clamp(Math.round(cy * k - h / 2), 0, sh - h);
  let crop = img.crop({ x, y, width: w, height: h });
  const side = Math.max(w, h), target = clamp(side, 192, ZOOM_MAX);   // дрібне збільшуємо, велике зменшуємо
  if (side !== target) { const kk = target / side; crop = crop.resize({ width: Math.max(1, Math.round(w * kk)), height: Math.max(1, Math.round(h * kk)), quality: 'best' }); }
  const sz = crop.getSize();
  return { ok: true, mime: 'image/jpeg', b64: crop.toJPEG(70).toString('base64'), w: sz.width, h: sz.height, x: Math.round(x / k), y: Math.round(y / k) };
}

/* координати зі знімка → фізичні пікселі екрана (відступ 8 px від країв: кут зарезервований для fail-safe) */
function phys(x, y) {
  if (!lastShot) throw new Error('Спочатку потрібен знімок екрана');
  x = Number(x); y = Number(y);
  if (!isFinite(x) || !isFinite(y)) throw new Error('Некоректні координати');
  return [
    clamp(Math.round(x * lastShot.sw / lastShot.w), 8, lastShot.sw - 8),
    clamp(Math.round(y * lastShot.sh / lastShot.h), 8, lastShot.sh - 8),
  ];
}

const wrap = fn => async (_e, ...a) => {
  try { const r = await fn(...a); return r === undefined ? { ok: true } : r; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
};

function register(winGetter) {
  getWin = winGetter || getWin;

  ipcMain.handle('pc-warmup', () => { if (IS_WIN) ensureInput().catch(() => {}); return IS_WIN; });
  ipcMain.handle('pc-info', () => ({ ok: IS_WIN, platform: process.platform, hotkey: 'Ctrl+Alt+Q' }));

  ipcMain.handle('pc-start', wrap(async (o = {}) => {
    if (!IS_WIN) throw new Error('Керування ПК поки працює лише у Windows');
    await ensureInput();
    if (session.active) stop('restart');
    session.active = true; session.started = Date.now(); session.actions = 0; lastShot = null;
    let hotkey = false;
    try { hotkey = globalShortcut.register(HOTKEY, () => stop('hotkey')); } catch { /* ignore */ }
    failTimer = setInterval(() => {
      if (Date.now() - session.started < 1500) return;
      const p = screen.getCursorScreenPoint();
      if (p.x <= 1 && p.y <= 1) stop('failsafe');
    }, 250);
    showOverlay(String(o.label || 'Karmis controls this PC').slice(0, 60), String(o.goal || '').slice(0, 120), 'Ctrl+Alt+Q');
    touch();
    const w = getWin(); if (w && !w.isDestroyed()) w.minimize();
    return { ok: true, hotkey };
  }));

  ipcMain.handle('pc-stop', wrap(() => { stop('agent'); }));

  ipcMain.handle('pc-window', wrap(op => {
    const w = getWin(); if (!w || w.isDestroyed()) return;
    if (op === 'show') { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
    else if (op === 'hide' && session.active) w.minimize();
  }));

  ipcMain.handle('pc-status', wrap(t => { overlayStatus(t); }));

  /* стан екрана: текст із UI Automation і/або знімок. Координати в тексті — у тому ж просторі, що й у знімка (pc_mouse), або в пікселях екрана */
  ipcMain.handle('pc-observe', wrap(async (o = {}) => {
    if (!session.active) throw new Error('Сеанс керування не запущено');
    touch();
    const mode = ['text', 'auto', 'both', 'image'].includes(o.image) ? o.image : 'auto';
    const d = screen.getPrimaryDisplay(), sf = d.scaleFactor || 1;
    const sw = Math.round(d.size.width * sf), sh = Math.round(d.size.height * sf);
    let text = null, scanErr = '';
    if (mode !== 'image') {
      try { text = Buffer.from(await send('scan 90 2500'), 'base64').toString('utf8'); }
      catch (e) { scanErr = String(e.message || e).slice(0, 160); }
    }
    const uia = text ? (text.match(/^\d+ /gm) || []).length : 0;

    /* 1) мало елементів (ігри, Qt, значки, логотипи) або явний запит: читаємо текст локальним OCR. Це дешевше за знімок і
          не вимагає моделі зі зором */
    let ocrItems = null, ocrErr = '';
    if (mode !== 'image' && (o.ocr === true || uia < 6) && o.ocr !== false) {
      try {
        const { img } = await grabNative();
        const r = await ocr.recognize(img.toPNG(), 15000);
        if (r.ok) ocrItems = r.items; else ocrErr = r.error || '?';
      } catch (e) { ocrErr = String(e.message || e).slice(0, 120); }
    }
    const ocrUseful = !!ocrItems && ocrItems.filter(i => i && String(i.t || '').trim().length >= 2).length >= 3;

    /* 2) знімок лише коли без нього не обійтись: режим «Лише знімки», явний запит або ні списку, ні OCR */
    const wantImage = mode === 'image' || mode === 'both' || (mode === 'auto' && uia < 6 && !ocrUseful);
    const res = { ok: true, sw, sh, scanErr, ocrErr };
    if (wantImage) {
      const s = await shot(mode === 'image' || mode === 'both' ? {} : { maxW: SHOT_LOW_W, quality: 60 });   // виставляє lastShot
      res.image = { mime: s.mime, b64: s.b64, low: !(mode === 'image' || mode === 'both') }; res.w = s.w; res.h = s.h;
    } else { lastShot = { w: sw, h: sh, sw, sh }; res.w = sw; res.h = sh; }

    /* 3) стискаємо й переводимо координати в простір знімка (якщо він є) */
    const k = res.w / sw;
    let out = text ? fmt.compactObs(text, { k }) : { text: '', count: 0 };
    let ocrAdded = 0;
    if (ocrItems && ocrItems.length) {
      const m = fmt.mergeOcr(out.text, ocrItems, { k });
      out = { text: m.text, count: out.count }; ocrAdded = m.added;
    }
    res.count = out.count + ocrAdded;
    res.ocr = ocrAdded;
    if (out.text) res.text = out.text.trim();
    return res;
  }));

  /* фрагмент екрана для pc_zoom: крихітне зображення замість повного знімка */
  ipcMain.handle('pc-zoom', wrap(async (o = {}) => {
    if (!session.active) throw new Error('Сеанс керування не запущено');
    touch();
    return zoomShot(o);
  }));

  ipcMain.handle('pc-screenshot', wrap(async () => { needSession(); return shot(); }));

  ipcMain.handle('pc-mouse', wrap(async (o = {}) => {
    needSession();
    const op = String(o.op || 'click');
    const btn = op === 'right' ? 'right' : op === 'middle' ? 'middle' : 'left';
    if (['click', 'double', 'right', 'middle'].includes(op)) {
      const [x, y] = phys(o.x, o.y);
      await send(`move ${x} ${y}`); await sleep(70);
      for (let i = 0; i < (op === 'double' ? 2 : 1); i++) {
        if (i) await sleep(90);
        await send(`down ${btn}`); await sleep(35); await send(`up ${btn}`);
      }
    } else if (op === 'move') {
      const [x, y] = phys(o.x, o.y); await send(`move ${x} ${y}`);
    } else if (op === 'drag') {
      const [x1, y1] = phys(o.x, o.y), [x2, y2] = phys(o.x2, o.y2);
      await send(`move ${x1} ${y1}`); await sleep(80); await send('down left'); await sleep(80);
      for (let i = 1; i <= 10; i++) { await send(`move ${Math.round(x1 + (x2 - x1) * i / 10)} ${Math.round(y1 + (y2 - y1) * i / 10)}`); await sleep(20); }
      await sleep(80); await send('up left');
    } else if (op === 'scroll') {
      if (o.x != null && o.y != null) { const [x, y] = phys(o.x, o.y); await send(`move ${x} ${y}`); await sleep(40); }
      const n = clamp(Math.round(Number(o.amount) || 0), -30, 30);
      if (!n) throw new Error('Не вказано, наскільки прокрутити');
      await send(`wheel ${o.horizontal ? n * 120 : -n * 120} ${o.horizontal ? 'h' : 'v'}`);   // amount > 0 — вниз / праворуч
    } else throw new Error('Невідома дія миші: ' + op);
  }));

  ipcMain.handle('pc-type', wrap(async text => {
    needSession();
    text = String(text == null ? '' : text);
    if (!text) throw new Error('Порожній текст');
    if (text.length > 4000) throw new Error('Занадто довгий текст (максимум 4000 символів)');
    await send('type ' + Buffer.from(text, 'utf8').toString('base64'));
  }));

  ipcMain.handle('pc-key', wrap(async keys => {
    needSession();
    const k = String(keys || '').toLowerCase().replace(/\s+/g, '');
    if (!k || k.length > 40 || !/^[a-z0-9+_\-,.;'[\]/\\`=]+$/.test(k)) throw new Error('Некоректна комбінація клавіш');
    await send('key ' + k);
  }));

  ipcMain.handle('pc-clip-read', wrap(() => {
    const text = clipboard.readText() || '';
    return { ok: true, text: text.slice(0, 8000), truncated: text.length > 8000, hasImage: !clipboard.readImage().isEmpty() };
  }));

  ipcMain.handle('pc-clip-write', wrap(text => {
    text = String(text == null ? '' : text);
    if (text.length > 100000) throw new Error('Занадто довгий текст');
    clipboard.writeText(text);
  }));

  /* діагностика для кнопки «Перевірити» у налаштуваннях: нічого не рухає й не натискає */
  ipcMain.handle('pc-selftest', wrap(async () => {
    const out = { ok: true, platform: process.platform };
    if (!IS_WIN) { out.ok = false; out.error = 'Потрібен Windows'; return out; }
    try { const s = await shot(); out.screen = `${s.w}×${s.h} (екран ${s.sw}×${s.sh})`; } catch (e) { out.ok = false; out.screenError = e.message; }
    try { out.cursor = await send('pos'); } catch (e) { out.ok = false; out.inputError = e.message; }
    try { out.clipboard = clipboard.readText().length + ' симв.'; } catch (e) { out.clipboard = 'помилка'; }
    try {   // текстовий режим екрана (не критично: без нього працюватимуть знімки)
      const t = Buffer.from(await send('scan 40 2500'), 'base64').toString('utf8');
      out.uia = (t.match(/^\d+ /gm) || []).length + ' ел.';
    } catch (e) { out.uia = 'недоступно (' + String(e.message || e).slice(0, 80) + ')'; }
    try {   // локальний OCR (не критично)
      const { img } = await grabNative();
      const r = await ocr.recognize(img.toPNG(), 15000);
      out.ocr = r.ok ? r.items.length + ' рядків' : 'недоступно (' + String(r.error || '?').slice(0, 80) + ')';
    } catch (e) { out.ocr = 'недоступно (' + String(e.message || e).slice(0, 80) + ')'; }
    return out;
  }));
}

function shutdown() {
  stop('quit');
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  if (proc) { try { proc.kill(); } catch { /* ignore */ } }
}

module.exports = { register, shutdown };
