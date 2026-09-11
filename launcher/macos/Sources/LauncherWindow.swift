import AppKit
import SwiftUI

/// The launcher's one window. Closing it leaves the app in the menu bar —
/// the same "Hide, don't Quit" habit Companion's launcher asks for.
final class LauncherWindowController: NSWindowController {

    convenience init(delegate: AppDelegate) {
        let view = LauncherView(server: delegate.server,
                                settings: delegate.settings,
                                permissions: delegate.permissions,
                                onHide: { [weak delegate] in delegate?.hideWindow() },
                                onQuit: { [weak delegate] in delegate?.quit() })
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 580, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = "ProdDash"
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.contentView = NSHostingView(rootView: view)
        window.center()
        window.setFrameAutosaveName("ProdDashLauncherWindow")
        self.init(window: window)
    }
}
