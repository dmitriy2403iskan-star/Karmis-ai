package ai.karmis.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Мост JS <-> Android:
 *  - listApps(): список запускаемых установленных приложений (имя + пакет)
 *  - openApp({package}): запустить конкретное приложение по явной команде
 *  - startListening()/stopListening(): включить/выключить честный
 *    foreground-сервис с постоянным уведомлением "Кармис AI слушает"
 *
 * listApps() намеренно не использует QUERY_ALL_PACKAGES (это разрешение
 * Google Play жёстко модерирует и требует отдельного обоснования) —
 * вместо этого стандартный запрос "какие приложения умеют открываться
 * с главного экрана" через <queries> в манифесте. Этого достаточно,
 * чтобы ассистент мог открыть приложение по запросу пользователя.
 */
@CapacitorPlugin(name = "KarmisSystem")
public class KarmisSystemPlugin extends Plugin {

    @PluginMethod
    public void listApps(PluginCall call) {
        PackageManager pm = getContext().getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        launcher.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> apps = pm.queryIntentActivities(launcher, 0);

        JSArray result = new JSArray();
        for (ResolveInfo ri : apps) {
            ApplicationInfo ai = ri.activityInfo.applicationInfo;
            JSObject o = new JSObject();
            o.put("label", pm.getApplicationLabel(ai).toString());
            o.put("package", ai.packageName);
            result.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("apps", result);
        call.resolve(ret);
    }

    @PluginMethod
    public void openApp(PluginCall call) {
        String pkg = call.getString("package");
        if (pkg == null || pkg.isEmpty()) {
            call.reject("package is required");
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        Intent launchIntent = pm.getLaunchIntentForPackage(pkg);
        if (launchIntent == null) {
            call.reject("app not found or not launchable: " + pkg);
            return;
        }
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(launchIntent);
        call.resolve();
    }

    @PluginMethod
    public void startListening(PluginCall call) {
        Intent svc = new Intent(getContext(), ListenService.class);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().startForegroundService(svc);
        } else {
            getContext().startService(svc);
        }
        call.resolve();
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        Intent svc = new Intent(getContext(), ListenService.class);
        svc.setAction(ListenService.ACTION_STOP);
        getContext().startService(svc);
        call.resolve();
    }
}
