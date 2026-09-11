import AVFoundation
import SwiftUI
import UserNotifications

/**
 The permissions pane.

 This is the reason the launcher exists as much as the start button is: macOS
 grants privacy permissions to the *app* that owns the process tree, so when
 ProdDash runs as this app's child, the prompts are asked in ProdDash's name
 and stay granted. What each module needs is read from its own manifest, so
 this list matches what is actually installed.
 */
struct PermissionsPane: View {

    @ObservedObject var server: ServerController
    @ObservedObject var settings: LauncherSettings
    @ObservedObject var permissions: PermissionsModel

    var body: some View {
        Form {
            Section {
                Text("ProdDash's modules ask macOS for these through the launcher. Start the server any other way "
                     + "— over SSH, from a launchd job — and the permissions belong to that instead, which is why "
                     + "LTC goes quietly silent when it isn't launched from here.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if permissions.needs.isEmpty {
                Section("Modules") {
                    Text("No installed module declares a permission.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(permissions.needs) { need in
                Section(need.kind.title) {
                    NeedHeader(need: need)
                    switch need.kind {
                    case .microphone:   microphoneControls
                    case .localNetwork: localNetworkControls
                    case .other:
                        Text("The launcher doesn't manage this one — grant it in System Settings → Privacy & Security.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Notifications") {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Tell me when ProdDash stops")
                        Text("The launcher's own — so a server that stops on a booth machine nobody is watching "
                             + "still reaches someone.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusText(text: notificationLabel, tone: notificationTone)
                }
                Toggle("Notify me", isOn: Binding(
                    get: { settings.notifyOnProblem },
                    set: { on in
                        settings.notifyOnProblem = on
                        if on { permissions.requestNotifications() }
                    }))
                if permissions.notifications == .denied {
                    Button("Open Notification Settings") { SystemSettings.open(SystemSettings.notifications) }
                        .controlSize(.small)
                }
            }

            Section {
                Button("Re-check") {
                    permissions.refresh(root: server.rootURL, dataDir: server.dataDir)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { permissions.refresh(root: server.rootURL, dataDir: server.dataDir) }
    }

    // MARK: - Microphone

    private var microphoneControls: some View {
        HStack {
            StatusText(text: permissions.microphone.description, tone: microphoneTone)
            Spacer()
            switch permissions.microphone {
            case .notDetermined:
                Button("Allow…") { permissions.requestMicrophone() }
            case .denied, .restricted:
                Button("Open System Settings") { SystemSettings.open(SystemSettings.microphone) }
            default:
                Button("Open System Settings") { SystemSettings.open(SystemSettings.microphone) }
                    .controlSize(.small)
            }
        }
    }

    private var microphoneTone: Tone {
        switch permissions.microphone {
        case .authorized: return .good
        case .denied, .restricted: return .bad
        default: return .unknown
        }
    }

    // MARK: - Local network

    private var localNetworkControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("macOS never reports whether this was granted, so the check below asks the network directly: "
                 + "it browses for services (which is what raises the prompt) and tries every upstream the admin "
                 + "page is pointed at.")
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 8) {
                Button(permissions.checking ? "Checking…" : "Check Access") {
                    permissions.checkLocalNetwork(root: server.rootURL, dataDir: server.dataDir)
                }
                .disabled(permissions.checking)
                if permissions.checking {
                    ProgressView().controlSize(.small)
                }
                Spacer()
                Button("Open System Settings") { SystemSettings.open(SystemSettings.localNetwork) }
                    .controlSize(.small)
            }

            ForEach(permissions.hostChecks) { check in
                HStack(spacing: 8) {
                    Circle()
                        .fill(tone(for: check.result).color)
                        .frame(width: 7, height: 7)
                    Text(check.label)
                        .font(.system(.caption, design: .monospaced))
                    Text(check.module)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer()
                    Text(describe(check.result))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if !permissions.localNetworkVerdict.isEmpty {
                Text(permissions.localNetworkVerdict)
                    .font(.caption)
                    .foregroundStyle(permissions.localNetworkVerdict.contains("working") ? .secondary : .primary)
            }
        }
    }

    private func describe(_ result: Net.Probe?) -> String {
        switch result {
        case .none:              return "—"
        case .open:              return "answered"
        case .refused:           return "reachable, nothing on that port"
        case .unreachable:       return "no route"
        case .timedOut:          return "no answer"
        case .failed(let why):   return why
        }
    }

    private func tone(for result: Net.Probe?) -> Tone {
        guard let result else { return .unknown }
        return result.isReachableHost ? .good : .bad
    }

    private var notificationLabel: String {
        switch permissions.notifications {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "not asked yet"
        @unknown default: return "unknown"
        }
    }

    private var notificationTone: Tone {
        switch permissions.notifications {
        case .authorized, .provisional, .ephemeral: return .good
        case .denied: return .bad
        default: return .unknown
        }
    }
}

// MARK: - Small pieces

enum Tone {
    case good, bad, unknown

    var color: Color {
        switch self {
        case .good: return Color(nsColor: StatusIcon.accent)
        case .bad: return Color(nsColor: StatusIcon.danger)
        case .unknown: return .secondary
        }
    }
}

private struct StatusText: View {
    let text: String
    let tone: Tone

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(tone.color).frame(width: 7, height: 7)
            Text(text).font(.callout)
        }
    }
}

private struct NeedHeader: View {
    let need: ModuleNeed

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(need.claims) { claim in
                VStack(alignment: .leading, spacing: 3) {
                    Text(claim.reason)
                    Text("Needed by \(claim.askedBy)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
