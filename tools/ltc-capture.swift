// ltc-capture — minimal CoreAudio input capture for the LTC reader.
//
// ProdDash's LTC reader (tools/ltc-reader.js) eats raw PCM on stdin and is
// normally fed by ffmpeg or sox — but production machines rarely have
// either, and shipping a third-party binary just to move samples from an
// input device to a pipe is overkill. This is the whole job, natively:
//
//   swiftc -O -o tools/ltc-capture tools/ltc-capture.swift    (once, ~5 s)
//
//   tools/ltc-capture --list
//       every input-capable device: name, input channels, sample rate
//   tools/ltc-capture --device "Dante Via 16" \
//       | node tools/ltc-reader.js --sr 48000 --channels 16 --ch 5 ...
//       streams the device's inputs as interleaved s16le to stdout, at the
//       device's own sample rate and channel count (both printed to stderr
//       at start — pass them to the reader as --sr / --channels).
//
// --device matches case-insensitively on a substring of the device name or
// UID; ambiguity is an error listing the candidates. Capture uses an
// AVAudioEngine input tap pinned to the chosen device, converting Float32
// to clamped Int16 little-endian. stdout is samples only; every message
// goes to stderr.
//
// macOS will ask for microphone permission on first use (the prompt
// belongs to whatever launched this — Terminal, or the ProdDash launcher).
// Over SSH there is no prompt to answer: grant it once at the console, or
// approve the terminal app under System Settings → Privacy → Microphone.

import AVFoundation
import CoreAudio
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("ltc-capture: " + msg + "\n").data(using: .utf8)!)
    exit(2)
}

func note(_ msg: String) {
    FileHandle.standardError.write(("ltc-capture: " + msg + "\n").data(using: .utf8)!)
}

/* ── CoreAudio device enumeration ───────────────────────────────────── */

struct InputDevice {
    let id: AudioDeviceID
    let name: String
    let uid: String
    let channels: Int
    let sampleRate: Double
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var ref: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let err = withUnsafeMutablePointer(to: &ref) {
        AudioObjectGetPropertyData(id, &addr, 0, nil, &size, $0)
    }
    guard err == noErr, let value = ref?.takeRetainedValue() else { return "" }
    return value as String
}

func sampleRateProperty(_ id: AudioObjectID) -> Double {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyNominalSampleRate,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var rate: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &rate) == noErr else { return 0 }
    return rate
}

func inputChannelCount(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let listPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { listPtr.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, listPtr) == noErr else { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(listPtr.assumingMemoryBound(to: AudioBufferList.self))
    return buffers.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func listInputDevices() -> [InputDevice] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr
    else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr
    else { return [] }

    var out: [InputDevice] = []
    for id in ids {
        let channels = inputChannelCount(id)
        if channels == 0 { continue }
        out.append(InputDevice(id: id,
                               name: stringProperty(id, kAudioObjectPropertyName),
                               uid: stringProperty(id, kAudioDevicePropertyDeviceUID),
                               channels: channels,
                               sampleRate: sampleRateProperty(id)))
    }
    return out
}

/* ── args ───────────────────────────────────────────────────────────── */

var wantList = false
var wantDevice: String? = nil
var argIdx = 1
let argv = CommandLine.arguments
while argIdx < argv.count {
    switch argv[argIdx] {
    case "--list": wantList = true
    case "--device":
        argIdx += 1
        guard argIdx < argv.count else { fail("--device needs a name (see --list)") }
        wantDevice = argv[argIdx]
    default: fail("unknown flag \(argv[argIdx]) — use --list or --device <name>")
    }
    argIdx += 1
}

let devices = listInputDevices()

if wantList || wantDevice == nil {
    if devices.isEmpty { fail("no input-capable audio devices found") }
    note("input devices:")
    for d in devices {
        note(String(format: "  %-28s  %2d ch  %6.0f Hz  uid=%@", (d.name as NSString).utf8String!,
                    d.channels, d.sampleRate, d.uid))
    }
    if wantDevice == nil && !wantList { note("pick one with --device <name substring>") }
    exit(wantList ? 0 : 2)
}

let query = wantDevice!.lowercased()
let matches = devices.filter { $0.name.lowercased().contains(query) || $0.uid.lowercased().contains(query) }
guard matches.count == 1 else {
    if matches.isEmpty { fail("no input device matches \"\(wantDevice!)\" — see --list") }
    fail("\"\(wantDevice!)\" is ambiguous: " + matches.map { $0.name }.joined(separator: ", "))
}
let device = matches[0]

/* ── capture: pin the engine's input to the device, tap, s16le out ──── */

let engine = AVAudioEngine()
guard let unit = engine.inputNode.audioUnit else { fail("no input audio unit") }
var deviceID = device.id
let setErr = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                  kAudioUnitScope_Global, 0, &deviceID,
                                  UInt32(MemoryLayout<AudioDeviceID>.size))
guard setErr == noErr else { fail("cannot select \"\(device.name)\" (error \(setErr))") }

let format = engine.inputNode.inputFormat(forBus: 0)
let channels = Int(format.channelCount)
let rate = Int(format.sampleRate)
guard channels > 0, rate > 0 else {
    fail("\"\(device.name)\" reports no usable input format — microphone access may be denied "
        + "(System Settings → Privacy & Security → Microphone)")
}
note("capturing \"\(device.name)\": \(channels) channels @ \(rate) Hz → s16le stdout")
note("reader flags: --sr \(rate) --channels \(channels) --ch <the LTC channel, 1-based>")

let stdoutHandle = FileHandle.standardOutput
engine.inputNode.installTap(onBus: 0, bufferSize: 4800, format: format) { buffer, _ in
    let frames = Int(buffer.frameLength)
    guard frames > 0, let floats = buffer.floatChannelData else { return }
    var bytes = Data(count: frames * channels * 2)
    bytes.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
        let out = raw.bindMemory(to: Int16.self)
        for f in 0..<frames {
            for c in 0..<channels {
                let v = floats[c][f]
                let clamped = max(-1.0, min(1.0, v))
                out[f * channels + c] = Int16(clamped * 32767.0) // arm64 is little-endian
            }
        }
    }
    do { try stdoutHandle.write(contentsOf: bytes) } catch { exit(0) } // downstream pipe closed
}

do { try engine.start() } catch {
    fail("engine start failed: \(error.localizedDescription) — if this is a permission problem, "
        + "approve microphone access for the launching app and retry")
}

signal(SIGINT) { _ in exit(0) }
signal(SIGTERM) { _ in exit(0) }
RunLoop.main.run()
