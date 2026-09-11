import AppKit
import Combine

/**
 The launcher itself: one status-bar item, one window, one server.

 It is an accessory app (no Dock icon, no app menu), so everything it can do
 is reachable from the menu-bar menu — including quitting, which stops the
 server with it.
 */
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {

    /// The launcher's own version. The app's CFBundleShortVersionString is
    /// ProdDash's, because the app *is* ProdDash now.
    static var version: String {
        Bundle.main.infoDictionary?["ProdDashLauncherVersion"] as? String ?? "dev"
    }
    /// Sent by a second copy of the launcher so the first one shows itself.
    static let showNotification = Notification.Name("org.waterschurch.proddash.launcher.show")

    let settings = LauncherSettings()
    let permissions = PermissionsModel()
    lazy var server = ServerController(settings: settings)

    private var statusItem: NSStatusItem?
    private var windowController: LauncherWindowController?
    private var cancellables = Set<AnyCancellable>()
    private var appearanceObserver: NSKeyValueObservation?
    private var signalSources: [DispatchSourceSignal] = []

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard !handOffToRunningInstance() else { return }

        LogStore.shared.launcher("ProdDash Launcher \(Self.version)")
        setUpStatusItem()

        server.onPortBusy = { [weak self] port, isProdDash, reply in
            self?.askAboutBusyPort(port, isProdDash: isProdDash, reply: reply)
        }
        // Any change in the server's state re-draws the icon; the menu rebuilds
        // itself when it opens.
        server.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.updateStatusItem() }
            .store(in: &cancellables)

        DistributedNotificationCenter.default().addObserver(
            self, selector: #selector(showWindow), name: Self.showNotification, object: nil)

        catchShutdownSignals()
        permissions.refresh(root: server.rootURL, dataDir: server.dataDir)
        updateStatusItem()

        let firstRun = !settings.hasRunBefore
        settings.hasRunBefore = true

        if settings.showWindowAtLaunch || firstRun { showWindow() }
        if settings.startServerAtLaunch { server.start() }

        // Owning the permissions means asking for them at a sensible moment —
        // now, with someone at the keyboard — rather than halfway through a
        // service when a module first reaches for the microphone.
        if firstRun { requestDeclaredPermissions() }
    }

    /// Something else is quitting us — a logout, a restart, `osascript … quit`.
    /// Stop the server first, but never let that wedge a logout: the backstop
    /// leaves anyway if the reply hasn't gone out in time.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard server.state.isBusy else { return .terminateNow }
        LogStore.shared.launcher("quitting — stopping ProdDash first")
        server.stop()
        replyWhenStopped(within: 36)
        DispatchQueue.global().asyncAfter(deadline: .now() + 12) { exit(0) }
        return .terminateLater
    }

    /// Waiting here with a Timer would hang the quit outright: while the app
    /// sits on `.terminateLater` the run loop is not in its default mode, so a
    /// scheduled timer never fires.
    private func replyWhenStopped(within ticks: Int) {
        guard server.state.isBusy, ticks > 0 else {
            return NSApp.reply(toApplicationShouldTerminate: true)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.replyWhenStopped(within: ticks - 1)
        }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// A Cocoa app doesn't run its normal quit path when something sends it a
    /// signal — `killall`, a logout, a stop from a terminal. Without this the
    /// launcher would vanish and leave node (and its audio capture) running.
    private func catchShutdownSignals() {
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in
                LogStore.shared.launcher("signal \(number) — stopping ProdDash and quitting")
                self?.server.stop()
                self?.exitOnceStopped(within: 32)
            }
            source.resume()
            signalSources.append(source)
        }
    }

    private func exitOnceStopped(within ticks: Int) {
        guard server.state.isBusy, ticks > 0 else { exit(0) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.exitOnceStopped(within: ticks - 1)
        }
    }

    /// A second launch just shows the copy that is already running.
    private func handOffToRunningInstance() -> Bool {
        guard let id = Bundle.main.bundleIdentifier else { return false }
        let mine = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .filter { $0.processIdentifier != mine }
        guard !others.isEmpty else { return false }
        DistributedNotificationCenter.default().post(name: Self.showNotification, object: nil)
        NSApp.terminate(nil)
        return true
    }

    // MARK: - Status item

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        menu.autoenablesItems = false
        item.menu = menu
        statusItem = item
        // The glyph is drawn, not templated, so it has to be redrawn when the
        // menu bar switches between light and dark.
        appearanceObserver = item.button?.observe(\.effectiveAppearance) { [weak self] _, _ in
            DispatchQueue.main.async { self?.updateStatusItem() }
        }
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        button.image = StatusIcon.image(for: server.state, healthy: server.healthy)
        button.toolTip = "ProdDash — \(server.state.label)"
    }

    // MARK: - Menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let version = server.shellVersion.isEmpty ? "" : " \(server.shellVersion)"
        menu.addItem(disabled("ProdDash\(version) — \(server.state.label)"))
        switch server.state {
        case .running:
            menu.addItem(disabled("localhost:\(server.port)"))
        case .failed(let why):
            menu.addItem(disabled(why.prefix(60) + (why.count > 60 ? "…" : "")))
        default:
            if !server.message.isEmpty { menu.addItem(disabled(String(server.message.prefix(60)))) }
        }

        menu.addItem(.separator())
        let dashboard = item("Open Dashboard", #selector(openDashboard), key: "d")
        dashboard.isEnabled = server.state == .running
        menu.addItem(dashboard)
        let admin = item("Open Admin", #selector(openAdmin), key: "a")
        admin.isEnabled = server.state == .running
        menu.addItem(admin)

        menu.addItem(.separator())
        switch server.state {
        case .running, .starting:
            menu.addItem(item("Stop ProdDash", #selector(toggleServer)))
        case .stopping:
            menu.addItem(disabled("Stopping…"))
        case .stopped, .failed:
            menu.addItem(item("Start ProdDash", #selector(toggleServer)))
        }
        let restart = item("Restart ProdDash", #selector(restartServer))
        restart.isEnabled = server.state == .running || server.state == .starting
        menu.addItem(restart)

        menu.addItem(.separator())
        menu.addItem(item("Launcher…", #selector(showWindow), key: ","))
        let login = item("Open at Login", #selector(toggleLoginItem))
        login.state = LoginItem.isEnabled ? .on : .off
        menu.addItem(login)

        menu.addItem(.separator())
        menu.addItem(item("Quit ProdDash", #selector(quit), key: "q"))
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    private func disabled(_ title: any StringProtocol) -> NSMenuItem {
        let item = NSMenuItem(title: String(title), action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    // MARK: - Actions

    @objc private func openDashboard() { server.openDashboard() }
    @objc private func openAdmin() { server.openAdmin() }
    @objc private func toggleServer() { server.toggle() }
    @objc private func restartServer() { server.restart() }

    @objc func showWindow() {
        if windowController == nil {
            windowController = LauncherWindowController(delegate: self)
        }
        NSApp.activate(ignoringOtherApps: true)
        windowController?.showWindow(nil)
        windowController?.window?.makeKeyAndOrderFront(nil)
    }

    /// Close the window but stay in the menu bar.
    func hideWindow() {
        windowController?.window?.orderOut(nil)
    }

    @objc private func toggleLoginItem() {
        let turningOn = !LoginItem.isEnabled
        if let error = LoginItem.set(turningOn) {
            present(alert: "Couldn't change the login item", detail: error)
            return
        }
        LogStore.shared.launcher("open at login: \(turningOn ? "on" : "off")")
        if turningOn && LoginItem.needsApproval {
            present(alert: "Approve ProdDash in Login Items",
                    detail: "macOS needs you to allow ProdDash under System Settings → General → Login Items.",
                    openSettings: true)
        }
    }

    /// A modal run started while the menu is still closing doesn't reliably
    /// appear — let the menu finish first, then ask.
    @objc func quit() {
        DispatchQueue.main.async { [weak self] in self?.confirmThenQuit() }
    }

    private func confirmThenQuit() {
        // A booth machine shouldn't lose its dashboard to a stray click.
        if server.state == .running || server.state == .starting {
            let alert = NSAlert()
            alert.messageText = "Quit ProdDash?"
            alert.informativeText = "The server stops with the launcher, and every dashboard on the network goes dark."
            alert.addButton(withTitle: "Quit")
            alert.addButton(withTitle: "Cancel")
            alert.alertStyle = .warning
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        // Deliberately not NSApp.terminate: begun here, while the alert's modal
        // session is still unwinding, it leaves AppKit wedged with the main
        // queue unserviced — the server stops and the app never finishes
        // quitting. Stopping is our own job anyway, so do it and leave.
        DispatchQueue.main.async { [weak self] in
            guard let self else { exit(0) }
            LogStore.shared.launcher("quitting — stopping ProdDash first")
            self.server.stop()
            self.exitOnceStopped(within: 36)
        }
    }

    // MARK: - Prompts

    /// Something already holds the port. If it answers like ProdDash, offer the
    /// same hand-over Start ProdDash.command does — that other copy was very
    /// likely started over SSH and has no microphone access.
    private func askAboutBusyPort(_ port: Int, isProdDash: Bool, reply: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        if isProdDash {
            alert.messageText = "ProdDash is already running on port \(port)"
            alert.informativeText = "It was started outside this launcher — over SSH or from Start ProdDash.command "
                + "— so it has no microphone access and this app can't watch over it. Take it over?"
            alert.addButton(withTitle: "Take Over")
        } else {
            alert.messageText = "Port \(port) is already in use"
            alert.informativeText = "Another app is listening on port \(port). Stop that app, or give ProdDash a "
                + "different port under Settings. Stopping whatever holds it anyway is rarely what you want."
            alert.addButton(withTitle: "Stop It Anyway")
        }
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = isProdDash ? .informational : .warning
        NSApp.activate(ignoringOtherApps: true)
        reply(alert.runModal() == .alertFirstButtonReturn)
    }

    /// Ask for what the installed modules actually declare they need.
    func requestDeclaredPermissions() {
        permissions.refresh(root: server.rootURL, dataDir: server.dataDir)
        for need in permissions.needs {
            switch need.kind {
            case .microphone:
                if permissions.microphone == .notDetermined { permissions.requestMicrophone() }
            case .localNetwork:
                permissions.checkLocalNetwork(root: server.rootURL, dataDir: server.dataDir)
            case .other:
                break
            }
        }
    }

    /// Deferred for the same reason the quit confirmation is: a modal run
    /// started while the menu is still closing doesn't reliably appear.
    private func present(alert title: String, detail: String, openSettings: Bool = false) {
        DispatchQueue.main.async { [weak self] in
            self?.runAlert(title: title, detail: detail, openSettings: openSettings)
        }
    }

    private func runAlert(title: String, detail: String, openSettings: Bool) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: openSettings ? "Open System Settings" : "OK")
        if openSettings { alert.addButton(withTitle: "Later") }
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn && openSettings {
            LoginItem.openSystemSettings()
        }
    }
}
