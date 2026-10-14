'use strict';
// 1) Добавляет в AndroidManifest.xml разрешения (микрофон, уведомления,
//    foreground-service), <queries> для TTS и для списка запускаемых
//    приложений, и регистрирует ListenService.
// 2) Копирует Java-файлы (ListenService, KarmisSystemPlugin, а также управление телефоном:
//    KarmisAccessibilityService, PhoneOverlayService, KarmisPhonePlugin) в пакет приложения
//    и ресурсы службы доступности (res/xml, res/values).
// 3) Регистрирует плагины в MainActivity.java.
//
// Запускается автоматически из `npm run android:add` после `cap add android`.

const fs = require('fs');
const path = require('path');

const APP_ID = require('../capacitor.config.json').appId; // ai.karmis.app
const pkgPath = APP_ID.split('.').join(path.sep);

const root = path.join(__dirname, '..', 'android');
const manifestFile = path.join(root, 'app', 'src', 'main', 'AndroidManifest.xml');
const javaDir = path.join(root, 'app', 'src', 'main', 'java', pkgPath);
const mainActivityFile = path.join(javaDir, 'MainActivity.java');

if (!fs.existsSync(manifestFile)) {
  console.error('AndroidManifest.xml не найден. Сначала выполни: npx cap add android');
  process.exit(1);
}

// --- 1. Манифест ---------------------------------------------------------
let xml = fs.readFileSync(manifestFile, 'utf8');

const perms = [
  'android.permission.INTERNET',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.SYSTEM_ALERT_WINDOW',               // мини-окно поверх приложений
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',    // сервис мини-окна / управления телефоном
];
const addPerms = perms
  .filter(p => !xml.includes(`"${p}"`))
  .map(p => `    <uses-permission android:name="${p}" />`)
  .join('\n');

let queries = '';
if (!xml.includes('<queries>')) {
  queries =
    '    <queries>\n' +
    '        <intent>\n            <action android:name="android.intent.action.TTS_SERVICE" />\n        </intent>\n' +
    '        <intent>\n            <action android:name="android.intent.action.MAIN" />\n            <category android:name="android.intent.category.LAUNCHER" />\n        </intent>\n' +
    '    </queries>';
} else if (!xml.includes('android.intent.action.TTS_SERVICE')) {
  xml = xml.replace(
    '<queries>',
    '<queries>\n        <intent>\n            <action android:name="android.intent.action.TTS_SERVICE" />\n        </intent>\n        <intent>\n            <action android:name="android.intent.action.MAIN" />\n            <category android:name="android.intent.category.LAUNCHER" />\n        </intent>'
  );
}

const addAll = [addPerms, queries].filter(Boolean).join('\n');
if (addAll) {
  xml = xml.replace(/<\/manifest>\s*$/, `${addAll}\n</manifest>\n`);
}

const serviceDecl =
  '        <service\n' +
  '            android:name=".ListenService"\n' +
  '            android:exported="false"\n' +
  '            android:foregroundServiceType="microphone" />';
if (!xml.includes('.ListenService')) {
  xml = xml.replace(/<\/application>\s*$/, `${serviceDecl}\n    </application>\n`);
}

const phoneServices =
  '        <service\n' +
  '            android:name=".PhoneOverlayService"\n' +
  '            android:exported="false"\n' +
  '            android:foregroundServiceType="specialUse">\n' +
  '            <property\n' +
  '                android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\n' +
  '                android:value="phone_control_overlay" />\n' +
  '        </service>\n' +
  '        <service\n' +
  '            android:name=".KarmisAccessibilityService"\n' +
  '            android:exported="true"\n' +
  '            android:label="Кармис AI"\n' +
  '            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">\n' +
  '            <intent-filter>\n' +
  '                <action android:name="android.accessibilityservice.AccessibilityService" />\n' +
  '            </intent-filter>\n' +
  '            <meta-data\n' +
  '                android:name="android.accessibilityservice"\n' +
  '                android:resource="@xml/karmis_accessibility" />\n' +
  '        </service>';
if (!xml.includes('.KarmisAccessibilityService')) {
  xml = xml.replace(/<\/application>\s*$/m, `${phoneServices}\n    </application>`);
}

fs.writeFileSync(manifestFile, xml);
console.log('Манифест обновлён (permissions, queries, ListenService, PhoneOverlayService, KarmisAccessibilityService).');

// --- 2. Java-файлы сервиса и плагина --------------------------------------
fs.mkdirSync(javaDir, { recursive: true });
for (const name of ['ListenService.java', 'KarmisSystemPlugin.java', 'KarmisAccessibilityService.java', 'PhoneOverlayService.java', 'KarmisPhonePlugin.java']) {
  const src = path.join(__dirname, 'android-src', name);
  const dst = path.join(javaDir, name);
  fs.copyFileSync(src, dst);
  console.log('Скопировано: ' + path.relative(root, dst));
}

// --- 2b. Ресурсы службы доступности ---------------------------------------
const resRoot = path.join(root, 'app', 'src', 'main', 'res');
for (const rel of ['xml/karmis_accessibility.xml', 'values/karmis_phone_strings.xml']) {
  const dst = path.join(resRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'android-res', rel), dst);
  console.log('Скопировано: ' + path.relative(root, dst));
}

// --- 3. Регистрация плагина в MainActivity --------------------------------
if (fs.existsSync(mainActivityFile)) {
  let java = fs.readFileSync(mainActivityFile, 'utf8');
  const wanted = ['KarmisSystemPlugin', 'KarmisPhonePlugin'].filter(n => !java.includes('registerPlugin(' + n + '.class)'));
  if (wanted.length) {
    const lines = wanted.map(n => '        registerPlugin(' + n + '.class);\n').join('');
    if (/class MainActivity extends BridgeActivity\s*{/.test(java) && !/onCreate/.test(java)) {
      java = java.replace(
        /class MainActivity extends BridgeActivity\s*{/,
        'class MainActivity extends BridgeActivity {\n' +
        '    @Override\n' +
        '    public void onCreate(android.os.Bundle savedInstanceState) {\n' +
        lines +
        '        super.onCreate(savedInstanceState);\n' +
        '    }\n'
      );
      fs.writeFileSync(mainActivityFile, java);
      console.log('MainActivity.java: плагины зарегистрированы (' + wanted.join(', ') + ').');
    } else if (/registerPlugin\(/.test(java)) {
      // onCreate уже есть: вставляем недостающие регистрации перед super.onCreate(...)
      java = java.replace(/(\n\s*)super\.onCreate\(/, '\n' + lines + '$1super.onCreate(');
      fs.writeFileSync(mainActivityFile, java);
      console.log('MainActivity.java: добавлены регистрации (' + wanted.join(', ') + ').');
    } else {
      console.warn('MainActivity.java уже содержит onCreate — добавь вручную строки:\n' + lines + 'перед super.onCreate(...)');
    }
  }
} else {
  console.warn('MainActivity.java не найден по ожидаемому пути: ' + mainActivityFile);
}

console.log('\nГотово. Дальше: npx cap sync android, затем npm run android:open.');
