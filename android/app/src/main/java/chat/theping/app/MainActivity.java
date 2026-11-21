package chat.theping.app;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Back walks the site's own history (a chat back to the chat list). With
        // nowhere left to go, the app steps aside to the home screen, as Android
        // does for any app's first screen.
        // ponytail: a native handler, not @capacitor/app, whose default back
        // does nothing at all on the first screen.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge.getWebView().canGoBack()) {
                    bridge.getWebView().goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });
    }
}
