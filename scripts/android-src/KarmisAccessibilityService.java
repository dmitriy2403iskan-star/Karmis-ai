package ai.karmis.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.ByteArrayOutputStream;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Служба доступності Кармиса: «очі й руки» на телефоні.
 *  - scan(): читає екран як текст (те саме, що UI Automation у Windows): рядки «N роль @x,y "назва"»
 *  - tap / longPress / swipe: жести на екрані
 *  - typeText / key: ввід тексту в поле та системні кнопки (назад, додому, останні…)
 *  - shot(): знімок екрана (Android 11+)
 * Працює лише коли користувач сам увімкнув службу в Налаштування → Спеціальні можливості.
 */
public class KarmisAccessibilityService extends AccessibilityService {

    private static volatile KarmisAccessibilityService instance;
    public static KarmisAccessibilityService get() { return instance; }

    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        instance = null;
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) { /* події не потрібні: читаємо екран за запитом */ }

    @Override
    public void onInterrupt() { }

    // ------------------------------------------------------------------ утиліти

    private <T> T onMain(final Callable<T> c, T def) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try { return c.call(); } catch (Exception e) { return def; }
        }
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<T> ref = new AtomicReference<T>(def);
        main.post(new Runnable() {
            @Override public void run() {
                try { ref.set(c.call()); } catch (Exception e) { /* лишаємо значення за замовчуванням */ }
                latch.countDown();
            }
        });
        try { latch.await(8, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        return ref.get();
    }

    private static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    public int[] screenSize() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        wm.getDefaultDisplay().getRealMetrics(dm);
        return new int[] { dm.widthPixels, dm.heightPixels };
    }

    private String appLabel(CharSequence pkg) {
        if (pkg == null) return "?";
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg.toString(), 0);
            return String.valueOf(pm.getApplicationLabel(ai));
        } catch (Exception e) {
            return pkg.toString();
        }
    }

    private static String clip(CharSequence s, int n) {
        if (s == null) return "";
        String t = s.toString().replace('\r', ' ').replace('\n', ' ').replace('\t', ' ').replace('"', '\'').trim();
        return t.length() > n ? t.substring(0, n) + "..." : t;
    }

    @SuppressWarnings("deprecation")
    private static void recycle(AccessibilityNodeInfo n) {
        if (n != null && Build.VERSION.SDK_INT < 33) n.recycle();
    }

    // ------------------------------------------------------------------ читання екрана

    private static class Ctx {
        StringBuilder sb = new StringBuilder();
        Set<String> seen = new HashSet<String>();
        int max, count, nodes, w, h;
        long deadline;
        boolean done() { return count >= max || nodes > 4000 || System.currentTimeMillis() > deadline; }
    }

    private static String roleOf(String cn, boolean edit, boolean clickable, boolean scrollable, String name) {
        if (edit) return "edit";
        if (cn.contains("CheckBox") || cn.contains("CheckedTextView")) return "check";
        if (cn.contains("Switch") || cn.contains("ToggleButton")) return "switch";
        if (cn.contains("RadioButton")) return "radio";
        if (cn.contains("Spinner")) return "combo";
        if (cn.endsWith("Button") || cn.contains("ImageButton")) return "btn";
        if (cn.contains("Tab") && clickable) return "tab";
        if (scrollable && !clickable) return "scroll";
        if (name.length() == 0) return null;          // безіменні контейнери пропускаємо: їхній текст прийде з дочірніх елементів
        if (clickable) return "item";
        if (cn.contains("ImageView")) return "img";
        return "text";
    }

    private void visit(AccessibilityNodeInfo n, Ctx c) {
        CharSequence cls = n.getClassName();
        String cn = cls == null ? "" : cls.toString();
        CharSequence txt = n.getText();
        CharSequence desc = n.getContentDescription();
        boolean edit = n.isEditable() || cn.endsWith("EditText");
        boolean clickable = n.isClickable() || n.isLongClickable();
        boolean scrollable = n.isScrollable();
        boolean pass = n.isPassword();

        String name;
        String value = "";
        if (edit) {
            CharSequence hint = Build.VERSION.SDK_INT >= 26 ? n.getHintText() : null;
            name = clip(hint != null && hint.length() > 0 ? hint : desc, 48);
            boolean showingHint = Build.VERSION.SDK_INT >= 26 && n.isShowingHintText();
            if (!pass && !showingHint && txt != null) value = clip(txt, 60);
        } else {
            name = clip(txt != null && txt.length() > 0 ? txt : desc, 48);
        }

        String role = roleOf(cn, edit, clickable, scrollable, name);
        if (role == null) return;
        if ((role.equals("text") || role.equals("img")) && name.length() < 1) return;

        Rect r = new Rect();
        n.getBoundsInScreen(r);
        if (r.width() < 4 || r.height() < 4) return;
        int cx = r.centerX(), cy = r.centerY();
        if (cx < 0 || cy < 0 || cx >= c.w || cy >= c.h) return;
        String key = role + "|" + name + "|" + cx + "|" + cy;
        if (!c.seen.add(key)) return;

        c.count++;
        StringBuilder sb = c.sb;
        sb.append(c.count).append(' ').append(role).append(" @").append(cx).append(',').append(cy);
        if (name.length() > 0) sb.append(" \"").append(name).append('"');
        if (!n.isEnabled()) sb.append(" [off]");
        if (n.isChecked()) sb.append(" [on]");
        if (edit) {
            if (pass) sb.append(" [password]");
            else if (value.length() > 0) sb.append(" =\"").append(value).append('"');
            if (n.isFocused()) sb.append(" [focus]");
        }
        sb.append('\n');
    }

    private void walk(AccessibilityNodeInfo n, int depth, Ctx c) {
        if (n == null || c.done()) return;
        c.nodes++;
        if (!n.isVisibleToUser()) return;
        try { visit(n, c); } catch (Exception e) { /* пропускаємо проблемний вузол */ }
        if (depth >= 40 || n.isPassword()) return;
        int cnt = n.getChildCount();
        for (int i = 0; i < cnt && !c.done(); i++) {
            AccessibilityNodeInfo ch = null;
            try { ch = n.getChild(i); } catch (Exception e) { /* ignore */ }
            if (ch == null) continue;
            walk(ch, depth + 1, c);
            recycle(ch);
        }
    }

    /** Текстовий опис екрана: заголовок додатку + список елементів. Координати в пікселях екрана. */
    public String scan(int max, int budgetMs) {
        AccessibilityNodeInfo root = null;
        for (int i = 0; i < 6 && root == null; i++) {
            root = getRootInActiveWindow();
            if (root == null) sleep(150);
        }
        int[] sz = screenSize();
        StringBuilder out = new StringBuilder();
        out.append("screen ").append(sz[0]).append('x').append(sz[1]).append('\n');
        if (root == null) {
            out.append("app \"?\"\n");
            return out.toString();
        }
        CharSequence pkg = root.getPackageName();
        out.append("app \"").append(clip(appLabel(pkg), 40)).append("\" (").append(pkg).append(")\n");
        Ctx c = new Ctx();
        c.max = max; c.w = sz[0]; c.h = sz[1];
        c.deadline = System.currentTimeMillis() + budgetMs;
        walk(root, 0, c);
        recycle(root);
        out.append(c.sb);
        return out.toString();
    }

    // ------------------------------------------------------------------ жести

    private boolean dispatch(final GestureDescription gd) {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean ok = new AtomicBoolean(false);
        PhoneOverlayService.passThrough(true);   // міні-вікно Кармиса не повинно «з'їсти» дотик
        try {
            main.post(new Runnable() {
                @Override public void run() {
                    boolean accepted = dispatchGesture(gd, new GestureResultCallback() {
                        @Override public void onCompleted(GestureDescription g) { ok.set(true); latch.countDown(); }
                        @Override public void onCancelled(GestureDescription g) { latch.countDown(); }
                    }, null);
                    if (!accepted) latch.countDown();
                }
            });
            try { latch.await(8, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
        } finally {
            PhoneOverlayService.passThrough(false);
        }
        return ok.get();
    }

    private int clampX(int x) { return Math.max(1, Math.min(screenSize()[0] - 1, x)); }
    private int clampY(int y) { return Math.max(1, Math.min(screenSize()[1] - 1, y)); }

    public boolean tap(int x, int y, long durMs) {
        Path p = new Path();
        p.moveTo(clampX(x), clampY(y));
        GestureDescription.Builder b = new GestureDescription.Builder();
        b.addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(1, durMs)));
        return dispatch(b.build());
    }

    public boolean swipe(int x1, int y1, int x2, int y2, long durMs) {
        Path p = new Path();
        p.moveTo(clampX(x1), clampY(y1));
        p.lineTo(clampX(x2), clampY(y2));
        GestureDescription.Builder b = new GestureDescription.Builder();
        b.addStroke(new GestureDescription.StrokeDescription(p, 0, Math.max(50, durMs)));
        return dispatch(b.build());
    }

    // ------------------------------------------------------------------ ввід тексту й кнопки

    private AccessibilityNodeInfo firstEditable(AccessibilityNodeInfo n, int depth) {
        if (n == null || depth > 40) return null;
        if (n.isVisibleToUser() && (n.isEditable() || (n.getClassName() != null && n.getClassName().toString().endsWith("EditText")))) return n;
        int cnt = n.getChildCount();
        for (int i = 0; i < cnt; i++) {
            AccessibilityNodeInfo ch = null;
            try { ch = n.getChild(i); } catch (Exception e) { /* ignore */ }
            AccessibilityNodeInfo f = firstEditable(ch, depth + 1);
            if (f != null) return f;
        }
        return null;
    }

    private AccessibilityNodeInfo findInput() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return null;
        AccessibilityNodeInfo f = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f != null && f.isEditable()) return f;
        AccessibilityNodeInfo e = firstEditable(root, 0);
        if (e != null) {
            e.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            e.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            sleep(150);
        }
        return e;
    }

    private static String textOf(AccessibilityNodeInfo f) {
        CharSequence cur = f.getText();
        String s = cur == null ? "" : cur.toString();
        if (Build.VERSION.SDK_INT >= 26 && f.isShowingHintText()) s = "";
        return s;
    }

    private boolean setText(AccessibilityNodeInfo f, String text, int caret) {
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        if (ok && caret >= 0) {
            Bundle sel = new Bundle();
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret);
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret);
            f.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel);
        }
        return ok;
    }

    /** Друкує текст у поле з фокусом (вставляє в позицію курсору). Повертає null, якщо все добре, інакше текст помилки. */
    public String typeText(String text) {
        AccessibilityNodeInfo f = findInput();
        if (f == null) return "Немає поля введення на екрані: спочатку торкнись потрібного поля";
        String s = textOf(f);
        int a = f.getTextSelectionStart(), b = f.getTextSelectionEnd();
        if (a < 0 || b < 0 || a > s.length() || b > s.length()) { a = s.length(); b = s.length(); }
        int lo = Math.min(a, b), hi = Math.max(a, b);
        String ns = s.substring(0, lo) + text + s.substring(hi);
        return setText(f, ns, lo + text.length()) ? null : "Це поле не приймає текст через службу доступності";
    }

    private boolean backspace() {
        AccessibilityNodeInfo f = findInput();
        if (f == null) return false;
        String s = textOf(f);
        int a = f.getTextSelectionStart(), b = f.getTextSelectionEnd();
        if (a < 0 || b < 0 || a > s.length() || b > s.length()) { a = s.length(); b = s.length(); }
        int lo = Math.min(a, b), hi = Math.max(a, b);
        if (lo == hi) { if (lo == 0) return true; lo = lo - 1; }
        return setText(f, s.substring(0, lo) + s.substring(hi), lo);
    }

    private boolean enter() {
        AccessibilityNodeInfo f = findInput();
        if (f == null) return false;
        if (Build.VERSION.SDK_INT >= 30) {
            if (f.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId())) return true;
        }
        return typeText("\n") == null;
    }

    /** Системні кнопки й клавіші. Звичні для ПК назви теж розуміє (win = Додому, alt+tab = Останні, esc = Назад). */
    public boolean key(String k) {
        final String key = k == null ? "" : k.trim().toLowerCase();
        if (key.equals("back") || key.equals("esc") || key.equals("escape")) return globalAction(GLOBAL_ACTION_BACK);
        if (key.equals("home") || key.equals("win") || key.equals("windows")) return globalAction(GLOBAL_ACTION_HOME);
        if (key.equals("recents") || key.equals("recent") || key.equals("alt+tab") || key.equals("overview")) return globalAction(GLOBAL_ACTION_RECENTS);
        if (key.equals("notifications") || key.equals("shade")) return globalAction(GLOBAL_ACTION_NOTIFICATIONS);
        if (key.equals("quick_settings") || key.equals("settings")) return globalAction(GLOBAL_ACTION_QUICK_SETTINGS);
        if (key.equals("power") || key.equals("power_menu")) return globalAction(GLOBAL_ACTION_POWER_DIALOG);
        if (Build.VERSION.SDK_INT >= 28 && key.equals("lock")) return globalAction(GLOBAL_ACTION_LOCK_SCREEN);
        if (Build.VERSION.SDK_INT >= 28 && key.equals("screenshot")) return globalAction(GLOBAL_ACTION_TAKE_SCREENSHOT);
        if (key.equals("enter") || key.equals("return") || key.equals("search")) return enter();
        if (key.equals("backspace") || key.equals("delete")) return backspace();
        return false;
    }

    private boolean globalAction(final int action) {
        return onMain(new Callable<Boolean>() {
            @Override public Boolean call() { return performGlobalAction(action); }
        }, Boolean.FALSE);
    }

    // ------------------------------------------------------------------ буфер обміну

    public String clipRead() {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return "";
            CharSequence t = d.getItemAt(0).coerceToText(this);
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            return "";   // Android 10+ не віддає буфер фоновим службам
        }
    }

    public boolean clipWrite(final String text) {
        return onMain(new Callable<Boolean>() {
            @Override public Boolean call() {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("karmis", text));
                return Boolean.TRUE;
            }
        }, Boolean.FALSE);
    }

    // ------------------------------------------------------------------ знімок екрана (Android 11+)

    /** Повертає JPEG у base64 або null; outWH[0..3] = ширина, висота знімка, ширина, висота екрана. */
    public String shot(int maxW, int quality, int[] outWH) {
        if (Build.VERSION.SDK_INT < 30) return null;
        PhoneOverlayService.hideForShot(true);
        sleep(160);
        Bitmap bmp = null;
        try {
            bmp = takeBitmap();
            if (bmp == null) { sleep(1200); bmp = takeBitmap(); }   // системний ліміт: не частіше разу на секунду
        } finally {
            PhoneOverlayService.hideForShot(false);
        }
        if (bmp == null) return null;
        int sw = bmp.getWidth(), sh = bmp.getHeight();
        int w = Math.min(maxW, sw);
        int h = Math.max(1, Math.round((float) sh * w / sw));
        Bitmap scaled = (w == sw) ? bmp : Bitmap.createScaledBitmap(bmp, w, h, true);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, Math.max(30, Math.min(95, quality)), bos);
        outWH[0] = w; outWH[1] = h; outWH[2] = sw; outWH[3] = sh;
        return Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
    }

    private Bitmap takeBitmap() {
        if (Build.VERSION.SDK_INT < 30) return null;
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<Bitmap> ref = new AtomicReference<Bitmap>();
        try {
            takeScreenshot(Display.DEFAULT_DISPLAY, getMainExecutor(), new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult r) {
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                        if (hw != null) ref.set(hw.copy(Bitmap.Config.ARGB_8888, false));
                        r.getHardwareBuffer().close();
                    } catch (Throwable t) { /* лишаємо null */ }
                    latch.countDown();
                }
                @Override public void onFailure(int errorCode) { latch.countDown(); }
            });
            latch.await(5, TimeUnit.SECONDS);
        } catch (Throwable t) { /* ignore */ }
        return ref.get();
    }
}
