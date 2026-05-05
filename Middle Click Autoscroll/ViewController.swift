//
//  ViewController.swift
//  Middle Click Autoscroll
//
//  Created by Michael Quinn on 5/2/26.
//

import Cocoa
import WebKit

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        webView.navigationDelegate = self
        webView.configuration.userContentController.add(self, name: "controller")
        webView.loadFileURL(
            Bundle.main.url(forResource: "Main", withExtension: "html")!,
            allowingReadAccessTo: Bundle.main.resourceURL!
        )
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("showInstallState()")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String, body == "open-preferences" else {
            return
        }

        openSafariSettings()
    }

    private func openSafariSettings() {
        NSApplication.shared.activate(ignoringOtherApps: true)

        let safariBundleIdentifier = "com.apple.Safari"

        if let safariApp = NSRunningApplication.runningApplications(withBundleIdentifier: safariBundleIdentifier).first {
            safariApp.activate(options: [.activateAllWindows])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                NSApplication.shared.terminate(nil)
            }
            return
        }

        guard let safariURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: safariBundleIdentifier) else {
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        NSWorkspace.shared.openApplication(
            at: safariURL,
            configuration: configuration
        ) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSRunningApplication.runningApplications(withBundleIdentifier: safariBundleIdentifier)
                    .first?
                    .activate(options: [.activateAllWindows])
                NSApplication.shared.terminate(nil)
            }
        }
    }

}
