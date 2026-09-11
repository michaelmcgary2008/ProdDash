import AppKit
import Foundation

enum ServerState: Equatable {
    case stopped
    case starting
    case running
    case stopping
    case failed(String)

    var isBusy: Bool { self == .starting || self == .running || self == .stopping }

    var label: String {
        switch self {
        case .stopped:  return "Stopped"
        case .starting: return "Starting…"
        case .running:  return "Running"
        case .stopping: return "Stopping…"
        case .failed:   return "Problem"
        }
    }
}

/**
 Starts, stops and watches over the ProdDash server.

 The shell was built for this: it takes `PRODDASH_LAUNCHER=1` to mean "someone
 is supervising me", and then exits **75** instead of respawning itself when
 the admin page applies an update — so a 75 here is a restart request, not a
 fault. Anything else unexpected is a crash: it gets a backed-off restart, and
 a burst of fast crashes stops the cycle rather than looping forever.

 Starting the server from this app is also what gives the modules their
 permissions. macOS hands a child process the *responsible process* of its
 parent, so node — and the `ltc-capture` tool the Timers module runs — inherit
 this app bundle's identity, and the microphone and local-network prompts are
 asked, and remembered, in ProdDash's name. A server started over SSH or from
 a bare launchd job has no such identity, which is why its LTC input is
 silently all zeros.
 */
final class ServerController: ObservableObject {

    @Published private(set) var state: ServerState = .stopped
    /// One line under the status pill: why it stopped, what to fix.
    @Published private(set) var message = ""
    @Published private(set) var port: Int = ProdDash.defaultPort
    @Published private(set) var shellVersion = ""
    @Published private(set) var localURL = ""
    @Published private(set) var networkURLs: [String] = []
    @Published private(set) var settingsDir = ""
    /// The server answered /api/modules — listening, not merely alive.
    @Published private(set) var healthy = false
    @Published private(set) var rootURL: URL?
    @Published private(set) var nodeURL: URL?
    @Published private(set) var nodeVersion = ""

    /// Asked when the port is already taken: (port, looks like ProdDash, reply).
    var onPortBusy: ((Int, Bool, @escaping (Bool) -> Void) -> Void)?

    private let settings: LauncherSettings
    private let log = LogStore.shared

    private var child: ChildProcess?
    private var intentionalStop = false
    private var restartAfterExit = false
    private var startedAt: Date?
    private var crashTimes: [Date] = []
    private var pendingRestart: DispatchWorkItem?
    private var healthTimer: Timer?
    private var healthMisses = 0
    private var openedDashboardThisRun = false
    /// The most recent line that reads like a reason, shown with a failure.
    private var lastProblemLine = ""

    init(settings: LauncherSettings) {
        self.settings = settings
        refreshEnvironment()
    }

    // MARK: - Environment

    /// Re-resolve the checkout, the node binary and the port. Cheap, and run
    /// again before every start so a folder fixed in Settings takes effect.
    func refreshEnvironment() {
        // A shipped app installs (or re-installs) its copy of ProdDash before
        // going looking for one. An explicitly chosen folder skips all that.
        let base = ProdDash.dataDir(root: nil)
        if settings.rootPath.isEmpty {
            ProdDash.seedWorkingCopy(dataDir: base) { [log] message in log.launcher(message) }
        }
        let root = ProdDash.findRoot(preferred: settings.rootPath, dataDir: base)
        rootURL = root
        let node = ProdDash.findNode(root: root, preferred: settings.nodePath)
        if node?.path != nodeURL?.path {
            nodeURL = node
            nodeVersion = node.map(ProdDash.nodeVersion) ?? ""
        }
        if let root {
            let version = ProdDash.shellVersion(root: root)
            if !version.isEmpty { shellVersion = version }
        }
        if !state.isBusy {
            port = ProdDash.port(root: root, dataDir: dataDir)
        }
    }

    var dataDir: URL { ProdDash.dataDir(root: rootURL) }
    var dashboardURL: URL { URL(string: "http://localhost:\(port)/")! }
    var adminURL: URL { URL(string: "http://localhost:\(port)/admin")! }

    // MARK: - Start

    func start() {
        guard !state.isBusy else { return }
        pendingRestart?.cancel()
        pendingRestart = nil
        refreshEnvironment()

        guard let root = rootURL else {
            return fail("Can't find the ProdDash folder. Choose it under Settings.")
        }
        guard let node = nodeURL else {
            return fail("Node.js 18 or newer isn't installed. Install it from nodejs.org, or set the path under Settings.")
        }
        if ProdDash.nodeIsTooOld(nodeVersion) {
            return fail("This machine's node is \(nodeVersion) — ProdDash needs 18 or newer.")
        }

        state = .starting
        message = ""
        localURL = ""
        networkURLs = []
        healthy = false
        healthMisses = 0
        openedDashboardThisRun = false
        lastProblemLine = ""

        let port = self.port
        // The port probe and the "is that ProdDash?" request both block; keep
        // them off the main queue so the window stays live.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let busy = Net.probeSync(host: "127.0.0.1", port: UInt16(port), timeout: 1.0) == .open
            let isProdDash = busy && Self.respondsAsProdDash(port: port)
            DispatchQueue.main.async {
                guard let self, self.state == .starting else { return }
                guard busy else { return self.spawn(root: root, node: node, port: port) }
                guard let ask = self.onPortBusy else {
                    return self.fail("Port \(port) is already in use.")
                }
                ask(port, isProdDash) { takeOver in
                    guard takeOver else {
                        self.state = .stopped
                        self.message = "Port \(port) is already in use."
                        return
                    }
                    self.takeOverPort(port)
                    self.spawn(root: root, node: node, port: port)
                }
            }
        }
    }

    private func spawn(root: URL, node: URL, port: Int) {
        var env = ProcessInfo.processInfo.environment
        env["PRODDASH_LAUNCHER"] = "1"       // "someone is supervising me" — see the note above
        env["PORT"] = String(port)
        // A GUI app inherits almost no PATH. Put node's own folder first, and
        // keep the usual system ones so the Timers module can still find swiftc
        // when it needs to build its capture tool.
        let base = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = node.deletingLastPathComponent().path + ":" + base + ":/usr/local/bin:/opt/homebrew/bin"

        log.launcher("starting: \(node.path) server.js  (in \(root.path), port \(port))")
        do {
            child = try ChildProcess.run(
                executable: node.path,
                arguments: ["server.js"],
                directory: root.path,
                environment: env,
                onLine: { [weak self] line, isError in self?.handleOutput(line, isError: isError) },
                onExit: { [weak self] code, bySignal in self?.handleExit(code: code, bySignal: bySignal) })
            intentionalStop = false
            startedAt = Date()
            startHealthPolling()
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Hand the port over from a ProdDash somebody started another way. The
    /// server we are about to start waits for the port to free up on its own.
    private func takeOverPort(_ port: Int) {
        let pids = Net.listenerPIDs(port: port)
        guard !pids.isEmpty else { return }
        log.launcher("taking port \(port) over from pid \(pids.map(String.init).joined(separator: ", "))")
        for pid in pids { kill(pid, SIGTERM) }
        Thread.sleep(forTimeInterval: 0.6)
    }

    // MARK: - Stop / restart

    func stop() {
        pendingRestart?.cancel()
        pendingRestart = nil
        guard let child else {
            state = .stopped
            return
        }
        intentionalStop = true
        state = .stopping
        message = ""
        log.launcher("stopping ProdDash")
        child.terminate()
        let pid = child.pid
        // The server closes in about a second and a half; this is the backstop.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
            guard let self, let current = self.child, current.pid == pid, current.isAlive else { return }
            self.log.launcher("ProdDash didn't stop on its own after 8s — forcing it")
            current.forceKill()
        }
    }

    func restart() {
        guard child != nil else { return start() }
        restartAfterExit = true
        stop()
    }

    func toggle() {
        switch state {
        case .running, .starting: stop()
        case .stopped, .failed:   start()
        case .stopping:           break
        }
    }

    private func scheduleRestart(after seconds: TimeInterval) {
        let work = DispatchWorkItem { [weak self] in self?.start() }
        pendingRestart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func fail(_ reason: String) {
        state = .failed(reason)
        message = reason
        log.launcher(reason)
    }

    // MARK: - Child output

    private func handleOutput(_ line: String, isError: Bool) {
        log.append(line, kind: isError ? .err : .out)
        if line.contains("cannot start") || line.contains("Error:") || line.contains("EADDRINUSE") {
            lastProblemLine = line.trimmingCharacters(in: .whitespaces)
        }
        parseBanner(line)
    }

    /**
     The server prints a short banner once it is listening:

         ProdDash 1.3.0
           Local       : http://localhost:24500
           Network     : http://10.0.1.42:24500
           Modules     : clock, prodcom-transcript, …
           Settings    : /Users/booth/Library/Application Support/ProdDash

     Reading it is how the launcher learns it is really up (before the health
     poll gets there) and what to show in the window.
     */
    private func parseBanner(_ line: String) {
        let text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("ProdDash "), text.dropFirst(9).first?.isNumber == true {
            shellVersion = String(text.dropFirst(9)).trimmingCharacters(in: .whitespaces)
            if state == .starting {
                state = .running
                message = ""
                log.launcher("ProdDash \(shellVersion) is up on port \(port)")
                if settings.openDashboardOnStart { openDashboard() }
                openedDashboardThisRun = true
            }
            return
        }
        guard let colon = text.firstIndex(of: ":") else { return }
        let field = text[text.startIndex..<colon].trimmingCharacters(in: .whitespaces)
        let value = text[text.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        switch field {
        case "Local":    localURL = value
        case "Network":  if !networkURLs.contains(value) { networkURLs.append(value) }
        case "Settings": settingsDir = value
        default: break
        }
    }

    // MARK: - Exit

    private func handleExit(code: Int32, bySignal: Bool) {
        stopHealthPolling()
        child = nil
        healthy = false
        let ranFor = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        if ranFor > 60 { crashTimes.removeAll() }   // a long healthy run clears the slate

        if restartAfterExit {
            restartAfterExit = false
            state = .stopped
            start()
            return
        }
        if intentionalStop {
            state = .stopped
            message = "Stopped."
            log.launcher("ProdDash stopped")
            return
        }
        // 75 is the shell's "start me again" — the admin page applied an update.
        if !bySignal && code == 75 {
            log.launcher("ProdDash applied an update and asked to be restarted")
            state = .stopped
            message = "Restarting to apply an update…"
            start()
            return
        }

        let how = bySignal ? "was killed by signal \(code)" : "exited with code \(code)"
        let detail = lastProblemLine.isEmpty ? "" : " — \(lastProblemLine)"
        crashTimes.append(Date())
        crashTimes = crashTimes.filter { Date().timeIntervalSince($0) < 120 }

        guard settings.restartOnCrash, crashTimes.count < 4 else {
            let why = settings.restartOnCrash
                ? "ProdDash stopped \(crashTimes.count) times in two minutes — leaving it stopped."
                : "ProdDash \(how)."
            let last = lastProblemLine.isEmpty ? "" : " Last message: \(lastProblemLine)"
            fail(why + last)
            Notifier.shared.post(title: "ProdDash stopped", body: why)
            return
        }
        let delay = [1.0, 2.0, 5.0, 10.0][min(crashTimes.count - 1, 3)]
        state = .stopped
        message = "ProdDash \(how) — restarting…"
        log.launcher("ProdDash \(how)\(detail); restarting in \(Int(delay))s")
        Notifier.shared.post(title: "ProdDash stopped", body: "It \(how)\(detail). Restarting…")
        scheduleRestart(after: delay)
    }

    // MARK: - Health

    private func startHealthPolling() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.pollHealth() }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    private func stopHealthPolling() {
        healthTimer?.invalidate()
        healthTimer = nil
    }

    private func pollHealth() {
        let port = self.port
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ok = Self.respondsAsProdDash(port: port)
            DispatchQueue.main.async {
                guard let self, self.child != nil else { return }
                if ok {
                    self.healthMisses = 0
                    self.healthy = true
                    if self.state == .starting {
                        self.state = .running
                        if self.settings.openDashboardOnStart, !self.openedDashboardThisRun {
                            self.openedDashboardThisRun = true
                            self.openDashboard()
                        }
                    }
                } else {
                    self.healthMisses += 1
                    if self.healthMisses >= 2 { self.healthy = false }
                }
            }
        }
    }

    /// Does something on this port answer ProdDash's own unauthenticated
    /// module list? Blocking — background queues only.
    static func respondsAsProdDash(port: Int) -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/modules") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        request.httpMethod = "GET"
        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let data, let body = String(data: data, encoding: .utf8) else { return }
            ok = body.contains("\"modules\"")
        }.resume()
        _ = semaphore.wait(timeout: .now() + 3)
        return ok
    }

    // MARK: - Settings ProdDash owns

    /// Write the port where ProdDash reads it, then restart if it is running.
    func applyPort(_ newPort: Int) {
        guard ProdDash.isValidPort(newPort) else {
            message = "\(newPort) isn't a usable port number."
            return
        }
        guard newPort != port else { return }
        do {
            try ProdDash.setPort(newPort, dataDir: dataDir)
            port = newPort
            log.launcher("port set to \(newPort)")
            if child != nil { restart() }
        } catch {
            message = "Couldn't save the port: \(error.localizedDescription)"
            log.launcher(message)
        }
    }

    // MARK: - Opening things

    func openDashboard() { NSWorkspace.shared.open(dashboardURL) }
    func openAdmin() { NSWorkspace.shared.open(adminURL) }
}
