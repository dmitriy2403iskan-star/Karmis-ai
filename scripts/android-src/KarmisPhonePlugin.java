package ai.karmis.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Керування телефоном і міні-вікно поверх додатків (аналог керування ПК у Windows-версії).
 *  - status(): чи увімкнена служба доступності й дозвіл «поверх інших вікон»
 *  - openAccessibilitySettings() / requestOverlay(): відкрити потрібні системні налаштування
 *  - overlayOpen({control}) / overlayClose() / overlayPush({json}): міні-вікно
 *  - scan({max}) / shot({maxW,quality}): стан екрана текстом і знімок
 *  - act({op, ...}): tap, double, long, swipe, scroll, type, key, clipRead, clipWrite
 * Події в JS: «overlayCmd» {type, text} (send, listen, mic, mute, stop, expand, close, ready) та «overlayClosed».
 */
@CapacitorPlugin(name = "KarmisPhone")
public class KarmisPhonePlugin extends Plugin {

    private static volatile KarmisPhonePlugin instance;

    @Override
    public void load() { instance = this; }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    /** Команда з міні-вікна → JS. */
    public static void sendCmd(String type, String text) {
        KarmisPhonePlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("type", type);
        if (text != null) o.put("text", text);
        p.notifyListeners("overlayCmd", o);
    }

    public static void emitEvent(String name) {
        KarmisPhonePlugin p = instance;
        if (p == null) return;
        p.notifyListeners(name, new JSObject());
    }

    private Context ctx() { return getContext(); }

    private boolean canDraw() {
        return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(ctx());
    }

    // ------------------------------------------------------------------ дозволи

    @PluginMethod
    public void status(PluginCall call) {
        KarmisAccessibilityService s = KarmisAccessibilityService.get();
        JSObject o = new JSObject();
        o.put("a11y", s != null);
        o.put("overlay", canDraw());
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("screenshot", Build.VERSION.SDK_INT >= 30);
        o.put("overlayOpen", PhoneOverlayService.isRunning());
        if (s != null) {
            int[] sz = s.screenSize();
            o.put("w", sz[0]);
            o.put("h", sz[1]);
        }
        call.resolve(o);
    }

    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void requestOverlay(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void toFront(PluginCall call) {
        Intent i = new Intent(ctx(), MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { ctx().startActivity(i); } catch (Exception e) { /* ignore */ }
        call.resolve();
    }

    @PluginMethod
    public void toBack(PluginCall call) {
        try { getActivity().moveTaskToBack(true); } catch (Exception e) { /* ignore */ }
        call.resolve();
    }

    // ------------------------------------------------------------------ міні-вікно

    @PluginMethod
    public void overlayOpen(PluginCall call) {
        Intent svc = new Intent(ctx(), PhoneOverlayService.class);
        svc.putExtra("control", Boolean.TRUE.equals(call.getBoolean("control", false)));
        if (Build.VERSION.SDK_INT >= 26) ctx().startForegroundService(svc);
        else ctx().startService(svc);
        call.resolve();
    }

    @PluginMethod
    public void overlayClose(PluginCall call) {
        ctx().stopService(new Intent(ctx(), PhoneOverlayService.class));
        call.resolve();
    }

    @PluginMethod
    public void overlayPush(PluginCall call) {
        String json = call.getString("json");
        if (json != null) PhoneOverlayService.push(json);
        call.resolve();
    }

    // ------------------------------------------------------------------ екран

    @PluginMethod
    public void scan(PluginCall call) {
        KarmisAccessibilityService s = KarmisAccessibilityService.get();
        if (s == null) { call.reject("a11y_off"); return; }
        int max = call.getInt("max", 90);
        String text = s.scan(Math.max(10, Math.min(200, max)), 2500);
        int count = 0;
        for (String line : text.split("\n")) {
            if (line.length() > 1 && Character.isDigit(line.charAt(0))) count++;
        }
        int[] sz = s.screenSize();
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("text", text);
        o.put("count", count);
        o.put("w", sz[0]);
        o.put("h", sz[1]);
        call.resolve(o);
    }

    @PluginMethod
    public void shot(PluginCall call) {
        KarmisAccessibilityService s = KarmisAccessibilityService.get();
        if (s == null) { call.reject("a11y_off"); return; }
        if (Build.VERSION.SDK_INT < 30) { call.reject("Знімок екрана доступний з Android 11"); return; }
        int[] wh = new int[4];
        String b64 = s.shot(call.getInt("maxW", 720), call.getInt("quality", 60), wh);
        if (b64 == null) { call.reject("Не вдалося зняти екран"); return; }
        JSObject o = new JSObject();
        o.put("ok", true);
        o.put("mime", "image/jpeg");
        o.put("b64", b64);
        o.put("w", wh[0]);
        o.put("h", wh[1]);
        o.put("sw", wh[2]);
        o.put("sh", wh[3]);
        call.resolve(o);
    }

    // ------------------------------------------------------------------ дії

    private static int num(PluginCall call, String key, int def) {
        Double d = call.getDouble(key);
        return d == null ? def : (int) Math.round(d);
    }

    @PluginMethod
    public void act(PluginCall call) {
        KarmisAccessibilityService s = KarmisAccessibilityService.get();
        if (s == null) { call.reject("a11y_off"); return; }
        String op = call.getString("op", "");
        try {
            boolean ok;
            if ("tap".equals(op)) {
                ok = s.tap(num(call, "x", -1), num(call, "y", -1), 60);
            } else if ("double".equals(op)) {
                int x = num(call, "x", -1), y = num(call, "y", -1);
                ok = s.tap(x, y, 50);
                try { Thread.sleep(90); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                ok = s.tap(x, y, 50) && ok;
            } else if ("long".equals(op)) {
                ok = s.tap(num(call, "x", -1), num(call, "y", -1), 700);
            } else if ("swipe".equals(op)) {
                ok = s.swipe(num(call, "x", -1), num(call, "y", -1), num(call, "x2", -1), num(call, "y2", -1), num(call, "ms", 450));
            } else if ("scroll".equals(op)) {
                int[] sz = s.screenSize();
                boolean horizontal = Boolean.TRUE.equals(call.getBoolean("horizontal", false));
                int amount = Math.max(-10, Math.min(10, num(call, "amount", 0)));
                if (amount == 0) { call.reject("Не вказано, наскільки прокрутити"); return; }
                int cx = num(call, "x", sz[0] / 2), cy = num(call, "y", sz[1] / 2);
                int dist = (int) Math.min((horizontal ? sz[0] : sz[1]) * 0.7, Math.abs(amount) * (horizontal ? sz[0] : sz[1]) * 0.18);
                int half = dist / 2;
                int sign = amount > 0 ? 1 : -1;       // amount > 0: вміст їде вгору / ліворуч, палець йде в той самий бік
                ok = horizontal
                        ? s.swipe(cx + sign * half, cy, cx - sign * half, cy, 380)
                        : s.swipe(cx, cy + sign * half, cx, cy - sign * half, 380);
            } else if ("type".equals(op)) {
                String err = s.typeText(call.getString("text", ""));
                if (err != null) { call.reject(err); return; }
                ok = true;
            } else if ("key".equals(op)) {
                String k = call.getString("keys", "");
                ok = s.key(k);
                if (!ok) { call.reject("Клавіша не підтримується або немає поля введення: " + k + ". Доступні: back, home, recents, notifications, quick_settings, enter, backspace, lock, screenshot"); return; }
            } else if ("clipRead".equals(op)) {
                JSObject o = new JSObject();
                o.put("ok", true);
                o.put("text", s.clipRead());
                call.resolve(o);
                return;
            } else if ("clipWrite".equals(op)) {
                ok = s.clipWrite(call.getString("text", ""));
            } else {
                call.reject("Невідома дія: " + op);
                return;
            }
            if (!ok) { call.reject("Дію не виконано (екран її не прийняв)"); return; }
            JSObject res = new JSObject();
            res.put("ok", true);
            call.resolve(res);
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }
}
