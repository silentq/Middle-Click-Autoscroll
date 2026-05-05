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
            presentSafariLaunchFailureAlert(message: "Safari could not be located on this Mac.")
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true

        NSWorkspace.shared.openApplication(
            at: safariURL,
            configuration: configuration
        ) { application, error in
            if let error {
                DispatchQueue.main.async {
                    self.presentSafariLaunchFailureAlert(message: error.localizedDescription)
                }
                return
            }

            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                (application ?? NSRunningApplication.runningApplications(withBundleIdentifier: safariBundleIdentifier).first)?
                    .activate(options: [.activateAllWindows])
                NSApplication.shared.terminate(nil)
            }
        }
    }

    private func presentSafariLaunchFailureAlert(message: String) {
        let alert = NSAlert()
        alert.messageText = "Unable to Open Safari"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")

        if let window = view.window ?? NSApplication.shared.mainWindow {
            alert.beginSheetModal(for: window)
        } else {
            alert.runModal()
        }
    }

}
