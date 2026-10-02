package pk.abcrides.app;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * ABC Rides for Android: a WebView shell around the ABC Rides web app.
 *
 * The app talks to an ABC Rides server whose address the user enters on first
 * launch (or that is baked in at build time). It adds the native pieces a
 * browser tab lacks: photo picking for ID verification, location for SOS,
 * the share sheet, dialer/SMS links and the back button.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "abc_rides";
    private static final String KEY_SERVER = "server";
    private static final String SETUP_PAGE = "file:///android_asset/setup.html";
    private static final int REQUEST_FILE = 1;
    private static final int REQUEST_LOCATION = 2;
    private static final String BRAND = "#0b7a5e";
    private static final int REQUEST_NOTIFY = 3;
    /** Intent extra with an app page to open, e.g. "/chat/12" (from a notification). */
    static final String EXTRA_LINK = "link";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private GeolocationPermissions.Callback geoCallback;
    private String geoOrigin;
    private Object backCallback;
    private boolean backRegistered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor(BRAND));

        web = new WebView(this);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BRAND));
        root.addView(web);
        setContentView(root);
        applyInsets(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " ABCRidesApp/1.0");

        web.addJavascriptInterface(new Bridge(), "AbcAndroid");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        String server = server();
        if (server.isEmpty()) {
            showSetup(null);
        } else {
            web.loadUrl(server + "/" + linkFragment(getIntent()));
        }
        pushCall("start");
    }

    /** "#/chat/12" for an intent opened from a notification, else "". */
    private static String linkFragment(Intent intent) {
        String link = intent == null ? null : intent.getStringExtra(EXTRA_LINK);
        return link != null && link.startsWith("/") ? "#" + link : "";
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String fragment = linkFragment(intent);
        if (!fragment.isEmpty() && !server().isEmpty()) web.loadUrl(server() + "/" + fragment);
    }

    /**
     * Calls a static method of Push (Firebase), which only the Gradle build
     * contains. Returns null when this build has no Firebase.
     */
    private Object pushCall(String method) {
        try {
            return Class.forName("pk.abcrides.app.Push").getMethod(method, Context.class).invoke(null, this);
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * Android 15+ draws apps edge to edge, behind the status bar, navigation
     * bar and keyboard. Pad the page so nothing hides behind them; the brand
     * colour shows through the bars.
     */
    private void applyInsets(View root) {
        if (Build.VERSION.SDK_INT < 35) return;
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            @SuppressWarnings("deprecation")
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                // On these versions the "system window" insets include the keyboard.
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                return insets.consumeSystemWindowInsets();
            }
        });
    }

    /**
     * Android 16+ no longer calls onBackPressed() for apps targeting it; the
     * back gesture goes to registered OnBackInvokedCallbacks instead. Register
     * one while the page has history (so back goes to the previous screen) and
     * remove it otherwise (so back leaves the app with the system animation).
     * Done through reflection so the app still builds against older SDKs.
     */
    private void updateBackHandling() {
        if (Build.VERSION.SDK_INT < 33) return;
        boolean want = web.canGoBack();
        if (want == backRegistered) return;
        try {
            Class<?> type = Class.forName("android.window.OnBackInvokedCallback");
            Object dispatcher = Activity.class.getMethod("getOnBackInvokedDispatcher").invoke(this);
            if (backCallback == null) {
                backCallback = Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, new InvocationHandler() {
                    @Override
                    public Object invoke(Object proxy, Method method, Object[] args) {
                        String name = method.getName();
                        if (name.equals("onBackInvoked")) {
                            if (web.canGoBack()) web.goBack();
                            return null;
                        }
                        if (name.equals("hashCode")) return System.identityHashCode(proxy);
                        if (name.equals("equals")) return args != null && proxy == args[0];
                        if (name.equals("toString")) return "AbcRidesBack";
                        return null;
                    }
                });
            }
            if (want) {
                dispatcher.getClass().getMethod("registerOnBackInvokedCallback", int.class, type)
                        .invoke(dispatcher, 0, backCallback);
            } else {
                dispatcher.getClass().getMethod("unregisterOnBackInvokedCallback", type).invoke(dispatcher, backCallback);
            }
            backRegistered = want;
        } catch (Exception e) {
            // Older behaviour (onBackPressed) still applies.
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    /** The saved server address, or the build-time default, without a trailing slash. */
    private String server() {
        return prefs().getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER);
    }

    private void showSetup(String error) {
        String url = SETUP_PAGE + "?server=" + Uri.encode(server());
        if (error != null) url += "&error=" + Uri.encode(error);
        web.loadUrl(url);
    }

    static String normalize(String url) {
        String u = url == null ? "" : url.trim();
        if (u.isEmpty()) return u;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    private boolean isOwnPage(Uri uri) {
        String scheme = uri.getScheme();
        if ("file".equals(scheme)) return uri.toString().startsWith("file:///android_asset/");
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        Uri base = Uri.parse(server());
        return uri.getHost() != null && uri.getHost().equalsIgnoreCase(base.getHost()) && uri.getPort() == base.getPort();
    }

    /** Opens tel:, sms:, WhatsApp, maps and other sites in the right app. */
    private void openExternal(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        Intent intent;
        if (scheme.equals("tel")) {
            intent = new Intent(Intent.ACTION_DIAL, uri);
        } else if (scheme.equals("sms") || scheme.equals("smsto")) {
            intent = new Intent(Intent.ACTION_SENDTO, uri);
            String body = uri.getQueryParameter("body");
            if (body != null) {
                intent = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + uri.getSchemeSpecificPart().split("\\?")[0]));
                intent.putExtra("sms_body", body);
            }
        } else {
            intent = new Intent(Intent.ACTION_VIEW, uri);
        }
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            web.evaluateJavascript("typeof toast==='function'&&toast('No app found to open this link',true)", null);
        }
    }

    private class Client extends WebViewClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (isOwnPage(uri)) return false;
            openExternal(uri);
            return true;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updateBackHandling();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            updateBackHandling();
        }

        // Called for main-frame failures only (the newer overload forwards here for them).
        @Override
        @SuppressWarnings("deprecation")
        public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            if (failingUrl != null && failingUrl.startsWith(SETUP_PAGE)) return;
            showSetup("Could not reach " + server() + " (" + description + ")");
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQUEST_FILE);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                return false;
            }
            return true;
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            if (Build.VERSION.SDK_INT < 23
                    || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                callback.invoke(origin, true, false);
                return;
            }
            geoOrigin = origin;
            geoCallback = callback;
            requestPermissions(new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQUEST_LOCATION);
        }
    }

    /** Methods the web app can call as window.AbcAndroid.*. */
    private class Bridge {
        @JavascriptInterface
        public String getServer() {
            return server();
        }

        @JavascriptInterface
        public void saveServer(String url) {
            final String clean = normalize(url);
            if (clean.isEmpty()) return;
            prefs().edit().putString(KEY_SERVER, clean).apply();
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    web.clearHistory();
                    web.loadUrl(clean + "/");
                    updateBackHandling();
                }
            });
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showSetup(null);
                }
            });
        }

        /** Whether this build can receive push notifications. */
        @JavascriptInterface
        public boolean pushAvailable() {
            return Boolean.TRUE.equals(pushCall("available"));
        }

        /** Asks for notification permission (Android 13+) and fetches this install's token. */
        @JavascriptInterface
        public void enablePush() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 33
                            && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQUEST_NOTIFY);
                    }
                    pushCall("start");
                }
            });
        }

        /** "granted", "denied" or "default" (not asked yet), like the browser's Notification.permission. */
        @JavascriptInterface
        public String pushPermission() {
            if (Build.VERSION.SDK_INT < 33) return "granted";
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return "granted";
            return prefs().getBoolean("notify_asked", false) ? "denied" : "default";
        }

        /** This install's Firebase token, or "" while it is still being fetched. */
        @JavascriptInterface
        public String getPushToken() {
            Object token = pushCall("token");
            return token == null ? "" : token.toString();
        }

        @JavascriptInterface
        public void share(String text) {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(send, "Share trip"));
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        if (requestCode == REQUEST_NOTIFY) {
            prefs().edit().putBoolean("notify_asked", true).apply();
            return;
        }
        if (requestCode == REQUEST_LOCATION && geoCallback != null) {
            boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
            geoCallback.invoke(geoOrigin, granted, false);
            geoCallback = null;
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }
}
