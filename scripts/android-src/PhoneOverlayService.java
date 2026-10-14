package ai.karmis.app;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.StyleSpan;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Міні-вікно Кармиса поверх усіх додатків + честний foreground-сервіс із постійним сповіщенням і кнопкою «Стоп».
 * Уся логіка (модель, дії, голос) лишається у WebView головного додатку, тут лише показ чату й передача команд.
 */
public class PhoneOverlayService extends Service {
    public static final String CHANNEL_ID = "karmis_phone_channel";
    public static final int NOTIF_ID = 4202;
    public static final String ACTION_STOP = "ai.karmis.app.ACTION_STOP_PHONE";

    private static volatile PhoneOverlayService inst;
    public static boolean isRunning() { return inst != null; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private WindowManager.LayoutParams params;
    private RootLayout root;
    private LinearLayout panel;
    private FrameLayout bubble;
    private View orb, bubbleOrb;
    private TextView tvStatus, tvLive, btnEar, btnMute, btnMic, typingView;
    private LinearLayout list, chips;
    private ScrollView scroll;
    private EditText input;
    private ObjectAnimator pulse1, pulse2;
    private boolean minimized = false, control = false;
    private String ph = "Напиши Кармису…";

    // ------------------------------------------------------------------ статичний API

    public static void push(final String json) {
        final PhoneOverlayService s = inst;
        if (s == null) return;
        s.main.post(new Runnable() { @Override public void run() { s.handle(json); } });
    }

    public static void passThrough(final boolean on) {
        final PhoneOverlayService s = inst;
        if (s == null) return;
        runSync(s, new Runnable() {
            @Override public void run() {
                if (s.params == null || s.root == null) return;
                if (on) s.params.flags |= WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                else s.params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE;
                s.update();
            }
        });
    }

    public static void hideForShot(final boolean hide) {
        final PhoneOverlayService s = inst;
        if (s == null) return;
        runSync(s, new Runnable() {
            @Override public void run() {
                if (s.root != null) s.root.setVisibility(hide ? View.INVISIBLE : View.VISIBLE);
            }
        });
    }

    private static void runSync(PhoneOverlayService s, final Runnable r) {
        if (Looper.myLooper() == Looper.getMainLooper()) { r.run(); return; }
        final CountDownLatch l = new CountDownLatch(1);
        s.main.post(new Runnable() { @Override public void run() { try { r.run(); } finally { l.countDown(); } } });
        try { l.await(1, TimeUnit.SECONDS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }

    // ------------------------------------------------------------------ життєвий цикл

    @Override
    public void onCreate() {
        super.onCreate();
        inst = this;
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            KarmisPhonePlugin.sendCmd("stop", null);
            stopSelf();
            return START_NOT_STICKY;
        }
        control = intent != null && intent.getBooleanExtra("control", false);
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIF_ID, n);
        if (root == null && canDraw()) {
            try { buildOverlay(); } catch (Exception e) { root = null; }
        }
        KarmisPhonePlugin.sendCmd("ready", null);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        stopPulse();
        if (root != null) { try { wm.removeView(root); } catch (Exception e) { /* вже знято */ } root = null; }
        inst = null;
        KarmisPhonePlugin.emitEvent("overlayClosed");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private boolean canDraw() { return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this); }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Кармис AI: міні-вікно й керування телефоном", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Показується, поки відкрите міні-вікно або Кармис керує телефоном");
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, PhoneOverlayService.class);
        stop.setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(control ? "Кармис AI керує телефоном" : "Кармис AI: міні-вікно")
                .setContentText(control ? "Натисни «Стоп», щоб негайно зупинити" : "Міні-вікно поверх додатків")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Стоп", stopPi)
                .build();
    }

    // ------------------------------------------------------------------ інтерфейс

    private int dp(float v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    private GradientDrawable round(int color, float radiusDp, int strokeColor) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(color);
        g.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) g.setStroke(dp(1), strokeColor);
        return g;
    }

    private View makeOrb(int sizeDp) {
        View v = new View(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setGradientType(GradientDrawable.RADIAL_GRADIENT);
        g.setGradientCenter(0.35f, 0.3f);
        g.setGradientRadius(dp(sizeDp) * 0.75f);
        g.setColors(new int[] { 0xFFFFFFFF, 0xFFC7D6FF, 0xFF8B6CFF });
        v.setBackground(g);
        v.setLayoutParams(new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp)));
        return v;
    }

    private TextView iconBtn(String glyph, final Runnable click) {
        TextView t = new TextView(this);
        t.setText(glyph);
        t.setTextSize(16);
        t.setTextColor(0xFFB9C2D9);
        t.setGravity(Gravity.CENTER);
        t.setLayoutParams(new LinearLayout.LayoutParams(dp(36), dp(36)));
        t.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { click.run(); } });
        return t;
    }

    /** Корінь вікна: ловить «Назад» і дотик поза вікном, щоб прибрати клавіатуру. */
    private class RootLayout extends FrameLayout {
        RootLayout(Context c) { super(c); }
        @Override public boolean dispatchKeyEvent(KeyEvent e) {
            if (e.getKeyCode() == KeyEvent.KEYCODE_BACK && e.getAction() == KeyEvent.ACTION_UP) { unfocusInput(); return true; }
            return super.dispatchKeyEvent(e);
        }
        @Override public boolean onTouchEvent(MotionEvent e) {
            if (e.getAction() == MotionEvent.ACTION_OUTSIDE) unfocusInput();
            return super.onTouchEvent(e);
        }
    }

    private void buildOverlay() {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int pw = Math.min(dp(360), dm.widthPixels - dp(16));
        int ph2 = Math.min(dp(470), (int) (dm.heightPixels * 0.62f));

        root = new RootLayout(this);

        // ---- панель
        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackground(round(0xF2101624, 22, 0x26FFFFFF));
        panel.setPadding(dp(10), dp(8), dp(10), dp(10));
        root.addView(panel, new FrameLayout.LayoutParams(pw, ph2));

        // шапка (за неї можна перетягувати вікно)
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);
        orb = makeOrb(30);
        head.addView(orb);
        LinearLayout who = new LinearLayout(this);
        who.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        wl.leftMargin = dp(10);
        TextView title = new TextView(this);
        title.setText("Кармис");
        title.setTextColor(0xFFE9EEFB);
        title.setTextSize(15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        tvStatus = new TextView(this);
        tvStatus.setText("Готовий");
        tvStatus.setTextColor(0xFF8E98B0);
        tvStatus.setTextSize(11.5f);
        tvStatus.setSingleLine(true);
        tvStatus.setEllipsize(TextUtils.TruncateAt.END);
        who.addView(title);
        who.addView(tvStatus);
        head.addView(who, wl);
        btnEar = iconBtn("\uD83D\uDC42", new Runnable() { @Override public void run() { KarmisPhonePlugin.sendCmd("listen", null); } });
        btnMute = iconBtn("\uD83D\uDD0A", new Runnable() { @Override public void run() { KarmisPhonePlugin.sendCmd("mute", null); } });
        TextView btnMin = iconBtn("\u2013", new Runnable() { @Override public void run() { setMinimized(true); } });
        TextView btnExp = iconBtn("\u2922", new Runnable() { @Override public void run() { expand(); } });
        TextView btnClose = iconBtn("\u2715", new Runnable() { @Override public void run() { KarmisPhonePlugin.sendCmd("close", null); stopSelf(); } });
        head.addView(btnEar); head.addView(btnMute); head.addView(btnMin); head.addView(btnExp); head.addView(btnClose);
        orb.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { KarmisPhonePlugin.sendCmd("stop", null); } });
        attachDrag(head);
        panel.addView(head, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // що Кармис розчув
        tvLive = new TextView(this);
        tvLive.setTextColor(0xFF46E0FF);
        tvLive.setTextSize(12);
        tvLive.setSingleLine(true);
        tvLive.setEllipsize(TextUtils.TruncateAt.END);
        tvLive.setPadding(dp(10), dp(4), dp(10), dp(4));
        tvLive.setBackground(round(0x1446E0FF, 10, 0));
        tvLive.setVisibility(View.GONE);
        LinearLayout.LayoutParams ll = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ll.topMargin = dp(6);
        panel.addView(tvLive, ll);

        // повідомлення
        scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, dp(4), 0, dp(4));
        scroll.addView(list, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        panel.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // швидкі кнопки
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        hs.addView(chips);
        panel.addView(hs, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // поле вводу
        LinearLayout comp = new LinearLayout(this);
        comp.setOrientation(LinearLayout.HORIZONTAL);
        comp.setGravity(Gravity.CENTER_VERTICAL);
        btnMic = new TextView(this);
        btnMic.setText("\uD83C\uDF99");
        btnMic.setTextSize(17);
        btnMic.setGravity(Gravity.CENTER);
        btnMic.setBackground(round(0x14FFFFFF, 14, 0x26FFFFFF));
        btnMic.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { KarmisPhonePlugin.sendCmd("mic", null); } });
        comp.addView(btnMic, new LinearLayout.LayoutParams(dp(42), dp(42)));
        input = new EditText(this);
        input.setHint(ph);
        input.setHintTextColor(0xFF8E98B0);
        input.setTextColor(0xFFE9EEFB);
        input.setTextSize(14);
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        input.setBackground(round(0x14FFFFFF, 14, 0x26FFFFFF));
        input.setPadding(dp(12), 0, dp(12), 0);
        input.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                if (e.getAction() == MotionEvent.ACTION_DOWN) focusInput();
                return false;
            }
        });
        input.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int actionId, KeyEvent e) {
                submit();
                return true;
            }
        });
        LinearLayout.LayoutParams il = new LinearLayout.LayoutParams(0, dp(42), 1f);
        il.leftMargin = dp(6); il.rightMargin = dp(6);
        comp.addView(input, il);
        TextView send = new TextView(this);
        send.setText("\u27A4");
        send.setTextSize(16);
        send.setTextColor(0xFF0B1020);
        send.setGravity(Gravity.CENTER);
        send.setBackground(round(0xFFE9EEFB, 14, 0));
        send.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { submit(); } });
        comp.addView(send, new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cl.topMargin = dp(6);
        panel.addView(comp, cl);

        // ---- згорнута «бульбашка»
        bubble = new FrameLayout(this);
        bubbleOrb = makeOrb(54);
        bubble.addView(bubbleOrb);
        bubble.setVisibility(View.GONE);
        bubble.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { setMinimized(false); } });
        attachDrag(bubble);
        root.addView(bubble, new FrameLayout.LayoutParams(dp(54), dp(54)));

        // ---- вікно
        int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = Math.max(0, dm.widthPixels - pw - dp(8));
        params.y = Math.max(0, dm.heightPixels - ph2 - dp(96));
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN;
        wm.addView(root, params);
    }

    private void update() {
        if (root == null || params == null) return;
        try { wm.updateViewLayout(root, params); } catch (Exception e) { /* вікно знято */ }
    }

    private void attachDrag(View handle) {
        final int[] st = new int[4];
        final boolean[] moved = new boolean[1];
        handle.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                if (params == null) return false;
                switch (e.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        st[0] = params.x; st[1] = params.y; st[2] = (int) e.getRawX(); st[3] = (int) e.getRawY(); moved[0] = false;
                        return true;
                    case MotionEvent.ACTION_MOVE: {
                        int dx = (int) e.getRawX() - st[2], dy = (int) e.getRawY() - st[3];
                        if (Math.abs(dx) + Math.abs(dy) > dp(6)) moved[0] = true;
                        DisplayMetrics dm = getResources().getDisplayMetrics();
                        params.x = Math.max(0, Math.min(dm.widthPixels - dp(60), st[0] + dx));
                        params.y = Math.max(0, Math.min(dm.heightPixels - dp(60), st[1] + dy));
                        update();
                        return true;
                    }
                    case MotionEvent.ACTION_UP:
                        if (!moved[0]) v.performClick();
                        return true;
                    default:
                        return false;
                }
            }
        });
    }

    private void setMinimized(boolean on) {
        minimized = on;
        if (panel == null || bubble == null) return;
        panel.setVisibility(on ? View.GONE : View.VISIBLE);
        bubble.setVisibility(on ? View.VISIBLE : View.GONE);
        unfocusInput();
        update();
    }

    private void expand() {
        KarmisPhonePlugin.sendCmd("expand", null);
        Intent i = new Intent(this, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try { startActivity(i); } catch (Exception e) { /* ignore */ }
        stopSelf();
    }

    // ------------------------------------------------------------------ ввід

    private void focusInput() {
        if (params == null) return;
        params.flags &= ~WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        update();
        input.requestFocus();
        main.postDelayed(new Runnable() {
            @Override public void run() {
                InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                if (imm != null && input != null) imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
            }
        }, 80);
    }

    private void unfocusInput() {
        if (params == null || input == null) return;
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
        input.clearFocus();
        params.flags |= WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE;
        update();
    }

    private void submit() {
        String t = input.getText().toString().trim();
        input.setText("");
        unfocusInput();
        if (t.length() > 0) KarmisPhonePlugin.sendCmd("send", t);
    }

    // ------------------------------------------------------------------ вміст

    private CharSequence fmt(String s) {
        SpannableStringBuilder sb = new SpannableStringBuilder();
        String[] parts = s.split("\\*\\*", -1);
        for (int i = 0; i < parts.length; i++) {
            int a = sb.length();
            sb.append(parts[i]);
            if (i % 2 == 1) sb.setSpan(new StyleSpan(Typeface.BOLD), a, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return sb;
    }

    private void toBottom() {
        if (scroll == null) return;
        scroll.post(new Runnable() { @Override public void run() { scroll.fullScroll(View.FOCUS_DOWN); } });
    }

    private void trim() {
        while (list.getChildCount() > 60) list.removeViewAt(0);
    }

    private void addBubble(String role, String text) {
        if (list == null) return;
        boolean user = "user".equals(role), err = "error".equals(role);
        TextView tv = new TextView(this);
        tv.setText(fmt(text));
        tv.setTextColor(err ? 0xFFFFB3BB : 0xFFE9EEFB);
        tv.setTextSize(13.5f);
        tv.setPadding(dp(12), dp(8), dp(12), dp(8));
        tv.setBackground(round(err ? 0x33FF6B7A : (user ? 0x2AFFFFFF : 0x14FFFFFF), 14, 0));
        tv.setMaxWidth((int) (getResources().getDisplayMetrics().widthPixels * 0.72f));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.gravity = user ? Gravity.END : Gravity.START;
        lp.topMargin = dp(6);
        removeTyping();
        list.addView(tv, lp);
        trim(); toBottom();
    }

    private void addAct(String text, String kind) {
        if (list == null) return;
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(12);
        tv.setTextColor("err".equals(kind) ? 0xFFFF6B7A : ("warn".equals(kind) ? 0xFFFFB84D : 0xFF8E98B0));
        tv.setPadding(dp(4), dp(2), dp(4), dp(2));
        removeTyping();
        list.addView(tv);
        trim(); toBottom();
    }

    private void removeTyping() {
        if (typingView != null && typingView.getParent() != null) list.removeView(typingView);
    }

    private void setTyping(boolean on) {
        if (list == null) return;
        removeTyping();
        if (!on) return;
        if (typingView == null) {
            typingView = new TextView(this);
            typingView.setText("\u2022 \u2022 \u2022");
            typingView.setTextColor(0xFF8E98B0);
            typingView.setTextSize(14);
            typingView.setPadding(dp(12), dp(6), dp(12), dp(6));
            typingView.setBackground(round(0x14FFFFFF, 14, 0));
        }
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(6);
        list.addView(typingView, lp);
        toBottom();
    }

    private void setChips(JSONArray arr) {
        if (chips == null) return;
        chips.removeAllViews();
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            final String text = o.optString("text");
            TextView c = new TextView(this);
            c.setText(o.optString("label"));
            c.setTextColor(0xFFE9EEFB);
            c.setTextSize(12.5f);
            c.setPadding(dp(12), dp(6), dp(12), dp(6));
            c.setBackground(round(0x0DFFFFFF, 18, 0x26FFFFFF));
            c.setOnClickListener(new View.OnClickListener() { @Override public void onClick(View v) { KarmisPhonePlugin.sendCmd("send", text); } });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.rightMargin = dp(6); lp.topMargin = dp(4); lp.bottomMargin = dp(2);
            chips.addView(c, lp);
        }
    }

    private void stopPulse() {
        if (pulse1 != null) { pulse1.cancel(); pulse1 = null; }
        if (pulse2 != null) { pulse2.cancel(); pulse2 = null; }
        if (orb != null) { orb.setScaleX(1f); orb.setScaleY(1f); orb.setAlpha(1f); }
        if (bubbleOrb != null) { bubbleOrb.setScaleX(1f); bubbleOrb.setScaleY(1f); bubbleOrb.setAlpha(1f); }
    }

    private ObjectAnimator pulseOf(View v, boolean fade) {
        ObjectAnimator a = fade
                ? ObjectAnimator.ofPropertyValuesHolder(v, PropertyValuesHolder.ofFloat("alpha", 1f, 0.5f))
                : ObjectAnimator.ofPropertyValuesHolder(v, PropertyValuesHolder.ofFloat("scaleX", 1f, 1.16f), PropertyValuesHolder.ofFloat("scaleY", 1f, 1.16f));
        a.setDuration(fade ? 1100 : 650);
        a.setRepeatMode(ValueAnimator.REVERSE);
        a.setRepeatCount(ValueAnimator.INFINITE);
        a.start();
        return a;
    }

    private void applyState(JSONObject st) {
        if (st == null || root == null) return;
        if (st.has("status")) tvStatus.setText(st.optString("status"));
        if (st.has("dataState")) {
            String ds = st.optString("dataState");
            stopPulse();
            if ("listening".equals(ds) || "speaking".equals(ds)) { pulse1 = pulseOf(orb, false); pulse2 = pulseOf(bubbleOrb, false); }
            else if ("thinking".equals(ds)) { pulse1 = pulseOf(orb, true); pulse2 = pulseOf(bubbleOrb, true); }
            tvStatus.setTextColor("listening".equals(ds) ? 0xFF46E0FF : 0xFF8E98B0);
        }
        if (st.has("listen")) {
            btnEar.setBackground(st.optBoolean("listen") ? round(0xFF46E0FF, 10, 0) : null);
            btnEar.setAlpha(st.optBoolean("listen") ? 1f : 0.85f);
        }
        if (st.has("mic")) btnMic.setBackground(round(st.optBoolean("mic") ? 0xFF46E0FF : 0x14FFFFFF, 14, 0x26FFFFFF));
        if (st.has("tts")) btnMute.setText(st.optBoolean("tts") ? "\uD83D\uDD0A" : "\uD83D\uDD07");
        if (st.has("live")) {
            String l = st.optString("live", "");
            tvLive.setText(l);
            tvLive.setVisibility(l.length() > 0 ? View.VISIBLE : View.GONE);
        }
    }

    private void handle(String json) {
        if (root == null) return;
        try {
            JSONObject o = new JSONObject(json);
            String type = o.optString("type");
            if ("init".equals(type)) {
                JSONObject lb = o.optJSONObject("labels");
                if (lb != null) { ph = lb.optString("ph", ph); input.setHint(ph); setChips(lb.optJSONArray("chips")); }
                list.removeAllViews();
                typingView = null;
                JSONArray log = o.optJSONArray("log");
                if (log != null) {
                    for (int i = 0; i < log.length(); i++) {
                        JSONObject m = log.optJSONObject(i);
                        if (m == null) continue;
                        if ("act".equals(m.optString("kind"))) addAct(m.optString("text"), m.optString("k"));
                        else addBubble(m.optString("kind"), m.optString("text"));
                    }
                }
                applyState(o.optJSONObject("st"));
                setTyping(o.optBoolean("typing"));
            } else if ("msg".equals(type)) addBubble(o.optString("role"), o.optString("text"));
            else if ("act".equals(type)) addAct(o.optString("text"), o.optString("kind"));
            else if ("typing".equals(type)) setTyping(o.optBoolean("on"));
            else if ("state".equals(type)) applyState(o.optJSONObject("st"));
        } catch (Exception e) { /* некоректна подія: ігноруємо */ }
    }
}
