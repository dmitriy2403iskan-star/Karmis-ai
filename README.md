# Karmis AI

A personal voice and text AI assistant inspired by J.A.R.V.I.S. Bring your own API key, then chat or talk to Karmis and let it handle everyday tasks: open sites and apps, build routes, check the weather, set timers, take notes, generate images, make mood playlists and more.

One codebase, three targets:

| Target | How to get it |
|---|---|
| Web / PWA | open `www/index.html` or host the `www/` folder |
| Windows (.exe) | Electron: `npm run build:win` or GitHub Actions |
| Android (.apk) | Capacitor: GitHub Actions or Android Studio |

## Что нового в 1.9.0: экран дешевле и умнее, больше бесплатных моделей со зрением

**Как Кармис теперь «видит» экран (лесенка от дешёвого к дорогому).** Модель получает только то, что действительно нужно:

1. **Список элементов** (Windows UI Automation) в сжатом виде: без служебных номеров, без дублей и шума, с обрезанными названиями (на тестовом образце на 46% короче). Старые состояния экрана из истории по-прежнему вычищаются: в запросе всегда только свежее.
2. **Текст прямо с экрана через локальный OCR Windows.** Включается сам, когда элементов мало (игры, Qt, логотипы, картинки), или по `pc_look {ocr:true}`. Читает вордмарки логотипов («YouTube», «Spotify»), подписи на картинках, меню игр. Бесплатно, без интернета, картинка никуда не уходит, модель со зрением не нужна. Строки приходят как `ocr @x,y "текст"`, по ним можно кликать.
3. **Крошечный фрагмент `pc_zoom {x,y,w,h}`.** Для значков и графических логотипов без текста: до 384 px по длинной стороне вместо полного снимка (у OpenAI-совместимых провайдеров с `detail: low`).
4. **Полный снимок** только в крайнем случае: теперь 768 px (в Gemini ровно одна «плитка», вдвое дешевле прежних 1120 px). Режим «Только снимки» работает как раньше.

Также исправлено: `pc_look` с `image:true` на самом деле не форсировал снимок (флаг терялся в `runAction`), и теперь действия могут прикладывать картинку к ответу модели.

**Новые бесплатные провайдеры со зрением** (ключи можно перечислять через запятую, при лимите Кармис берёт следующий):

| Провайдер | Модель со зрением | Что нужно |
|---|---|---|
| Z.ai | `glm-4.6v-flash`, бесплатно, один запрос за раз | ключ на z.ai |
| Cloudflare Workers AI | `llama-4-scout` и др., 10 000 нейронов в день бесплатно | ключ в виде `ACCOUNT_ID:API_TOKEN` |
| SiliconFlow | `Qwen2.5-VL-7B-Instruct` | бесплатно после подтверждения личности |

Уже были: Gemini, GitHub Models, Mistral, Groq, OpenRouter (`:free`), SambaNova, NVIDIA NIM. Порядок выбора: сначала бесплатные, платные OpenAI и Claude в самом конце.

**Если докинуть ключ на ~30 грн (≈ $0,7).** Самые дешёвые модели со зрением стоят около $0,10 за млн входных токенов (GPT-4.1 nano, Gemini 2.5 Flash-Lite, Llama 4 Scout, Mistral Small). Для OpenAI модель по умолчанию для экрана теперь `gpt-4.1-nano`. Это примерно 7 млн входных токенов; при ~6 тыс. токенов на шаг (системная инструкция + экран + история, оценка) выходит порядка тысячи шагов управления ПК. Фактический расход зависит от длины истории.

**Проверка:** `npm test` (сжатие состояния экрана и слияние OCR). Сам OCR и `pc_zoom` запускаются только в Windows: кнопка «Проверить» в Настройках → Управление ноутбуком покажет «OCR: N рядков» или причину. Для украинского и русского текста нужны языковые пакеты Windows.

## Features

- **Chat and voice** with continuous listening and a wake word ("Jarvis")
- **Many AI providers:** Google Gemini, Groq, OpenRouter, Mistral, Cerebras, GitHub Models, SambaNova, NVIDIA NIM, DeepSeek, OpenAI, Anthropic, or any OpenAI-compatible endpoint
- **Laptop control (Windows app):** Karmis sees your screen, moves the mouse, types, presses shortcuts and reads/writes the clipboard to do tasks inside any program (opt-in, with an on-screen banner and a kill switch)
- **Device actions:** open links and apps, web and YouTube search, maps and routes, calls, SMS, email, Telegram, WhatsApp
- **Utilities:** weather, currency rates, Wikipedia, calculator, unit converter, timers, notes, passwords, dice and more
- **Image generation** via Gemini, OpenAI, OpenRouter or a free fallback
- **Music corner:** mood-based playlists and taste memory
- **Local fast path:** obvious commands (timers, notes, themes, opening apps, drawing a picture) run without calling the model
- **Languages:** Ukrainian, Belarusian, English
- **Themes and effects:** accent colors, custom backgrounds, animations, easter eggs

## Quick start

1. Open `www/index.html` in Chrome or Edge.
2. Go to **Settings**, pick a provider, paste your API key and press **Test connection**.
3. Return to **Chat** and start typing or talking.

If a provider blocks requests because of CORS when opening the file directly, run `npm run web` (Node.js required) or use the desktop app.

## Build

### Windows

Requires [Node.js 20+](https://nodejs.org).

```bash
npm install
npm start            # run the app
npm run build:win    # build installer and portable version into dist/
```

### Android

Requires Node.js, JDK 17 and Android Studio (or use GitHub Actions).

```bash
npm install
npm run android:add    # creates android/ and applies permissions and native plugins
npm run android:open   # opens Android Studio
```

### GitHub Actions

Run **Actions → Build Karmis AI → Run workflow**. Artifacts (`Karmis-AI.apk`, `Karmis-AI-Setup.exe`, `Karmis-AI-Portable.exe`) are attached to the run and published to Releases:

```
https://github.com/<user>/<repo>/releases/latest/download/Karmis-AI.apk
```

The APK is a debug build. Publishing to Google Play requires a signed release build.

## API keys

| Provider | Where to get a key |
|---|---|
| Google Gemini | https://aistudio.google.com/apikey |
| Groq | https://console.groq.com/keys |
| OpenRouter | https://openrouter.ai/keys |
| Mistral | https://console.mistral.ai/api-keys |
| Cerebras | https://cloud.cerebras.ai |
| GitHub Models | https://github.com/settings/personal-access-tokens/new |
| SambaNova | https://cloud.sambanova.ai/apis |
| NVIDIA NIM | https://build.nvidia.com |
| DeepSeek, OpenAI, Anthropic | provider consoles (paid) |

Free tiers and model names change over time. If the default model stops working, press **List** next to the model field and pick an available one. Speech recognition in the desktop and Android apps needs a **Groq** (Whisper) or **Gemini** key.

## Laptop control (Windows)

Turn it on in **Settings → Laptop control**. Then ask, for example: "Open Notepad and write a shopping list". Karmis asks permission, minimizes its own window, looks at the screen and acts step by step.

- Needs a model that can see images (Gemini, GPT-4o, Claude, …). Screenshots (primary monitor, max 1280 px wide) are sent to the selected provider.
- A red banner shows at the top of the screen the whole time. **Stop at any moment:** `Ctrl+Alt+Q`, move the cursor to the top-left corner, or say "Jarvis, stop".
- Confirmation modes: once per task (default), before every action, or fully autonomous (not recommended).
- A session ends when the task ends, after 3 idle minutes, or after 80 actions. **Settings → Laptop control → Test** checks the screen capture, input helper and clipboard without clicking anything.
- Not possible: controlling windows that run as administrator, secure desktop screens (UAC, lock screen), other monitors.

## Privacy and security

- Keys, history and settings are stored locally on the device and sent only to the selected provider. **Settings → Erase everything** wipes them.
- Calls, SMS, email, Telegram/WhatsApp messages and deletions always ask for confirmation.
- Laptop control is off by default. Everything on screen and in the clipboard is treated as data, never as instructions, and the model is told never to type passwords or confirm payments, deletions or messages without your explicit approval.
- Results from tools (weather, Wikipedia, etc.) are passed to the model as data, not as instructions.
- The Windows app launches only a short allowlist of programs and opens external links only for permitted URL schemes.
- Never commit API keys to the repository.

## Limitations

- Calls, SMS and email are opened for the user to confirm, not sent automatically (except Telegram via your own bot).
- "Play on YouTube" opens search results rather than starting a video.
- Timers fire while the app is open; Android may suspend them in the background.
- Continuous listening works while the app is open. Android may mute the microphone when the app is minimized.
- Built-in browser speech recognition works only in Chrome and Edge.

## Project structure

```
www/                 UI and logic (index.html, app.js, i18n.js, tts.js, imagegen.js, computer.js, ...)
electron/            Windows shell (main.js, preload.js, pc.js: laptop control)
capacitor.config.json  Android shell
scripts/             Android permission and plugin patching
.github/workflows/   CI builds for .exe and .apk
build/               app icon
```

To add an action, copy any `def('name', {...})` block in `www/app.js` and set its description, arguments and `run` function. It is picked up automatically by the system prompt and the **Functions** screen.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

Add a license of your choice (for example MIT) before publishing.


## Android: керування телефоном і міні-вікно

1. Налаштування Кармиса → «Керування телефоном» → увімкни перемикач.
2. Кнопка «Служба доступності» відкриє системні налаштування: увімкни там «Кармис AI». Android 13+: якщо пункт сірий, відкрий «Налаштування → Додатки → Кармис AI → ⋮ → Дозволити обмежені налаштування» і повернися.
3. Кнопка «Поверх інших вікон» дозволяє міні-вікно.
4. «Перевірити» покаже стан служби й скільки елементів Кармис бачить на екрані.
5. Скажи або напиши, що зробити («відкрий Telegram і напиши Денису привіт»). Стоп: кнопка у сповіщенні або ✕ у міні-вікні.

Кнопка «Міні-вікно» зверху чату згортає Кармиса в маленьке вікно поверх додатків (там теж є мікрофон і голосове керування).

## Языки и поддержка

Интерфейс и ответы: украинский, белорусский, русский, английский (Настройки → Язык). Вопросы и проблемы: Telegram-бот поддержки [@KarmisaiBot](https://t.me/KarmisaiBot) (ссылка есть и в настройках приложения).
