'use strict';
/* Тексти й кнопки дозволів для Android. Підключається ПІСЛЯ computer.js, щоб перекрити його «ноутбучні» тексти. */
(function () {
  const Cap = window.Capacitor;
  const P = Cap && Cap.Plugins && Cap.Plugins.KarmisPhone;
  if (!window.__phonePc || !P) return;
  /* ---- переклади: на телефоні замість «ноутбук / Windows» ---- */
const texts = {
    uk: {
      'ph.needA11y': 'Щоб Кармис міг керувати телефоном, увімкни службу доступності: Налаштування → Спеціальні можливості → Кармис AI → Увімкнути. На Android 13+ спершу: Налаштування → Додатки → Кармис AI → ⋮ → «Дозволити обмежені налаштування». Я відкрив налаштування спеціальних можливостей.',
      'ph.needOverlay': 'Для міні-вікна дозволь «Показувати поверх інших додатків» для Кармис AI. Відкриваю налаштування…',
      'ph.btnA11y': 'Служба доступності', 'ph.btnOverlay': 'Поверх інших вікон', 'ph.a11yOk': 'Служба доступності: увімкнено', 'ph.a11yOff': 'Служба доступності: вимкнено (Налаштування → Спеціальні можливості → Кармис AI)',
      'ph.overlayOk': 'Міні-вікно поверх додатків: дозволено', 'ph.overlayOff': 'Міні-вікно поверх додатків: не дозволено',
      'set.pcTitle': 'Керування телефоном',
      'set.pcOn': 'Дозволити Кармису бачити екран і керувати телефоном (дотики, прокрутка, ввід)',
      'set.pcHint': 'Кармис читає екран через службу доступності (тексти й кнопки), натискає, гортає й друкує. Зупинка в будь-який момент: «Стоп» у сповіщенні або ✕ у міні-вікні. Паролі, коди й платежі він не вводить без твого прямого слова.',
      'c.pcEnable': 'Кармис зможе бачити екран і натискати за тебе в будь-яких додатках. Для цього потрібно один раз увімкнути службу доступності. Вмикати?',
      'c.pcAuto': 'У режимі «Авто» Кармис діятиме без підтвердження кожної дії. Зупинка: «Стоп» у сповіщенні. Увімкнути?',
      'pc.banner': 'Кармис керує телефоном', 'pc.started': 'Керування телефоном розпочато',
      'pc.consent': 'Кармис хоче керувати телефоном: «{g}». Він бачитиме екран і натискатиме за тебе. Стоп у сповіщенні. Дозволяєш?',
      'pc.onlyWin': 'Керування телефоном недоступне в цій збірці',
      'pc.by.user': 'Керування зупинено.',
    },
    ru: {
      'ph.needA11y': 'Чтобы Кармис мог управлять телефоном, включи службу доступности: Настройки → Специальные возможности → Кармис AI → Включить. На Android 13+ сначала: Настройки → Приложения → Кармис AI → ⋮ → «Разрешить ограниченные настройки». Я открыл настройки специальных возможностей.',
      'ph.needOverlay': 'Для мини-окна разреши «Показывать поверх других приложений» для Кармис AI. Открываю настройки…',
      'ph.btnA11y': 'Служба доступности', 'ph.btnOverlay': 'Поверх других окон', 'ph.a11yOk': 'Служба доступности: включена', 'ph.a11yOff': 'Служба доступности: выключена (Настройки → Специальные возможности → Кармис AI)',
      'ph.overlayOk': 'Мини-окно поверх приложений: разрешено', 'ph.overlayOff': 'Мини-окно поверх приложений: не разрешено',
      'set.pcTitle': 'Управление телефоном',
      'set.pcOn': 'Разрешить Кармису видеть экран и управлять телефоном (касания, прокрутка, ввод)',
      'set.pcHint': 'Кармис читает экран через службу доступности (тексты и кнопки), нажимает, листает и печатает. Остановка в любой момент: «Стоп» в уведомлении или ✕ в мини-окне. Пароли, коды и платежи он не вводит без твоего прямого слова.',
      'c.pcEnable': 'Кармис сможет видеть экран и нажимать за тебя в любых приложениях. Для этого нужно один раз включить службу доступности. Включить?',
      'c.pcAuto': 'В режиме «Авто» Кармис будет действовать без подтверждения каждого действия. Остановка: «Стоп» в уведомлении. Включить?',
      'pc.banner': 'Кармис управляет телефоном', 'pc.started': 'Управление телефоном начато',
      'pc.consent': 'Кармис хочет управлять телефоном: «{g}». Он будет видеть экран и нажимать за тебя. Стоп в уведомлении. Разрешаешь?',
      'pc.onlyWin': 'Управление телефоном недоступно в этой сборке',
      'pc.by.user': 'Управление остановлено.',
    },
    be: {
      'ph.needA11y': 'Каб Кармис мог кіраваць тэлефонам, уключы службу даступнасці: Налады → Спецыяльныя магчымасці → Кармис AI → Уключыць. На Android 13+ спачатку: Налады → Праграмы → Кармис AI → ⋮ → «Дазволіць абмежаваныя налады». Я адкрыў налады спецыяльных магчымасцей.',
      'ph.needOverlay': 'Для міні-акна дазволь «Паказваць паверх іншых праграм» для Кармис AI. Адкрываю налады…',
      'ph.btnA11y': 'Служба даступнасці', 'ph.btnOverlay': 'Паверх іншых акон', 'ph.a11yOk': 'Служба даступнасці: уключана', 'ph.a11yOff': 'Служба даступнасці: выключана (Налады → Спецыяльныя магчымасці → Кармис AI)',
      'ph.overlayOk': 'Міні-акно паверх праграм: дазволена', 'ph.overlayOff': 'Міні-акно паверх праграм: не дазволена',
      'set.pcTitle': 'Кіраванне тэлефонам',
      'set.pcOn': 'Дазволіць Кармісу бачыць экран і кіраваць тэлефонам (дотыкі, пракрутка, увод)',
      'set.pcHint': 'Кармис чытае экран праз службу даступнасці (тэксты і кнопкі), націскае, гартае і друкуе. Спыніць можна ў любы момант: «Стоп» у апавяшчэнні або ✕ у міні-акне.',
      'pc.banner': 'Кармис кіруе тэлефонам', 'pc.started': 'Кіраванне тэлефонам пачата',
      'pc.by.user': 'Кіраванне спынена.',
    },
    en: {
      'ph.needA11y': 'For Karmis to control the phone, turn on the accessibility service: Settings → Accessibility → Karmis AI → On. On Android 13+ first: Settings → Apps → Karmis AI → ⋮ → “Allow restricted settings”. I opened the accessibility settings.',
      'ph.needOverlay': 'For the mini window, allow “Display over other apps” for Karmis AI. Opening settings…',
      'ph.btnA11y': 'Accessibility service', 'ph.btnOverlay': 'Display over apps', 'ph.a11yOk': 'Accessibility service: on', 'ph.a11yOff': 'Accessibility service: off (Settings → Accessibility → Karmis AI)',
      'ph.overlayOk': 'Mini window over apps: allowed', 'ph.overlayOff': 'Mini window over apps: not allowed',
      'set.pcTitle': 'Phone control',
      'set.pcOn': 'Let Karmis see the screen and control the phone (taps, scrolling, typing)',
      'set.pcHint': 'Karmis reads the screen through the accessibility service (texts and buttons), taps, scrolls and types. Stop any time: “Stop” in the notification or ✕ in the mini window. It never enters passwords, codes or payments without your explicit word.',
      'c.pcEnable': 'Karmis will be able to see the screen and tap for you in any app. This needs the accessibility service turned on once. Enable?',
      'pc.banner': 'Karmis is controlling the phone', 'pc.started': 'Phone control started',
      'pc.by.user': 'Control stopped.',
    },
  };


  for (const l of Object.keys(texts)) if (typeof I18N !== 'undefined' && I18N[l]) Object.assign(I18N[l], texts[l]);
  if (typeof GROUPS !== 'undefined') GROUPS.pc = 'Керування телефоном';

  /* кнопки дозволів у налаштуваннях */
  document.addEventListener('DOMContentLoaded', () => {
    const test = document.getElementById('btnPcTest');
    if (!test || !test.parentNode) return;
    const row = document.createElement('div');
    row.className = 'row';
    row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0';
    const mk = (id, key, fn) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = test.className; b.id = id;
      b.textContent = T(key);
      b.onclick = () => { try { fn(); } catch { /* ignore */ } };
      row.appendChild(b);
      return b;
    };
    const b1 = mk('btnPhA11y', 'ph.btnA11y', () => P.openAccessibilitySettings());
    const b2 = mk('btnPhOverlay', 'ph.btnOverlay', () => P.requestOverlay());
    test.parentNode.insertBefore(row, test);
    const relabel = () => { b1.textContent = T('ph.btnA11y'); b2.textContent = T('ph.btnOverlay'); };
    setInterval(relabel, 4000);

    /* при вмиканні керування одразу підказуємо, що ще треба дозволити */
    const sw = document.getElementById('setPcOn');
    if (sw) sw.addEventListener('change', async () => {
      if (!sw.checked) return;
      try {
        const s = await P.status();
        if (!s.a11y) { if (typeof toast === 'function') toast(T('ph.needA11y'), 9000); await P.openAccessibilitySettings(); }
      } catch { /* ignore */ }
    });
  });
})();
