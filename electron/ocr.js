'use strict';
/* Кармис AI — локальний OCR Windows (electron/ocr.js).
   Читає текст зі знімка екрана вбудованим рушієм Windows.Media.Ocr: безкоштовно, офлайн, нічого не йде в інтернет.
   Так модель «бачить» назви на логотипах, підписи на картинках, меню ігор і вікна, які не віддають структуру
   через UI Automation, і для цього не потрібна модель зі зором і не треба відправляти знімок.
   Мови розпізнавання беруться з мов профілю Windows (для української чи російської потрібен встановлений мовний пакет).
   Якщо щось не працює, повертається помилка, а Кармис просто лишається на старій схемі (список елементів і знімок). */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PS = String.raw`
param([string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
  function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { Write-Output '{"error":"no-engine"}'; exit 0 }
  $res = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $items = @()
  foreach ($l in $res.Lines) {
    $x1 = 1e9; $y1 = 1e9; $x2 = 0; $y2 = 0
    foreach ($w in $l.Words) {
      $r = $w.BoundingRect
      if ($r.X -lt $x1) { $x1 = $r.X }; if ($r.Y -lt $y1) { $y1 = $r.Y }
      if (($r.X + $r.Width) -gt $x2) { $x2 = $r.X + $r.Width }; if (($r.Y + $r.Height) -gt $y2) { $y2 = $r.Y + $r.Height }
    }
    $items += [pscustomobject]@{ t = $l.Text; x = [int]$x1; y = [int]$y1; w = [int]($x2 - $x1); h = [int]($y2 - $y1) }
  }
  Write-Output (ConvertTo-Json -InputObject @($items) -Compress)
} catch {
  $m = ($_.Exception.Message -replace '[\r\n"\\]', ' ')
  Write-Output ('{"error":"' + $m + '"}')
}
`;

let scriptPath = null, lastError = '';

function ensureScript() {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  scriptPath = path.join(os.tmpdir(), 'karmis-ocr.ps1');
  fs.writeFileSync(scriptPath, '\ufeff' + PS, 'utf8');
  return scriptPath;
}

/* png: Buffer. Повертає { ok:true, items:[{t,x,y,w,h}] } або { ok:false, error } */
function recognize(png, timeoutMs) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'only-windows' });
    let img;
    try { img = path.join(os.tmpdir(), `karmis-ocr-${process.pid}-${Date.now()}.png`); fs.writeFileSync(img, png); }
    catch (e) { return resolve({ ok: false, error: 'tmp: ' + e.message }); }
    let out = '', done = false, p;
    const finish = r => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.unlinkSync(img); } catch { /* ignore */ }
      if (!r.ok) lastError = r.error || '';
      resolve(r);
    };
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish({ ok: false, error: 'timeout' }); }, timeoutMs || 15000);
    try {
      p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), img], { windowsHide: true });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.on('error', e => finish({ ok: false, error: e.message }));
    p.on('close', () => {
      try {
        const j = JSON.parse(out.replace(/^\uFEFF/, '').trim());
        if (j && j.error) return finish({ ok: false, error: String(j.error).slice(0, 160) });
        finish({ ok: true, items: Array.isArray(j) ? j : (j ? [j] : []) });
      } catch { finish({ ok: false, error: 'bad-output: ' + out.slice(0, 80) }); }
    });
  });
}

module.exports = { recognize, lastError: () => lastError };
