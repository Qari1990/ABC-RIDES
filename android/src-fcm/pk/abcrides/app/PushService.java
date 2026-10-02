package pk.abcrides.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Receives Firebase messages and shows them; tapping one opens that page in the app. */
public class PushService extends FirebaseMessagingService {
    @Override
    public void onNewToken(String token) {
        // The web app sends the new token to the server the next time it opens.
        Push.saveToken(this, token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> data = message.getData();
        String title = data.containsKey("title") ? data.get("title") : "ABC Rides";
        String body = data.containsKey("body") ? data.get("body") : "";
        String link = data.containsKey("link") ? data.get("link") : "/";

        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(MainActivity.EXTRA_LINK, link);
        int id = (int) (System.currentTimeMillis() & 0x7fffffff);
        PendingIntent tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, Push.CHANNEL)
                : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setColor(0xFF0B7A5E)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(tap);
        if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
        getSystemService(NotificationManager.class).notify(id, builder.build());
    }
}
