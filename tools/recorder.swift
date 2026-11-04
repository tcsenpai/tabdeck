// Input recorder helper for the TabDeck macro recorder.
//
// Listens (never alters or swallows anything) to the Mac's keyboard and mouse through a listen-only
// CGEventTap and prints one JSON object per line on stdout:
//   {"t":812,"e":"key","code":8,"mods":["cmd"],"ch":"c"}
//   {"t":1440,"e":"click","button":"left","count":2,"x":512,"y":300}
// `t` is milliseconds since the tap went live. `mods` lists cmd, ctrl, opt, shift (in that order).
// `ch` is the typed character; while cmd/ctrl/opt is held it is the key's plain character on the
// ASCII-capable layout instead (a shortcut is named after the key, not after what it produces, so
// cmd+shift+4 reports "4"). A modifier pressed and released on its own is one key event with an
// empty `ch` and the modifier's key code. Coordinates are points in the global top-left space,
// the same space the pad's click step posts in.
//
// stderr carries one-word diagnostics the server maps to a status: "ready" once the tap is live,
// "error: <reason>" (then exit code 2). Needs the macOS "Input Monitoring" permission.
//
// Build: swiftc -O tools/recorder.swift -o recorder
// Usage: recorder [--test-script]
//   --test-script prints a canned sequence (cmd+c, "hello", a double click, a pause, Return) and
//   touches no tap, so nothing is captured and no permission is needed.
import Carbon.HIToolbox
import CoreGraphics
import Darwin
import Dispatch
import Foundation

// MARK: - Output

func say(_ line: String) {
    fputs(line + "\n", stderr)
}

func die(_ reason: String) -> Never {
    say("error: \(reason)")
    exit(2)
}

func jsonString(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if u.value < 0x20 || u.value == 0x7f { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
        }
    }
    return out + "\""
}

func emit(_ line: String) {
    fputs(line + "\n", stdout)
}

func emitKey(t: Int, code: Int, mods: [String], ch: String) {
    emit("{\"t\":\(t),\"e\":\"key\",\"code\":\(code),\"mods\":[\(mods.map(jsonString).joined(separator: ","))],\"ch\":\(jsonString(ch))}")
}

func emitClick(t: Int, button: String, count: Int, x: Int, y: Int) {
    emit("{\"t\":\(t),\"e\":\"click\",\"button\":\"\(button)\",\"count\":\(count),\"x\":\(x),\"y\":\(y)}")
}

// MARK: - Key translation

let modMasks: [(String, CGEventFlags)] = [
    ("cmd", .maskCommand), ("ctrl", .maskControl), ("opt", .maskAlternate), ("shift", .maskShift),
]
let modifierFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate, .maskShift]
let shortcutFlags: CGEventFlags = [.maskCommand, .maskControl, .maskAlternate]

func modNames(_ flags: CGEventFlags) -> [String] {
    modMasks.filter { flags.contains($0.1) }.map { $0.0 }
}

// The key's plain character (no modifiers, no dead keys) on the ASCII-capable layout, which is the
// layout keyboard shortcuts are defined on. Must run on the main thread (the Text Input Sources API requires it).
func baseCharacter(keyCode: UInt16, keyboardType: UInt32) -> String {
    guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
          let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return "" }
    let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    guard let bytes = CFDataGetBytePtr(data) else { return "" }
    let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
    var dead: UInt32 = 0
    var length = 0
    var chars = [UniChar](repeating: 0, count: 4)
    let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), 0, keyboardType,
                                OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
    if status != noErr || length == 0 { return "" }
    return String(utf16CodeUnits: chars, count: length)
}

// The character a key press types, as delivered with the event (empty for a dead key press).
func typedCharacters(_ event: CGEvent) -> String {
    var chars = [UniChar](repeating: 0, count: 8)
    var length = 0
    event.keyboardGetUnicodeString(maxStringLength: chars.count, actualStringLength: &length, unicodeString: &chars)
    return length > 0 ? String(utf16CodeUnits: chars, count: length) : ""
}

// MARK: - Recording state (main thread only)

let startNs = DispatchTime.now().uptimeNanoseconds
func elapsedMs() -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - startNs) / 1_000_000)
}

// A modifier pressed and released with nothing in between is a key press of its own ("opt" alone,
// a double tap of "cmd" ...). `used` goes true as soon as any key or click happens meanwhile.
var modActive = false
var modUsed = false
var modPeak: CGEventFlags = []
var modLastCode = 0

func handleFlags(_ event: CGEvent) {
    let cur = event.flags.intersection(modifierFlags)
    if cur.isEmpty {
        if modActive && !modUsed { emitKey(t: elapsedMs(), code: modLastCode, mods: modNames(modPeak), ch: "") }
        modActive = false
        return
    }
    if !modActive {
        modActive = true
        modUsed = false
        modPeak = []
    }
    modPeak.formUnion(cur)
    modLastCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
}

func handleKey(_ event: CGEvent) {
    modUsed = true
    let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let flags = event.flags
    let ch: String
    if flags.isDisjoint(with: shortcutFlags) {
        ch = typedCharacters(event)
    } else {
        let type = UInt32(event.getIntegerValueField(.keyboardEventKeyboardType))
        ch = baseCharacter(keyCode: UInt16(code), keyboardType: type)
    }
    emitKey(t: elapsedMs(), code: code, mods: modNames(flags), ch: ch)
}

func handleClick(_ event: CGEvent, button: String) {
    modUsed = true
    let p = event.location
    let count = Int(event.getIntegerValueField(.mouseEventClickState))
    emitClick(t: elapsedMs(), button: button, count: max(1, count), x: Int(p.x.rounded()), y: Int(p.y.rounded()))
}

// MARK: - Event tap

var tapPort: CFMachPort?

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    switch type {
    case .keyDown: handleKey(event)
    case .flagsChanged: handleFlags(event)
    case .leftMouseDown: handleClick(event, button: "left")
    case .rightMouseDown: handleClick(event, button: "right")
    case .otherMouseDown: handleClick(event, button: "middle")
    case .tapDisabledByTimeout, .tapDisabledByUserInput:
        // The system switches a slow tap off; turn it back on rather than record nothing.
        if let port = tapPort { CGEvent.tapEnable(tap: port, enable: true) }
    default: break
    }
    return Unmanaged.passUnretained(event)
}

func startTap() {
    let types: [CGEventType] = [.keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                       eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
        die("Input Monitoring permission is not granted")
    }
    tapPort = port
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
}

// MARK: - Test script

// Scripted timestamps are printed as they are (so the output never depends on how loaded the machine
// is); the real sleeps between lines only make the stream arrive over time like a real recording.
enum Scripted {
    case key(Int, Int, [String], String) // t, code, mods, ch
    case click(Int, String, Int, Int, Int) // t, button, count, x, y
}

let testScript: [Scripted] = [
    .key(0, 8, ["cmd"], "c"),
    .key(300, 4, [], "h"), .key(360, 14, [], "e"), .key(420, 37, [], "l"), .key(480, 37, [], "l"), .key(540, 31, [], "o"),
    .click(700, "left", 1, 400, 300), .click(780, "left", 2, 400, 300),
    .key(1500, 36, [], "\r"),
]

func runTestScript() {
    DispatchQueue.global().async {
        for item in testScript {
            usleep(10_000)
            switch item {
            case let .key(t, code, mods, ch): emitKey(t: t, code: code, mods: mods, ch: ch)
            case let .click(t, button, count, x, y): emitClick(t: t, button: button, count: count, x: x, y: y)
            }
        }
    }
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)
setvbuf(stdout, nil, _IOLBF, 0)

let args = CommandLine.arguments.dropFirst()
let testMode = args.contains("--test-script")
for a in args where a != "--test-script" { die("unknown argument \(a)") }

func shutdown() -> Never {
    if let port = tapPort { CGEvent.tapEnable(tap: port, enable: false) }
    exit(0)
}

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
termSource.setEventHandler { shutdown() }
intSource.setEventHandler { shutdown() }
termSource.resume()
intSource.resume()

// The server keeps our stdin open; EOF means it is gone and so should we.
Thread.detachNewThread {
    var byte: UInt8 = 0
    while true {
        let n = read(0, &byte, 1)
        if n == 0 || (n < 0 && errno != EINTR) { break }
    }
    DispatchQueue.main.async { shutdown() }
}

if testMode {
    say("ready")
    runTestScript()
} else {
    startTap()
    say("ready")
}
// Both modes stay alive until SIGTERM or stdin EOF, like the real tap does. The main run loop
// serves the tap's source and the main dispatch queue (signal handlers, shutdown).
CFRunLoopRun()
