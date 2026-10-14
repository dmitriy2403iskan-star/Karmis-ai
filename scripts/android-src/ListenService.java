package ai.karmis.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Честный foreground-сервис: пока он запущен, в шторке ВСЕГДА висит
 * заметное уведомление "Кармис AI слушает" с кнопкой "Стоп".
 * Никакого скрытого/зацикленного спама — ровно одно постоянное уведомление,
 * которое пользователь в любой момент может убрать, нажав "Стоп".
 * Это и даёт процессу право держать микрофон активным в фоне (Android
 * требует foregroundServiceType="microphone" для этого, см. манифест).
 */
public class ListenService extends Service {
    public static final String CHANNEL_ID = "karmis_listen_channel";
    public static final int NOTIF_ID = 4201;
    public static final String ACTION_STOP = "ai.karmis.app.ACTION_STOP_LISTEN";

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIF_ID, buildNotification());
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "Кармис AI — прослушивание", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Показывается, пока ассистент слушает команды в фоне");
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, openApp,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent stopIntent = new Intent(this, ListenService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 0, stopIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentTitle("Кармис AI слушает")
                .setContentText("Скажите слово-активатор или команду")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openPi)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Стоп", stopPi)
                .build();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
