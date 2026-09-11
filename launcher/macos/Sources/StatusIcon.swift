import AppKit

/**
 The menu-bar glyph: ProdDash's own icon — a 2×2 grid of tiles — with the
 accent tile carrying the state, exactly as the app icon does. Filled and
 green while it serves; hollow and dim when stopped; amber mid-move; red when
 something needs a person.

 Drawn rather than templated because a template image can only be one colour.
 The outline uses `labelColor`, so it follows a light or dark menu bar; the
 status item redraws it when the appearance changes.
 */
enum StatusIcon {

    static let accent = NSColor(srgbRed: 0.18, green: 0.90, blue: 0.60, alpha: 1)   // #2ee59a, the shell's --accent
    static let warn   = NSColor(srgbRed: 0.94, green: 0.71, blue: 0.16, alpha: 1)   // #f0b429
    static let danger = NSColor(srgbRed: 0.96, green: 0.26, blue: 0.24, alpha: 1)   // #f4433c

    static func color(for state: ServerState, healthy: Bool) -> NSColor {
        switch state {
        case .running:  return healthy ? accent : warn
        case .starting, .stopping: return warn
        case .failed:   return danger
        case .stopped:  return NSColor.secondaryLabelColor
        }
    }

    static func image(for state: ServerState, healthy: Bool) -> NSImage {
        let side: CGFloat = 18
        let fill: NSColor? = {
            switch state {
            case .stopped: return nil            // nothing lit: plainly off
            default: return color(for: state, healthy: healthy)
            }
        }()

        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { _ in
            let inset: CGFloat = 1.5
            let gap: CGFloat = 1.6
            let tile = (side - inset * 2 - gap) / 2
            let outline = NSColor.labelColor.withAlphaComponent(state == .stopped ? 0.55 : 0.9)

            for row in 0..<2 {
                for column in 0..<2 {
                    let rect = NSRect(x: inset + CGFloat(column) * (tile + gap),
                                      y: inset + CGFloat(row) * (tile + gap),
                                      width: tile, height: tile)
                    // Bottom-right is the accent tile, as on the app icon.
                    let isAccent = (row == 0 && column == 1)
                    let path = NSBezierPath(roundedRect: rect.insetBy(dx: 0.6, dy: 0.6), xRadius: 2, yRadius: 2)
                    if isAccent, let fill {
                        fill.setFill()
                        path.fill()
                    } else {
                        outline.setStroke()
                        path.lineWidth = 1.3
                        path.stroke()
                    }
                }
            }
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "ProdDash — \(state.label)"
        return image
    }
}
