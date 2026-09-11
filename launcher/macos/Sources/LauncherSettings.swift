import Foundation

/// The launcher's own preferences — everything that is about *running* ProdDash
/// rather than about ProdDash itself. (The port is not here: it belongs to
/// ProdDash and is written to its proddash.json — see LauncherConfig.)
final class LauncherSettings: ObservableObject {

    private let defaults = UserDefaults.standard

    @Published var rootPath: String { didSet { defaults.set(rootPath, forKey: "rootPath") } }
    @Published var nodePath: String { didSet { defaults.set(nodePath, forKey: "nodePath") } }
    /// Start the server as soon as the launcher opens (so a login item brings the
    /// whole dashboard up by itself).
    @Published var startServerAtLaunch: Bool { didSet { defaults.set(startServerAtLaunch, forKey: "startServerAtLaunch") } }
    /// Bring the server back if it dies on its own. Backs off, and gives up
    /// after a burst of fast crashes rather than looping forever.
    @Published var restartOnCrash: Bool { didSet { defaults.set(restartOnCrash, forKey: "restartOnCrash") } }
    /// Open the dashboard in a browser whenever the server comes up.
    @Published var openDashboardOnStart: Bool { didSet { defaults.set(openDashboardOnStart, forKey: "openDashboardOnStart") } }
    /// Show this window at launch. Off means the launcher starts straight into
    /// the menu bar (Companion's "start minimised").
    @Published var showWindowAtLaunch: Bool { didSet { defaults.set(showWindowAtLaunch, forKey: "showWindowAtLaunch") } }

    init() {
        defaults.register(defaults: [
            "startServerAtLaunch": true,
            "restartOnCrash": true,
            "openDashboardOnStart": false,
            "showWindowAtLaunch": true,
        ])
        rootPath = defaults.string(forKey: "rootPath") ?? ""
        nodePath = defaults.string(forKey: "nodePath") ?? ""
        startServerAtLaunch = defaults.bool(forKey: "startServerAtLaunch")
        restartOnCrash = defaults.bool(forKey: "restartOnCrash")
        openDashboardOnStart = defaults.bool(forKey: "openDashboardOnStart")
        showWindowAtLaunch = defaults.bool(forKey: "showWindowAtLaunch")
    }

    /// False until the launcher has run once — used to open the window (and ask
    /// for the permissions ProdDash needs) the first time only.
    var hasRunBefore: Bool {
        get { defaults.bool(forKey: "hasRunBefore") }
        set { defaults.set(newValue, forKey: "hasRunBefore") }
    }
}
