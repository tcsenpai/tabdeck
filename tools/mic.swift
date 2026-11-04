// Microphone "click" helper for the TabDeck mic corners.
//
// Listens to the Mac's default microphone with an AVAudioEngine input tap and reduces the sound to
// two numbers per frame. The audio itself is analysed in memory and thrown away: it is never
// written to disk, never printed and never leaves this process. One JSON line per frame on stdout:
//   [0.412,0.900]   [level, onset], both in 0...1, 3 decimals
//     level: RMS of the room in dBFS mapped -60...-15 dB to 0...1, lightly smoothed
//     onset: strength of a sharp transient (a key click): the energy of the signal above ~2 kHz
//            against its slow running average, positive jumps only, ~40 ms refractory, and an
//            absolute noise floor so room hum and fan noise give 0
// stderr carries one-line diagnostics the server maps to a status: "ready", or "error: <reason>"
// (then exit code 2). Nothing is printed for a quiet room: silence is normal here.
//
// Build: swiftc -O tools/mic.swift -o mic -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker mic.plist
// (the embedded Info.plist carries NSMicrophoneUsageDescription; without it macOS kills a
// command-line process the moment it touches the microphone.)
// Usage: mic [--fps F] [--test-script]
//   --test-script prints a canned sequence (silence, a burst of clicks, a fade) and never touches
//   AVFoundation, so it can run anywhere without a permission prompt.
import AVFoundation
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

var lineBuffer: [UInt8] = []

func appendFixed3(_ v: Float, to out: inout [UInt8]) {
    let n = Int((min(max(v, 0), 1) * 1000).rounded())
    out.append(UInt8(0x30 + n / 1000))
    out.append(0x2E)
    out.append(UInt8(0x30 + n / 100 % 10))
    out.append(UInt8(0x30 + n / 10 % 10))
    out.append(UInt8(0x30 + n % 10))
}

func emit(level: Float, onset: Float) {
    lineBuffer.removeAll(keepingCapacity: true)
    lineBuffer.append(0x5B) // [
    appendFixed3(level, to: &lineBuffer)
    lineBuffer.append(0x2C) // ,
    appendFixed3(onset, to: &lineBuffer)
    lineBuffer.append(0x5D) // ]
    lineBuffer.append(0x0A)
    // Raw write(2): nothing buffered, so "flushed each line" holds. A closed pipe ends us.
    let ok = lineBuffer.withUnsafeBufferPointer { buf -> Bool in
        var off = 0
        while off < buf.count {
            let n = write(1, buf.baseAddress! + off, buf.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            off += n
        }
        return true
    }
    if !ok { exit(0) }
}

// MARK: - Arguments

struct Options {
    var fps = 30
    var testScript = false
}

func parseArgs() -> Options {
    var o = Options()
    var args = CommandLine.arguments.dropFirst()
    while let a = args.popFirst() {
        switch a {
        case "--fps":
            guard let raw = args.popFirst(), let n = Int(raw) else { die("--fps needs a number") }
            o.fps = min(max(n, 5), 30)
        case "--test-script": o.testScript = true
        default: die("unknown argument \(a)")
        }
    }
    return o
}

// MARK: - Analysis

let levelFloorDB: Float = -60
let levelCeilDB: Float = -15
let hpCutoff = 2000.0 // Hz: key clicks live above the rumble of rooms and voices
let blockSeconds = 0.004 // onset analysis granularity
let averageSeconds = 0.3 // time constant of the slow running average
let refractorySeconds = 0.04
let warmupSeconds = 0.5 // the average settles before onsets may fire
let noiseFloorAmp: Float = 0.0025 // ~ -52 dBFS of high-passed signal: below this nothing counts
let minJumpDB: Float = 6 // jump over the average that starts to count ...
let fullJumpDB: Float = 18 // ... and the jump that counts fully
let quietDB: Float = -50 // loudness (of the high-passed block) that is weighted half ...
let loudDB: Float = -30 // ... and the one weighted fully

func dB(_ amp: Float) -> Float { 20 * log10f(max(amp, 1e-6)) }

// Fed by the engine's tap thread, drained by the frame timer. The tap may deliver any block size
// (macOS often ignores the requested 1024 frames), so the signal is cut into fixed ~4 ms blocks here.
final class Detector {
    private let lock = NSLock()
    private let sampleRate: Double
    private let blockSize: Int
    // Direct form I biquad: 2nd-order Butterworth high-pass.
    private let b0: Double, b1: Double, b2: Double, a1: Double, a2: Double
    private var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0
    // Current block.
    private var hpSum = 0.0, fullSum = 0.0, inBlock = 0
    // Onset state.
    private var average: Float = 0
    private var previous: Float = 0
    private var blocksSeen = 0
    private let warmupBlocks: Int
    private let averageAlpha: Float
    private var clock = 0 // samples since start
    private var refractoryUntil = 0
    private var committed: Float = 0
    // Results since the last take().
    private var pendingOnset: Float = 0
    private var periodSum = 0.0, periodCount = 0

    init(sampleRate: Double) {
        self.sampleRate = sampleRate
        blockSize = max(Int(sampleRate * blockSeconds), 16)
        warmupBlocks = Int(warmupSeconds / blockSeconds)
        averageAlpha = Float(1 - exp(-blockSeconds / averageSeconds))
        let w0 = 2 * Double.pi * hpCutoff / sampleRate
        let alpha = sin(w0) / (2 * 0.70710678)
        let c = cos(w0)
        let a0 = 1 + alpha
        b0 = (1 + c) / 2 / a0
        b1 = -(1 + c) / a0
        b2 = b0
        a1 = -2 * c / a0
        a2 = (1 - alpha) / a0
    }

    func process(_ samples: UnsafePointer<Float>, count: Int) {
        lock.lock()
        defer { lock.unlock() }
        for i in 0..<count {
            let x = Double(samples[i])
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x
            y2 = y1; y1 = y
            hpSum += y * y
            fullSum += x * x
            inBlock += 1
            if inBlock == blockSize { finishBlock() }
        }
    }

    private func finishBlock() {
        let e = Float(sqrt(hpSum / Double(blockSize)))
        periodSum += fullSum
        periodCount += blockSize
        hpSum = 0
        fullSum = 0
        inBlock = 0
        clock += blockSize
        blocksSeen += 1
        defer { previous = e }
        if blocksSeen == 1 { average = e; return }
        if blocksSeen > warmupBlocks && e > noiseFloorAmp && e > previous {
            // Measured against the average, but never against less than the noise floor.
            let jump = dB(e) - dB(max(average, noiseFloorAmp))
            let jumpFactor = min(max((jump - minJumpDB) / (fullJumpDB - minJumpDB), 0), 1)
            let loudFactor = min(max((dB(e) - quietDB) / (loudDB - quietDB), 0), 1)
            let strength = jumpFactor * (0.5 + 0.5 * loudFactor)
            if strength > 0 {
                if clock >= refractoryUntil {
                    refractoryUntil = clock + Int(sampleRate * refractorySeconds)
                    committed = strength
                    pendingOnset = max(pendingOnset, strength)
                } else if strength > committed {
                    // Still inside the same click: only its rising peak is reported.
                    committed = strength
                    pendingOnset = max(pendingOnset, strength)
                }
            }
        }
        average += averageAlpha * (e - average)
    }

    // RMS of everything heard since the last call (nil: nothing arrived) and the strongest onset.
    func take() -> (rms: Float?, onset: Float) {
        lock.lock()
        defer { lock.unlock() }
        let rms: Float? = periodCount > 0 ? Float(sqrt(periodSum / Double(periodCount))) : nil
        let onset = pendingOnset
        pendingOnset = 0
        periodSum = 0
        periodCount = 0
        return (rms, onset)
    }
}

// Maps a block RMS to 0...1 and smooths it: fast attack, slower decay.
struct LevelSmoother {
    var value: Float = 0
    mutating func apply(rms: Float?) -> Float {
        var target: Float = 0
        if let rms = rms { target = min(max((dB(rms) - levelFloorDB) / (levelCeilDB - levelFloorDB), 0), 1) }
        value += (target - value) * (target > value ? 0.6 : 0.2)
        return value
    }
}

// MARK: - Capture

final class MicCapture {
    private let engine = AVAudioEngine()
    private(set) var detector: Detector?

    func start() {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate >= 8000, format.channelCount > 0 else { die("no microphone input available") }
        let detector = Detector(sampleRate: format.sampleRate)
        self.detector = detector
        // The tap callback only feeds the in-memory analysis; the buffer is dropped when it returns.
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let channels = buffer.floatChannelData else { return }
            detector.process(channels[0], count: Int(buffer.frameLength))
        }
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { _ in
            // The input device changed (headset plugged in, ...): exit so the server starts a fresh helper.
            say("audio configuration changed")
            exit(1)
        }
        engine.prepare()
        do { try engine.start() } catch { die("could not start the audio engine: \(error.localizedDescription)") }
    }

    func stop() {
        guard detector != nil else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

// MARK: - Test script

// (level, onset) per tick: silence, a burst of clicks 3-4 ticks apart (~100-133 ms at 30 fps), a fade.
func testScript() -> [(Float, Float)] {
    var frames: [(Float, Float)] = []
    frames += [(Float, Float)](repeating: (0, 0), count: 30)
    for gap in [4, 3, 4, 3, 4, 4, 3, 4] {
        frames.append((0.62, 0.9))
        for i in 1..<gap { frames.append((i == 1 ? 0.35 : 0.2, 0)) }
    }
    for i in 0..<20 { frames.append((0.6 * Float(19 - i) / 19, 0)) }
    return frames
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)
let options = parseArgs()
let capture = MicCapture()
var shuttingDown = false

func shutdown() -> Never {
    if !shuttingDown {
        shuttingDown = true
        capture.stop()
    }
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

let interval = 1.0 / Double(options.fps)
let timer = DispatchSource.makeTimerSource(queue: .main)
timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(2))

func startCapture() {
    capture.start()
    guard let detector = capture.detector else { die("no microphone input available") }
    var smoother = LevelSmoother()
    timer.setEventHandler {
        let heard = detector.take()
        emit(level: smoother.apply(rms: heard.rms), onset: heard.onset)
    }
    timer.resume()
    say("ready")
}

if options.testScript {
    let script = testScript()
    var tick = 0
    timer.setEventHandler {
        let (level, onset) = script[tick % script.count]
        tick += 1
        emit(level: level, onset: onset)
    }
    timer.resume()
    say("ready")
} else {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized:
        startCapture()
    case .notDetermined:
        // Prompts once; the server shows "starting" until the user answers.
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DispatchQueue.main.async {
                if granted { startCapture() } else { die("microphone access denied") }
            }
        }
    case .denied:
        die("microphone access denied")
    case .restricted:
        die("microphone access restricted by a profile or parental controls")
    @unknown default:
        die("microphone access unavailable")
    }
}
dispatchMain()
