package pk.abcrides.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Firebase push notifications. Only in the Gradle build (which includes the
 * Firebase SDK); MainActivity reaches it by reflection so the no-SDK build.sh
 * APK still works without it.
 *
 * Firebase starts itself from the google_app_id/... string resources that
 * build.gradle adds when app.properties has the Firebase values.
 */
public final class Push {
    static final String CHANNEL = "alerts";
    static final String PREFS = "abc_rides";
    static final String KEY_TOKEN = "push_token";

    private Push() {}

    /** True when this build has Firebase set up. */
    public static boolean available(Context context) {
        return !FirebaseApp.getApps(context).isEmpty();
    }

    /** Creates the notification channel and fetches this install's token in the background. */
    public static void start(Context context) {
        if (!available(context)) return;
        final Context app = context.getApplicationContext();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Ride alerts", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("Bookings, ride changes and messages");
            app.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> saveToken(app, token));
    }

    /** The token saved for this install, or "" if Firebase hasn't given one yet. */
    public static String token(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_TOKEN, "");
    }

    static void saveToken(Context context, String token) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_TOKEN, token).apply();
    }
}
