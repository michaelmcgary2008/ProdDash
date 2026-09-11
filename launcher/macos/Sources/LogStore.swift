import Foundation

/**
 Everything the server prints, plus what the launcher did and why.

 Kept twice over: the last few hundred lines in memory for the window's Log
 tab, and a dated file under ~/Library/Logs/ProdDash so a problem from last
 Sunday can still be read on Tuesday. Files older than a week are removed on
 startup — the same retention Companion's launcher keeps.
 */
final class LogStore: ObservableObject {

    enum Kind { case launcher, out, err }

    struct Line: Identifiable {
        let id = UUID()
        let at: Date
        let text: String
        let kind: Kind
    }

    static let shared = LogStore()

    /// Enough to cover a start-up and a fault, not enough to bloat the window.
    private let capacity = 800
    private let retentionDays = 7

    @Published private(set) var lines: [Line] = []

    private let queue = DispatchQueue(label: "org.waterschurch.proddash.launcher.log")
    private var handle: FileHandle?
    private var handleDay: String = ""

    private lazy var directory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/ProdDash")

    private init() {
        queue.async { [weak self] in self?.pruneOldFiles() }
    }

    /// The launcher's own voice in the log — start/stop decisions, failures.
    func launcher(_ text: String) { append(text, kind: .launcher) }

    func append(_ text: String, kind: Kind) {
        let line = Line(at: Date(), text: text, kind: kind)
        if Thread.isMainThread {
            store(line)
        } else {
            DispatchQueue.main.async { self.store(line) }
        }
        queue.async { [weak self] in self?.write(line) }
    }

    private func store(_ line: Line) {
        lines.append(line)
        if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
    }

    func clear() {
        lines.removeAll()
    }

    /// Today's file, for "Reveal in Finder".
    var currentFile: URL { directory.appendingPathComponent("proddash-\(Self.dayFormatter.string(from: Date())).log") }

    var plainText: String {
        lines.map { "\(Self.timeFormatter.string(from: $0.at))  \($0.text)" }.joined(separator: "\n")
    }

    // MARK: - File

    private func write(_ line: Line) {
        let day = Self.dayFormatter.string(from: line.at)
        if handle == nil || handleDay != day {
            try? handle?.close()
            handle = nil
            handleDay = day
            let file = directory.appendingPathComponent("proddash-\(day).log")
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil)
            }
            handle = try? FileHandle(forWritingTo: file)
            _ = try? handle?.seekToEnd()
        }
        let prefix = line.kind == .launcher ? "[launcher] " : ""
        let text = "\(Self.stampFormatter.string(from: line.at)) \(prefix)\(line.text)\n"
        try? handle?.write(contentsOf: Data(text.utf8))
    }

    private func pruneOldFiles() {
        let cutoff = Date().addingTimeInterval(-Double(retentionDays) * 86400)
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for file in files where file.lastPathComponent.hasPrefix("proddash-") {
            let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let modified, modified < cutoff { try? FileManager.default.removeItem(at: file) }
        }
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    private static let stampFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()
}
