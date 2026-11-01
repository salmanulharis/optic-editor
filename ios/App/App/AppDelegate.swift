import UIKit
import WebKit
import Capacitor

/// Cross-origin isolation for the app's own pages. Optic needs COOP / COEP on its responses so the
/// page is cross-origin isolated: LibRaw's WASM build uses threads (SharedArrayBuffer) and decoded
/// images are shared with the export worker without copying. Capacitor's asset handler creates
/// its responses internally, so its start method is wrapped once at launch and every response it
/// sends goes through `IsolatingSchemeTask`, which adds the headers.
enum CrossOriginIsolation {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let selector = #selector(WKURLSchemeHandler.webView(_:start:))
        guard let method = class_getInstanceMethod(WebViewAssetHandler.self, selector) else {
            NSLog("[optic] WebViewAssetHandler.webView(_:start:) not found: page will not be cross-origin isolated")
            return
        }
        typealias Start = @convention(c) (AnyObject, Selector, WKWebView, WKURLSchemeTask) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: Start.self)
        let wrapped: @convention(block) (AnyObject, WKWebView, WKURLSchemeTask) -> Void = { handler, webView, task in
            original(handler, selector, webView, IsolatingSchemeTask(task))
        }
        method_setImplementation(method, imp_implementationWithBlock(wrapped))
    }
}

/// Forwards to WebKit's task and adds the isolation headers to the response.
final class IsolatingSchemeTask: NSObject, WKURLSchemeTask {
    private let inner: WKURLSchemeTask

    init(_ inner: WKURLSchemeTask) {
        self.inner = inner
    }

    var request: URLRequest { inner.request }

    func didReceive(_ response: URLResponse) {
        guard let url = response.url else {
            inner.didReceive(response)
            return
        }
        var headers: [String: String] = [:]
        var status = 200
        if let http = response as? HTTPURLResponse {
            status = http.statusCode
            for (key, value) in http.allHeaderFields {
                if let key = key as? String { headers[key] = "\(value)" }
            }
        } else {
            headers["Content-Type"] = response.mimeType ?? "application/octet-stream"
            if response.expectedContentLength >= 0 { headers["Content-Length"] = String(response.expectedContentLength) }
        }
        headers["Cross-Origin-Opener-Policy"] = "same-origin"
        headers["Cross-Origin-Embedder-Policy"] = "require-corp"
        headers["Cross-Origin-Resource-Policy"] = "same-origin"
        inner.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) ?? response)
    }

    func didReceive(_ data: Data) {
        inner.didReceive(data)
    }

    func didFinish() {
        inner.didFinish()
    }

    func didFailWithError(_ error: Error) {
        inner.didFailWithError(error)
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Before the first web view is created (the scene connects after this).
        CrossOriginIsolation.install()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
