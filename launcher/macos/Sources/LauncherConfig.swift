import Foundation

/**
 Where things are, and which settings belong to whom.

 Two kinds of setting live in this app, and they are deliberately kept apart:

 * **ProdDash settings** (the port) belong to ProdDash, so they are written
   where ProdDash already looks for them — `proddash.json` in the per-machine
   data directory. Start the server any other way (`Start ProdDash.command`,
   a terminal) and it still comes up on the port set here.
 * **Launcher settings** (auto-start, restart-on-crash, where the checkout
   lives) belong to this app and live in its own preferences.

 The data-directory and port rules mirror server.js exactly — if that file's
 `resolveDataDir` / `PORT` logic changes, change it here too.
 */
enum ProdDash {

    // MARK: - Data directory (mirrors server.js resolveDataDir)

    /// `PRODDASH_DATA_DIR` if the environment sets one (relative paths resolve
    /// against the checkout, as in server.js), else the per-machine default.
    static func dataDir(root: URL?) -> URL {
        let fromEnv = (ProcessInfo.processInfo.environment["PRODDASH_DATA_DIR"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !fromEnv.isEmpty {
            if fromEnv.hasPrefix("/") { return URL(fileURLWithPath: fromEnv) }
            if let root { return root.appendingPathComponent(fromEnv).standardizedFileURL }
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ProdDash")
    }

    // MARK: - Finding the checkout

    /// A folder is ProdDash if it has the two files the server cannot run without.
    static func isRoot(_ url: URL) -> Bool {
        let fm = FileManager.default
        return fm.fileExists(atPath: url.appendingPathComponent("server.js").path)
            && fm.fileExists(atPath: url.appendingPathComponent("public/index.html").path)
    }

    /**
     Find the ProdDash folder: the one the operator chose, else the checkout
     this .app was built inside (the app usually sits in `launcher/macos/build`),
     else the handful of places people actually keep it.
     */
    static func findRoot(preferred: String?) -> URL? {
        if let preferred, !preferred.isEmpty {
            let url = URL(fileURLWithPath: preferred).standardizedFileURL
            if isRoot(url) { return url }
        }
        if let env = ProcessInfo.processInfo.environment["PRODDASH_ROOT"], !env.isEmpty {
            let url = URL(fileURLWithPath: env).standardizedFileURL
            if isRoot(url) { return url }
        }
        var up = Bundle.main.bundleURL.standardizedFileURL
        for _ in 0..<6 {
            up.deleteLastPathComponent()
            if up.path == "/" { break }
            if isRoot(up) { return up }
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        var candidates = [
            home.appendingPathComponent("Apps/ProdDash"),
            home.appendingPathComponent("ProdDash"),
            home.appendingPathComponent("Documents/ProdDash"),
            URL(fileURLWithPath: "/Applications/ProdDash"),
            URL(fileURLWithPath: "/Users/Shared/ProdDash"),
        ]
        // …and next to the app itself, for a "ProdDash Launcher.app beside the folder" layout.
        candidates.append(Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("ProdDash"))
        return candidates.first(where: isRoot)?.standardizedFileURL
    }

    /// The shell's version, straight from the checkout's package.json.
    static func shellVersion(root: URL) -> String {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String else { return "" }
        return version
    }

    // MARK: - Finding node

    /// Everywhere a Mac plausibly keeps node, in the order worth trying.
    static func findNode(root: URL?, preferred: String?) -> URL? {
        var tries: [URL] = []
        if let preferred, !preferred.isEmpty { tries.append(URL(fileURLWithPath: preferred)) }
        // The runtime a production machine ships with — same preference as Start ProdDash.command.
        if let root { tries.append(root.appendingPathComponent("runtime/bin/node")) }
        tries += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/opt/local/bin/node", "/usr/bin/node"]
            .map { URL(fileURLWithPath: $0) }
        let home = FileManager.default.homeDirectoryForCurrentUser
        tries += newestNodeUnder(home.appendingPathComponent(".nvm/versions/node"))
        tries += [home.appendingPathComponent(".volta/bin/node")]
        if let found = tries.first(where: isExecutable) { return found }
        // Last resort: ask a login shell, which is where a fancier version
        // manager (asdf, fnm, mise) puts node on the PATH.
        if let fromShell = loginShellNode(), isExecutable(fromShell) { return fromShell }
        return nil
    }

    private static func isExecutable(_ url: URL) -> Bool {
        FileManager.default.isExecutableFile(atPath: url.path)
    }

    private static func newestNodeUnder(_ dir: URL) -> [URL] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        return names.sorted { compareVersions($0, $1) > 0 }
            .map { dir.appendingPathComponent($0).appendingPathComponent("bin/node") }
    }

    private static func loginShellNode() -> URL? {
        let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: shell)
        task.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.hasPrefix("/") ? URL(fileURLWithPath: path) : nil
    }

    /// `node -v`, so the window can say which runtime is about to be used.
    static func nodeVersion(_ node: URL) -> String {
        let task = Process()
        task.executableURL = node
        task.arguments = ["-v"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// node 18 is the floor the server's package.json declares.
    static func nodeIsTooOld(_ version: String) -> Bool {
        let major = Int(version.dropFirst(version.hasPrefix("v") ? 1 : 0)
            .prefix(while: { $0.isNumber })) ?? 0
        return major > 0 && major < 18
    }

    // MARK: - The port (mirrors server.js: PORT env, then data dir, then checkout, then 24500)

    static let defaultPort = 24500

    static func port(root: URL?, dataDir: URL) -> Int {
        if let fromFile = jsonNumber(at: dataDir.appendingPathComponent("proddash.json"), key: "port") {
            return fromFile
        }
        if let root, let fromRepo = jsonNumber(at: root.appendingPathComponent("config/proddash.json"), key: "port") {
            return fromRepo
        }
        return defaultPort
    }

    /**
     Write the port into the data directory's proddash.json, preserving every
     other key (the admin passcode lives in the same file). The launcher also
     passes PORT to the server it starts, so this write is what keeps a start
     by any other means on the same port.
     */
    static func setPort(_ port: Int, dataDir: URL) throws {
        let file = dataDir.appendingPathComponent("proddash.json")
        var object: [String: Any] = [:]
        if let data = try? Data(contentsOf: file),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            object = existing
        }
        object["port"] = port
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        // Same atomic-ish write the server uses: never leave a half-written config.
        let tmp = file.appendingPathExtension("tmp")
        try Data((inHouseStyle(data) + "\n").utf8).write(to: tmp)
        _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
    }

    /// Foundation writes `"port" : 24500`; the server writes `"port": 24500`.
    /// This file is read and hand-edited by people — keep one house style.
    private static func inHouseStyle(_ json: Data) -> String {
        (String(data: json, encoding: .utf8) ?? "")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line in
                guard line.trimmingCharacters(in: .whitespaces).hasPrefix("\""),
                      let colon = line.range(of: "\" : ") else { return String(line) }
                return line.replacingCharacters(in: colon, with: "\": ")
            }
            .joined(separator: "\n")
    }

    static func isValidPort(_ port: Int) -> Bool { port >= 1 && port <= 65535 }

    private static func jsonNumber(at url: URL, key: String) -> Int? {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = json[key] as? NSNumber else { return nil }
        let port = value.intValue
        return isValidPort(port) ? port : nil
    }

    // MARK: - Misc

    /// "1.10.0" > "1.9.0" — the numeric comparison version strings deserve.
    static func compareVersions(_ a: String, _ b: String) -> Int {
        let lhs = a.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        let rhs = b.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        for i in 0..<max(lhs.count, rhs.count) {
            let l = i < lhs.count ? lhs[i] : 0
            let r = i < rhs.count ? rhs[i] : 0
            if l != r { return l < r ? -1 : 1 }
        }
        return 0
    }
}
