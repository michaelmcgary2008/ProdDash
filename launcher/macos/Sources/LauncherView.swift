import AVFoundation
import AppKit
import SwiftUI
import UserNotifications

/**
 The launcher window: what ProdDash is doing at the top, and the three things
 an operator ever needs underneath — what it is saying (Log), how it runs
 (Settings), and what macOS is letting it do (Permissions).
 */
struct LauncherView: View {

    @ObservedObject var server: ServerController
    @ObservedObject var settings: LauncherSettings
    @ObservedObject var permissions: PermissionsModel
    let onHide: () -> Void
    let onQuit: () -> Void

    private enum Tab: String, CaseIterable, Identifiable {
        case log = "Log", settings = "Settings", permissions = "Permissions"
        var id: String { rawValue }
    }
    @State private var tab: Tab = .log

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            addresses
            Divider()
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            Group {
                switch tab {
                case .log:
                    LogPane()
                case .settings:
                    SettingsPane(server: server, settings: settings)
                case .permissions:
                    PermissionsPane(server: server, permissions: permissions)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()
            footer
        }
        .frame(minWidth: 540, idealWidth: 580, maxWidth: .infinity,
               minHeight: 520, idealHeight: 740, maxHeight: .infinity)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 14) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 46, height: 46)
            VStack(alignment: .leading, spacing: 3) {
                Text("ProdDash").font(.system(size: 19, weight: .semibold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 5) {
                StatusPill(state: server.state, healthy: server.healthy)
                if !server.message.isEmpty {
                    Text(server.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 260, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 22)
        .padding(.bottom, 14)
    }

    private var subtitle: String {
        var parts: [String] = []
        if !server.shellVersion.isEmpty { parts.append("v\(server.shellVersion)") }
        if !server.nodeVersion.isEmpty { parts.append("node \(server.nodeVersion)") }
        return parts.joined(separator: "  ·  ")
    }

    // MARK: - Addresses and the controls that matter

    private var addresses: some View {
        VStack(alignment: .leading, spacing: 10) {
            if server.state == .running {
                AddressRow(label: "This Mac", url: server.localURL.isEmpty
                           ? "http://localhost:\(server.port)" : server.localURL)
                ForEach(server.networkURLs, id: \.self) { url in
                    AddressRow(label: "Network", url: url)
                }
            } else {
                Text("Not serving. ProdDash will come up on port " + String(server.port) + ".")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                switch server.state {
                case .running, .starting:
                    Button("Stop") { server.stop() }
                case .stopping:
                    Button("Stopping…") {}.disabled(true)
                case .stopped, .failed:
                    Button("Start") { server.start() }.keyboardShortcut(.defaultAction)
                }
                Button("Restart") { server.restart() }
                    .disabled(server.state != .running && server.state != .starting)
                Spacer()
                Button("Open Dashboard") { server.openDashboard() }
                    .disabled(server.state != .running)
                Button("Admin") { server.openAdmin() }
                    .disabled(server.state != .running)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack {
            Button("Hide") { onHide() }
                .help("Closes this window; ProdDash keeps running in the menu bar.")
            Spacer()
            Text("Launcher \(AppDelegate.version)")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
            Button("Quit ProdDash") { onQuit() }
                .help("Stops the server and quits the launcher.")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - Pieces

private struct StatusPill: View {
    let state: ServerState
    let healthy: Bool

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(Color(nsColor: StatusIcon.color(for: state, healthy: healthy)))
                .frame(width: 9, height: 9)
            Text(state == .running && !healthy ? "Running (not answering)" : state.label)
                .font(.system(size: 13, weight: .medium))
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 5)
        .background(Color(nsColor: .quaternaryLabelColor).opacity(0.5), in: Capsule())
    }
}

private struct AddressRow: View {
    let label: String
    let url: String

    var body: some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 58, alignment: .leading)
            Text(url)
                .font(.system(.callout, design: .monospaced))
                .textSelection(.enabled)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy this address")
            Spacer()
        }
    }
}

// MARK: - Log

private struct LogPane: View {
    @ObservedObject private var log = LogStore.shared
    @State private var follow = true

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(log.lines) { line in
                            Text(line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(color(for: line.kind))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(10)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .onChange(of: log.lines.count) { _ in
                    guard follow else { return }
                    withAnimation(.none) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            HStack(spacing: 8) {
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox)
                Spacer()
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(log.plainText, forType: .string)
                }
                Button("Reveal Log File") {
                    NSWorkspace.shared.activateFileViewerSelecting([log.currentFile])
                }
                Button("Clear") { log.clear() }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
    }

    private func color(for kind: LogStore.Kind) -> Color {
        switch kind {
        case .launcher: return .accentColor
        case .err: return .orange
        case .out: return .primary
        }
    }
}

// MARK: - Settings

private struct SettingsPane: View {
    @ObservedObject var server: ServerController
    @ObservedObject var settings: LauncherSettings

    @State private var portText = ""
    @State private var loginItemOn = LoginItem.isEnabled
    @State private var loginNeedsApproval = LoginItem.needsApproval

    var body: some View {
        Form {
            Section("Network") {
                HStack {
                    TextField("Port", text: $portText)
                        .frame(width: 90)
                        .onSubmit(applyPort)
                    Button("Apply", action: applyPort)
                        .disabled(Int(portText) == server.port || Int(portText) == nil)
                    Spacer()
                }
            }

            Section("Startup") {
                Toggle("Open ProdDash at login", isOn: Binding(
                    get: { loginItemOn },
                    set: { setLoginItem($0) }))
                if loginNeedsApproval {
                    HStack(spacing: 8) {
                        Text("macOS is holding this until you allow it.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Open Login Items") { LoginItem.openSystemSettings() }
                            .controlSize(.small)
                    }
                }
                Toggle("Start the server when the launcher opens", isOn: $settings.startServerAtLaunch)
                Toggle("Restart the server if it stops unexpectedly", isOn: $settings.restartOnCrash)
                Toggle("Open the dashboard in a browser when the server starts", isOn: $settings.openDashboardOnStart)
                Toggle("Show this window at launch", isOn: $settings.showWindowAtLaunch)
            }

            Section("Where things are") {
                PathRow(title: "ProdDash folder",
                        value: server.rootURL?.path ?? "Not found — choose it",
                        missing: server.rootURL == nil) {
                    chooseFolder()
                }
                PathRow(title: "Node.js",
                        value: server.nodeURL.map { "\($0.path)  \(server.nodeVersion)" } ?? "Not found",
                        missing: server.nodeURL == nil, action: nil)
                PathRow(title: "Settings", value: server.settingsDir.isEmpty
                        ? server.dataDir.path : server.settingsDir, missing: false, action: nil)
            }
        }
        .formStyle(.grouped)
        .onAppear { portText = String(server.port) }
        .onChange(of: server.port) { newValue in portText = String(newValue) }
    }

    private func applyPort() {
        guard let port = Int(portText) else {
            portText = String(server.port)
            return
        }
        server.applyPort(port)
        portText = String(server.port)
    }

    private func setLoginItem(_ on: Bool) {
        if let error = LoginItem.set(on) {
            LogStore.shared.launcher("couldn't change the login item: \(error)")
        }
        loginItemOn = LoginItem.isEnabled
        loginNeedsApproval = LoginItem.needsApproval
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.message = "Choose the ProdDash folder — the one with server.js in it."
        panel.prompt = "Choose"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard ProdDash.isRoot(url) else {
            let alert = NSAlert()
            alert.messageText = "That isn't a ProdDash folder"
            alert.informativeText = "Pick the folder that contains server.js and public/."
            alert.runModal()
            return
        }
        settings.rootPath = url.path
        server.refreshEnvironment()
    }

}

private struct PathRow: View {
    let title: String
    let value: String
    let missing: Bool
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(value)
                    .font(.caption)
                    .foregroundStyle(missing ? Color.orange : Color.secondary)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            Spacer()
            if let action {
                Button("Choose…", action: action).controlSize(.small)
            }
        }
    }
}
