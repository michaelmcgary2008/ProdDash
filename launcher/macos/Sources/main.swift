import AppKit

// ProdDash Launcher — a menu-bar app, so no Dock icon and no app menu
// (LSUIElement in Info.plist says the same thing to Launch Services).
let delegate = AppDelegate()
let application = NSApplication.shared
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
