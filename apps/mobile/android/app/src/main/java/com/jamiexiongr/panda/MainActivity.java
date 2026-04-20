package com.jamiexiongr.panda;

import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String NATIVE_INSETS_CHANGE_EVENT_SCRIPT =
            "window.dispatchEvent(new Event('panda:native-safe-area-change'));";

    private volatile int safeAreaTopPx = 0;
    private volatile int safeAreaRightPx = 0;
    private volatile int safeAreaBottomPx = 0;
    private volatile int safeAreaLeftPx = 0;
    private volatile int keyboardInsetBottomPx = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (getBridge() == null) {
            return;
        }

        WebView webView = getBridge().getWebView();
        if (webView == null) {
            return;
        }

        webView.addJavascriptInterface(new NativeSafeAreaBridge(), "PandaSafeArea");
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets statusBarInsets = windowInsets.getInsets(WindowInsetsCompat.Type.statusBars());
            Insets imeInsets = windowInsets.getInsets(WindowInsetsCompat.Type.ime());

            boolean insetsChanged =
                    safeAreaTopPx != statusBarInsets.top
                            || safeAreaRightPx != statusBarInsets.right
                            || safeAreaBottomPx != statusBarInsets.bottom
                            || safeAreaLeftPx != statusBarInsets.left
                            || keyboardInsetBottomPx != imeInsets.bottom;

            safeAreaTopPx = statusBarInsets.top;
            safeAreaRightPx = statusBarInsets.right;
            safeAreaBottomPx = statusBarInsets.bottom;
            safeAreaLeftPx = statusBarInsets.left;
            keyboardInsetBottomPx = imeInsets.bottom;

            if (insetsChanged) {
                notifyNativeInsetsChanged(webView);
            }

            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void notifyNativeInsetsChanged(WebView webView) {
        webView.post(() -> {
            try {
                webView.evaluateJavascript(NATIVE_INSETS_CHANGE_EVENT_SCRIPT, null);
            } catch (IllegalStateException ignored) {
                // WebView may be mid-navigation; a later inset change or sync pass will recover.
            }
        });
    }

    private final class NativeSafeAreaBridge {

        @JavascriptInterface
        public int getTopInsetPx() {
            return safeAreaTopPx;
        }

        @JavascriptInterface
        public int getRightInsetPx() {
            return safeAreaRightPx;
        }

        @JavascriptInterface
        public int getBottomInsetPx() {
            return safeAreaBottomPx;
        }

        @JavascriptInterface
        public int getLeftInsetPx() {
            return safeAreaLeftPx;
        }

        @JavascriptInterface
        public int getKeyboardInsetPx() {
            return keyboardInsetBottomPx;
        }
    }
}
