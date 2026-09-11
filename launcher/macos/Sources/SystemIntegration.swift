import AppKit
import Foundation
import ServiceManagement
import UserNotifications

/// Notifications about the server, for a booth machine nobody is watching.
/// Quiet by design: only a stop nobody asked for is worth interrupting anyone.
final class Notifier {

    static let shared = Notifier()

    private var authorized = false
    private var asked = false

    private var available: Bool { Bundle.main.bundleIdentifier != nil }

    private init() {}

    /// Ask once, when the operator turns the setting on.
    func requestAuthorization(_ completion: ((Bool) -> Void)? = nil) {
        guard available else { return completion?(false) ?? () }
        asked = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async {
                self.authorized = granted
                completion?(granted)
            }
        }
    }

    func refreshStatus(_ completion: @escaping (UNAuthorizationStatus) -> Void) {
        guard available else { return completion(.denied) }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.authorized = settings.authorizationStatus == .authorized
                completion(settings.authorizationStatus)
            }
        }
    }

    /// Posting never asks for permission: a prompt that appears because
    /// something just failed, unattended, is the worst possible moment for it.
    /// Authorization is asked for on first run and when the setting is turned
    /// on; until then this quietly does nothing.
    func post(title: String, body: String, if enabled: Bool) {
        guard enabled, available, authorized else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}

/// "Open ProdDash at login", through the modern (macOS 13+) login-item API.
/// The operator may still have to approve it in System Settings — hence
/// `needsApproval`, which the window surfaces rather than silently failing.
enum LoginItem {

    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    @discardableResult
    static func set(_ enabled: Bool) -> String? {
        do {
            if enabled {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else {
                if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

enum SystemSettings {
    /// Deep links into the Privacy & Security panes. Opening the app itself is
    /// the fallback when a pane identifier stops working on a later macOS.
    static func open(_ pane: String) {
        guard let url = URL(string: pane) else { return }
        if !NSWorkspace.shared.open(url) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
        }
    }

    static let microphone = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    static let localNetwork = "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork"
    static let notifications = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
}
