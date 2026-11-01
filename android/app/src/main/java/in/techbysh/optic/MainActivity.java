package in.techbysh.optic;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OpticFilesPlugin.class);
        super.onCreate(savedInstanceState);
        // Serve the app cross-origin isolated (see IsolatingWebViewClient). The bridge has already
        // queued the first load with its own client, so load again through ours: the document's
        // response must carry the headers for the page to be isolated.
        bridge.setWebViewClient(new IsolatingWebViewClient(bridge));
        bridge.getWebView().loadUrl(bridge.getAppUrl());
    }
}
