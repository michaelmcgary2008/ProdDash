import Foundation

/**
 The ProdDash server process, spawned into its OWN process group.

 Why not Foundation's `Process`: the server starts children of its own — the
 Timers module runs `ltc-capture`, which holds an audio input device open. If
 the launcher force-kills only node, that capture tool is orphaned and keeps
 the device (and the microphone indicator) until someone hunts it down in
 Activity Monitor. `posix_spawn` with POSIX_SPAWN_SETPGROUP makes the server a
 process-group leader, so `kill(-pid, …)` reaches the whole tree.

 Output arrives line by line on the main queue; `onExit` fires once, also on
 main, with the exit code and whether a signal killed it.
 */
final class ChildProcess {

    /// A spawn that never got off the ground, with something an operator can act on.
    struct SpawnError: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    let pid: pid_t
    /// What we ran, for the log.
    let commandLine: String

    /// Held for the life of the child: a FileHandle's readability handler does
    /// not retain it, so letting these go closes the pipes and the output
    /// silently stops.
    private let outPipe: Pipe
    private let errPipe: Pipe
    private var exitSource: DispatchSourceProcess?
    private var terminated = false

    private init(pid: pid_t, commandLine: String, outPipe: Pipe, errPipe: Pipe) {
        self.pid = pid
        self.commandLine = commandLine
        self.outPipe = outPipe
        self.errPipe = errPipe
    }

    deinit { releasePipes() }

    // MARK: - Spawning

    static func run(executable: String,
                    arguments: [String],
                    directory: String,
                    environment: [String: String],
                    onLine: @escaping (String, Bool) -> Void,
                    onExit: @escaping (Int32, Bool) -> Void) throws -> ChildProcess {

        let outPipe = Pipe()
        let errPipe = Pipe()

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        // The server never reads stdin; /dev/null keeps a stray read from blocking it.
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_adddup2(&actions, outPipe.fileHandleForWriting.fileDescriptor, 1)
        posix_spawn_file_actions_adddup2(&actions, errPipe.fileHandleForWriting.fileDescriptor, 2)
        posix_spawn_file_actions_addchdir_np(&actions, directory)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // SETPGROUP + pgroup 0: the child leads its own group (see the note above).
        // CLOEXEC_DEFAULT: nothing but the three descriptors above is inherited.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attr, 0)

        let argv: [UnsafeMutablePointer<CChar>?] = ([executable] + arguments).map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = environment
            .map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for p in argv where p != nil { free(p) }
            for p in envp where p != nil { free(p) }
        }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, executable, &actions, &attr, argv, envp)
        guard rc == 0 else {
            outPipe.closeBothEnds()
            errPipe.closeBothEnds()
            throw SpawnError(message: "could not start \(executable): \(String(cString: strerror(rc))) (\(rc))")
        }

        let child = ChildProcess(pid: pid,
                                 commandLine: ([executable] + arguments).joined(separator: " "),
                                 outPipe: outPipe, errPipe: errPipe)

        // Our copies of the write ends must go, or the reads never see EOF.
        try? outPipe.fileHandleForWriting.close()
        try? errPipe.fileHandleForWriting.close()
        child.pump(outPipe.fileHandleForReading, isError: false, onLine: onLine)
        child.pump(errPipe.fileHandleForReading, isError: true, onLine: onLine)

        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak child] in
            var status: Int32 = 0
            waitpid(pid, &status, 0)
            child?.exitSource?.cancel()
            child?.exitSource = nil
            // Give the last lines a moment to arrive before letting the pipes go.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { child?.releasePipes() }
            // Low 7 bits hold the signal that killed it; 0 means a normal exit.
            let signal = status & 0x7f
            if signal == 0 {
                onExit((status >> 8) & 0xff, false)
            } else {
                onExit(signal, true)
            }
        }
        child.exitSource = source
        source.resume()
        return child
    }

    /// Deliver whole lines on the main queue; partial trailing text waits for the rest.
    private func pump(_ handle: FileHandle, isError: Bool, onLine: @escaping (String, Bool) -> Void) {
        var buffer = Data()
        handle.readabilityHandler = { file in
            let chunk = file.availableData
            if chunk.isEmpty {                       // EOF — the child closed this end
                file.readabilityHandler = nil
                if !buffer.isEmpty, let tail = String(data: buffer, encoding: .utf8) {
                    DispatchQueue.main.async { onLine(tail, isError) }
                }
                try? file.close()
                return
            }
            buffer.append(chunk)
            var lines: [String] = []
            while let nl = buffer.firstIndex(of: 0x0a) {
                let raw = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                lines.append(String(data: raw, encoding: .utf8) ?? "")
            }
            if lines.isEmpty { return }
            DispatchQueue.main.async { for line in lines { onLine(line, isError) } }
        }
    }

    private func releasePipes() {
        for handle in [outPipe.fileHandleForReading, errPipe.fileHandleForReading] {
            handle.readabilityHandler = nil
            try? handle.close()
        }
    }

    // MARK: - Stopping

    var isAlive: Bool { kill(pid, 0) == 0 }

    /// SIGTERM to the whole group. The server unmounts its modules and exits
    /// within ~1.5 s; `forceKill()` is the backstop if it doesn't.
    func terminate() {
        guard !terminated else { return }
        terminated = true
        signalGroup(SIGTERM)
    }

    func forceKill() {
        signalGroup(SIGKILL)
    }

    private func signalGroup(_ sig: Int32) {
        // Only address the group when the child really leads one — otherwise a
        // negative pid could reach processes that are none of our business.
        if getpgid(pid) == pid {
            kill(-pid, sig)
        } else {
            kill(pid, sig)
        }
    }
}

private extension Pipe {
    func closeBothEnds() {
        try? fileHandleForReading.close()
        try? fileHandleForWriting.close()
    }
}
