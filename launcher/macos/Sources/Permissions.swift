import AVFoundation
import Foundation
import Network
import UserNotifications

/**
 The permissions ProdDash's modules need, and this app's job of holding them.

 A module can say what it needs in its manifest, which is how this pane knows
 to mention the microphone at all:

     "permissions": [
       { "kind": "microphone", "reason": "Decoding LTC timecode from an audio input" }
     ]

 The shell ignores the key; only the launcher reads it. A bare
 `"permissions": ["microphone"]` works too, and a kind this launcher doesn't
 manage is still listed — better to name it than to pretend it isn't needed.
 */
enum PermissionKind: Hashable {
    case microphone
    case localNetwork
    case other(String)

    init(raw: String) {
        switch raw.lowercased().replacingOccurrences(of: " ", with: "-")
            .replacingOccurrences(of: "_", with: "-") {
        case "microphone", "audio-input", "mic": self = .microphone
        case "local-network", "localnetwork", "lan": self = .localNetwork
        case let other: self = .other(other)
        }
    }

    var id: String {
        switch self {
        case .microphone: return "microphone"
        case .localNetwork: return "local-network"
        case .other(let raw): return raw
        }
    }

    var title: String {
        switch self {
        case .microphone: return "Microphone"
        case .localNetwork: return "Local Network"
        case .other(let raw): return raw.capitalized
        }
    }

    /// Every module that needs LTC needs the same thing; this is the standing
    /// explanation when a module doesn't give its own.
    var defaultReason: String {
        switch self {
        case .microphone:
            return "Reading an audio input on this machine."
        case .localNetwork:
            return "Reaching production gear on this network."
        case .other:
            return "Required by a module."
        }
    }
}

/// Why one set of modules needs a permission. Modules that give the same
/// reason are listed together, so three modules reaching the same network
/// don't produce three near-identical lines.
struct PermissionClaim: Identifiable, Equatable {
    let reason: String
    var modules: [String]
    var id: String { reason }

    var askedBy: String { modules.joined(separator: ", ") }
}

/// One permission, and everyone who asked for it.
struct ModuleNeed: Identifiable, Equatable {
    let kind: PermissionKind
    var claims: [PermissionClaim] = []
    var id: String { kind.id }

    var modules: [String] {
        var seen: [String] = []
        for claim in claims where !claim.modules.isEmpty {
            for module in claim.modules where !seen.contains(module) { seen.append(module) }
        }
        return seen
    }
}

/// A configured upstream and whether this machine can reach it.
struct HostCheck: Identifiable {
    let id = UUID()
    let module: String
    let host: String
    let port: Int
    var result: Net.Probe?

    var label: String { "\(host):\(port)" }
}

final class PermissionsModel: ObservableObject {

    @Published private(set) var needs: [ModuleNeed] = []
    @Published private(set) var microphone: AVAuthorizationStatus = .notDetermined
    @Published private(set) var notifications: UNAuthorizationStatus = .notDetermined
    @Published private(set) var hostChecks: [HostCheck] = []
    @Published private(set) var checking = false

    private var browser: NWBrowser?

    // MARK: - Status

    func refresh(root: URL?, dataDir: URL) {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        if status != microphone { microphone = status }
        Notifier.shared.refreshStatus { [weak self] status in
            if status != self?.notifications { self?.notifications = status }
        }
        let scanned = Self.scanModules(root: root, dataDir: dataDir)
        if scanned != needs { needs = scanned }
        if hostChecks.isEmpty {
            let hosts = Self.configuredLocalHosts(root: root, dataDir: dataDir)
            if !hosts.isEmpty { hostChecks = hosts }
        }
    }

    func requestMicrophone() {
        guard microphone == .notDetermined else {
            return SystemSettings.open(SystemSettings.microphone)
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
            DispatchQueue.main.async {
                self?.microphone = AVCaptureDevice.authorizationStatus(for: .audio)
                LogStore.shared.launcher("microphone access: \(self?.microphone.description ?? "?")")
            }
        }
    }

    func requestNotifications() {
        guard notifications == .notDetermined else {
            return SystemSettings.open(SystemSettings.notifications)
        }
        Notifier.shared.requestAuthorization { [weak self] _ in
            Notifier.shared.refreshStatus { status in self?.notifications = status }
        }
    }

    // MARK: - Local network

    /**
     macOS never reports whether local network access was granted, so this
     does the only thing that actually answers the question: touch the network
     the way the modules do — a Bonjour browse (which is what raises the
     prompt) and a connection attempt to each configured upstream — then say
     what the results mean.
     */
    func checkLocalNetwork(root: URL?, dataDir: URL) {
        guard !checking else { return }
        var checks = Self.configuredLocalHosts(root: root, dataDir: dataDir)
        checking = true
        for index in checks.indices { checks[index].result = nil }
        hostChecks = checks
        startBonjourBrowse()

        guard !checks.isEmpty else {
            // Nothing configured yet: the browse alone still raises the prompt.
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                self?.checking = false
                LogStore.shared.launcher("local network check: nothing configured to try yet")
            }
            return
        }

        let group = DispatchGroup()
        for (index, check) in checks.enumerated() {
            group.enter()
            Net.probe(host: check.host, port: UInt16(check.port), timeout: 3) { [weak self] result in
                self?.hostChecks[index].result = result
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in
            guard let self else { return }
            self.checking = false
            self.stopBonjourBrowse()
            let results = self.hostChecks.compactMap(\.result)
            let answered = results.filter(\.isReachableHost).count
            let verdict: String
            if answered == results.count {
                verdict = "every configured host answered"
            } else if answered == 0 {
                verdict = "nothing answered — if the gear is on, macOS is withholding local network access"
            } else {
                verdict = "\(answered) of \(results.count) hosts answered"
            }
            LogStore.shared.launcher("local network check: \(verdict)")
        }
    }

    /// Browsing for Bonjour services is what makes macOS raise the local
    /// network prompt; the results themselves don't matter here.
    private func startBonjourBrowse() {
        stopBonjourBrowse()
        let browser = NWBrowser(for: .bonjour(type: "_http._tcp", domain: nil), using: .tcp)
        browser.start(queue: .global(qos: .utility))
        self.browser = browser
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.stopBonjourBrowse() }
    }

    private func stopBonjourBrowse() {
        browser?.cancel()
        browser = nil
    }

    // MARK: - Reading the modules

    /// Manifests from both places the shell looks: the checkout and the
    /// modules installed from the admin page.
    private static func moduleManifests(root: URL?, dataDir: URL) -> [(id: String, name: String, json: [String: Any])] {
        var found: [String: (String, [String: Any])] = [:]
        for base in [root?.appendingPathComponent("modules"), dataDir.appendingPathComponent("modules")].compactMap({ $0 }) {
            let dirs = (try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? []
            for dir in dirs where !dir.hasPrefix(".") {
                let file = base.appendingPathComponent(dir).appendingPathComponent("module.json")
                guard let data = try? Data(contentsOf: file),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                found[dir] = (json["name"] as? String ?? dir, json)
            }
        }
        return found.map { (id: $0.key, name: $0.value.0, json: $0.value.1) }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    static func scanModules(root: URL?, dataDir: URL) -> [ModuleNeed] {
        var byKind: [PermissionKind: ModuleNeed] = [:]
        for module in moduleManifests(root: root, dataDir: dataDir) {
            guard let raw = module.json["permissions"] as? [Any] else { continue }
            for entry in raw {
                var kind: PermissionKind?
                var reason = ""
                if let name = entry as? String {
                    kind = PermissionKind(raw: name)
                } else if let object = entry as? [String: Any], let name = object["kind"] as? String {
                    kind = PermissionKind(raw: name)
                    reason = (object["reason"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                }
                guard let kind else { continue }
                var need = byKind[kind] ?? ModuleNeed(kind: kind)
                let text = reason.isEmpty ? kind.defaultReason : reason
                if let index = need.claims.firstIndex(where: { $0.reason == text }) {
                    if !need.claims[index].modules.contains(module.name) {
                        need.claims[index].modules.append(module.name)
                    }
                } else {
                    need.claims.append(PermissionClaim(reason: text, modules: [module.name]))
                }
                byKind[kind] = need
            }
        }
        // Stable order: the two the launcher manages first, then anything else.
        let order: [PermissionKind] = [.microphone, .localNetwork]
        return byKind.values.sorted {
            let a = order.firstIndex(of: $0.kind) ?? order.count
            let b = order.firstIndex(of: $1.kind) ?? order.count
            return a == b ? $0.kind.title < $1.kind.title : a < b
        }
    }

    /**
     The upstreams the admin page has been pointed at, pulled out of the
     module config the server writes (modules.json). Endpoint settings are
     `{ host, port }` objects and URLs are strings — both shapes appear, and
     both are worth testing, so this walks the config rather than knowing any
     particular module's key names.
     */
    static func configuredLocalHosts(root: URL?, dataDir: URL) -> [HostCheck] {
        guard let data = try? Data(contentsOf: dataDir.appendingPathComponent("modules.json")),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [] }
        let names = Dictionary(uniqueKeysWithValues: moduleManifests(root: root, dataDir: dataDir).map { ($0.id, $0.name) })
        var checks: [HostCheck] = []
        var seen = Set<String>()

        func consider(_ host: String, _ port: Int, module: String) {
            let host = host.trimmingCharacters(in: .whitespaces)
            guard !host.isEmpty, Net.isLocalAddress(host), host != "localhost", host != "127.0.0.1" else { return }
            let key = "\(host):\(port)"
            guard !seen.contains(key) else { return }
            seen.insert(key)
            checks.append(HostCheck(module: module, host: host, port: port))
        }

        func walk(_ value: Any, module: String) {
            if let object = value as? [String: Any] {
                if let host = object["host"] as? String {
                    consider(host, (object["port"] as? NSNumber)?.intValue ?? 80, module: module)
                }
                for nested in object.values { walk(nested, module: module) }
            } else if let list = value as? [Any] {
                for nested in list { walk(nested, module: module) }
            } else if let text = value as? String, text.contains("://"),
                      let parts = URLComponents(string: text), let host = parts.host {
                consider(host, parts.port ?? (parts.scheme == "https" ? 443 : 80), module: module)
            }
        }

        for (id, entry) in config {
            guard let entry = entry as? [String: Any], let moduleConfig = entry["config"] else { continue }
            walk(moduleConfig, module: names[id] ?? id)
        }
        return checks.sorted { $0.module < $1.module }
    }
}

extension AVAuthorizationStatus {
    var description: String {
        switch self {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not asked yet"
        @unknown default: return "unknown"
        }
    }
}
