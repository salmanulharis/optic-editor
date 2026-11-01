package in.techbysh.optic;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.util.HashMap;
import java.util.Map;

/**
 * Adds the cross-origin isolation headers (COOP / COEP / CORP) to every response the local server
 * returns. Optic needs a cross-origin isolated page: LibRaw's WASM build uses threads
 * (SharedArrayBuffer) and decoded images are shared with the export worker without copying.
 * The web build gets the same headers from the host (public/_headers) or its service worker.
 */
public class IsolatingWebViewClient extends BridgeWebViewClient {

    public IsolatingWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse response = super.shouldInterceptRequest(view, request);
        if (response == null) return null;
        Map<String, String> headers = new HashMap<>();
        Map<String, String> existing = response.getResponseHeaders();
        if (existing != null) headers.putAll(existing);
        headers.put("Cross-Origin-Opener-Policy", "same-origin");
        headers.put("Cross-Origin-Embedder-Policy", "require-corp");
        headers.put("Cross-Origin-Resource-Policy", "same-origin");
        response.setResponseHeaders(headers);
        return response;
    }
}
