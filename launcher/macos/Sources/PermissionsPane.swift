import AVFoundation
import SwiftUI
import UserNotifications

/**
 The permissions pane: one line per permission — a status dot, its name, and
 the one thing you can do about it.

 What appears here is what the installed modules declare in their manifests,
 so the list matches what is actually installed. Each row's tooltip carries
 the modules' own reasons; the row itself stays out of the way.
 */
struct PermissionsPane: View {

    @ObservedObject var server: ServerController
    @ObservedObject var permissions: PermissionsModel

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section {
                    if permissions.needs.isEmpty {
                        Text("No installed module declares a permission.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(permissions.needs) { need in
                        row(for: need)
                    }
                    notifications
                }
            }
            .formStyle(.grouped)

            Button("Re-check") {
                permissions.refresh(root: server.rootURL, dataDir: server.dataDir)
            }
            .padding(.bottom, 14)
        }
        .onAppear { permissions.refresh(root: server.rootURL, dataDir: server.dataDir) }
    }

    // MARK: - Rows

    @ViewBuilder
    private func row(for need: ModuleNeed) -> some View {
        switch need.kind {
        case .microphone:
            PermissionRow(title: need.kind.title,
                          tone: microphoneTone,
                          help: help(for: need),
                          actionTitle: microphoneActionTitle,
                          action: microphoneActionTitle == nil ? nil : { requestMicrophone() })

        case .localNetwork:
            VStack(alignment: .leading, spacing: 7) {
                PermissionRow(title: need.kind.title,
                              tone: localNetworkTone,
                              help: help(for: need),
                              busy: permissions.checking,
                              actionTitle: "Check Access",
                              action: { permissions.checkLocalNetwork(root: server.rootURL, dataDir: server.dataDir) })
                if !results.isEmpty { hostResults }
            }

        case .other:
            PermissionRow(title: need.kind.title,
                          tone: .unknown,
                          help: "The launcher doesn't manage this one — grant it in System Settings.\n"
                              + help(for: need),
                          actionTitle: "Open System Settings",
                          action: { SystemSettings.open(SystemSettings.privacy) })
        }
    }

    private var notifications: some View {
        PermissionRow(title: "Notifications",
                      tone: notificationTone,
                      help: "Tells you when ProdDash stops on its own.",
                      actionTitle: notificationActionTitle,
                      action: notificationActionTitle == nil ? nil : { permissions.requestNotifications() })
    }

    /// What the modules said, for the tooltip — one line per distinct reason.
    private func help(for need: ModuleNeed) -> String {
        need.claims
            .map { $0.modules.isEmpty ? $0.reason : "\($0.reason) — \($0.askedBy)" }
            .joined(separator: "\n")
    }

    // MARK: - Local network results

    private var results: [Net.Probe] { permissions.hostChecks.compactMap(\.result) }

    private var hostResults: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(permissions.hostChecks) { check in
                HStack(spacing: 8) {
                    Circle()
                        .fill(tone(for: check.result).color)
                        .frame(width: 6, height: 6)
                    Text(check.label)
                        .font(.system(.caption, design: .monospaced))
                    Spacer()
                    Text(describe(check.result))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if !results.isEmpty, !results.contains(where: \.isReachableHost) {
                // Only when everything failed, because that is the shape a
                // withheld permission takes.
                HStack(spacing: 8) {
                    Text("Nothing answered.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Open System Settings") { SystemSettings.open(SystemSettings.localNetwork) }
                        .buttonStyle(.link)
                        .controlSize(.small)
                }
            }
        }
        .padding(.leading, 17)
    }

    private func describe(_ result: Net.Probe?) -> String {
        switch result {
        case .none:            return "—"
        case .open:            return "answered"
        case .refused:         return "reachable"
        case .unreachable:     return "no route"
        case .timedOut:        return "no answer"
        case .failed(let why): return why
        }
    }

    private func tone(for result: Net.Probe?) -> Tone {
        guard let result else { return .unknown }
        return result.isReachableHost ? .good : .bad
    }

    // MARK: - Status and actions

    private func requestMicrophone() {
        permissions.requestMicrophone()
    }

    private var microphoneTone: Tone {
        switch permissions.microphone {
        case .authorized: return .good
        case .denied, .restricted: return .bad
        default: return .unknown
        }
    }

    private var microphoneActionTitle: String? {
        switch permissions.microphone {
        case .authorized: return nil
        case .notDetermined: return "Allow"
        default: return "Open System Settings"
        }
    }

    /// Anything answering means the permission is there; only a clean sweep of
    /// failures points at macOS withholding it.
    private var localNetworkTone: Tone {
        guard !results.isEmpty else { return .unknown }
        return results.contains(where: \.isReachableHost) ? .good : .bad
    }

    private var notificationTone: Tone {
        switch permissions.notifications {
        case .authorized, .provisional, .ephemeral: return .good
        case .denied: return .bad
        default: return .unknown
        }
    }

    private var notificationActionTitle: String? {
        switch permissions.notifications {
        case .authorized, .provisional, .ephemeral: return nil
        case .notDetermined: return "Enable"
        default: return "Open System Settings"
        }
    }
}

// MARK: - Pieces

enum Tone {
    case good, bad, unknown

    var color: Color {
        switch self {
        case .good: return Color(nsColor: StatusIcon.accent)
        case .bad: return Color(nsColor: StatusIcon.danger)
        case .unknown: return .secondary
        }
    }

    /// Said out loud for anyone who can't see the dot.
    var word: String {
        switch self {
        case .good: return "allowed"
        case .bad: return "not allowed"
        case .unknown: return "not checked"
        }
    }
}

private struct PermissionRow: View {
    let title: String
    let tone: Tone
    let help: String
    var busy = false
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 9) {
            Circle()
                .fill(tone.color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)          // the name carries the status instead
            Text(title)
                .accessibilityLabel("\(title): \(tone.word)")
            Spacer()
            if busy { ProgressView().controlSize(.small) }
            if let actionTitle, let action {
                Button(actionTitle, action: action).disabled(busy)
            }
        }
        .help(help)
    }
}
