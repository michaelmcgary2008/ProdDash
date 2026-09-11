import Foundation
import Network

/**
 Small connection probes, used for two jobs:

 * is something already listening on ProdDash's port (a server started over
   SSH or from the .command file, which the launcher offers to take over), and
 * can this machine actually reach the gear the modules are configured for —
   which on macOS 15+ is the only practical way to tell whether the Local
   Network permission was granted, because there is no API that reports it.

 Network.framework rather than a bare socket on purpose: a blocked local
 network connection surfaces here as a plain unreachable/timeout instead of a
 silent hang.
 */
enum Net {

    enum Probe: Equatable {
        case open                 // something accepted the connection
        case refused              // nothing listening, but the host answered
        case unreachable          // no route — or macOS is withholding local network access
        case timedOut
        case failed(String)

        var isReachableHost: Bool { self == .open || self == .refused }
    }

    /// Probe host:port, calling back on the main queue exactly once.
    static func probe(host: String, port: UInt16, timeout: TimeInterval = 2.0,
                      completion: @escaping (Probe) -> Void) {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            return DispatchQueue.main.async { completion(.failed("invalid port")) }
        }
        let tcp = NWProtocolTCP.Options()
        tcp.connectionTimeout = max(1, Int(timeout))
        tcp.noDelay = true
        let connection = NWConnection(host: NWEndpoint.Host(host), port: nwPort,
                                      using: NWParameters(tls: nil, tcp: tcp))

        var settled = false
        let finish: (Probe) -> Void = { result in
            guard !settled else { return }
            settled = true
            connection.cancel()
            DispatchQueue.main.async { completion(result) }
        }

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                finish(.open)
            case .waiting(let error):
                // "waiting" means it would keep retrying — for a probe that is the answer.
                finish(map(error))
            case .failed(let error):
                finish(map(error))
            case .cancelled:
                finish(.failed("cancelled"))
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .utility))
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { finish(.timedOut) }
    }

    /// Blocking form, for preflight on a background queue. Never call it on main.
    static func probeSync(host: String, port: UInt16, timeout: TimeInterval = 2.0) -> Probe {
        let semaphore = DispatchSemaphore(value: 0)
        var result: Probe = .timedOut
        probe(host: host, port: port, timeout: timeout) { outcome in
            result = outcome
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + timeout + 1.0)
        return result
    }

    private static func map(_ error: NWError) -> Probe {
        if case .posix(let code) = error {
            switch code {
            case .ECONNREFUSED: return .refused
            case .EHOSTUNREACH, .ENETUNREACH, .EHOSTDOWN, .ENETDOWN: return .unreachable
            case .ETIMEDOUT: return .timedOut
            default: return .failed(String(describing: code))
            }
        }
        return .failed(error.localizedDescription)
    }

    /// Is this address on this building's network (so the Local Network
    /// permission applies) rather than out on the internet?
    static func isLocalAddress(_ host: String) -> Bool {
        let name = host.lowercased()
        if name == "localhost" || name.hasSuffix(".local") || name.hasSuffix(".lan") { return true }
        let parts = name.split(separator: ".").map(String.init)
        guard parts.count == 4, let a = Int(parts[0]), let b = Int(parts[1]),
              parts.allSatisfy({ Int($0) != nil }) else {
            // A bare hostname with no dots is a LAN name; anything else is the internet.
            return !name.contains(".")
        }
        if a == 10 || a == 127 { return true }
        if a == 192 && b == 168 { return true }
        if a == 172 && (16...31).contains(b) { return true }
        if a == 169 && b == 254 { return true }
        return false
    }

    /// PIDs listening on a TCP port, so a stray ProdDash can be handed over.
    static func listenerPIDs(port: Int) -> [pid_t] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-t", "-iTCP:\(port)", "-sTCP:LISTEN"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "")
            .split(whereSeparator: \.isNewline)
            .compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }
}
