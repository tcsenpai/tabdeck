// System audio spectrum helper for the TabDeck visualizer tile.
//
// Captures the Mac's whole output mix with a Core Audio process tap (macOS 14.4+, no virtual driver,
// no ScreenCaptureKit), runs a 1024-point FFT and prints one JSON line per frame on stdout:
//   [0.12,0.5,...]   N band levels in 0...1
// stderr carries one-word diagnostics the server maps to a status: "ready", "silent", "audio",
// "error: <reason>" (then exit code 2).
//
// Build: swiftc -O tools/sysaudio.swift -o sysaudio
// Usage: sysaudio [--bands N] [--fps F] [--test-tone]
import Accelerate
import CoreAudio
import Darwin
import Dispatch
import Foundation
import os

// MARK: - Output

func say(_ line: String) {
    fputs(line + "\n", stderr)
}

func die(_ reason: String) -> Never {
    say("error: \(reason)")
    exit(2)
}

// A value in 0...1 as the shortest JSON number with at most 2 decimals ("0", "0.5", "0.12", "1").
func appendNumber(_ v: Float, to out: inout [UInt8]) {
    let n = Int((min(max(v, 0), 1) * 100).rounded())
    if n >= 100 { out.append(0x31); return } // "1"
    if n == 0 { out.append(0x30); return } // "0"
    out.append(0x30)
    out.append(0x2E)
    out.append(UInt8(0x30 + n / 10))
    if n % 10 != 0 { out.append(UInt8(0x30 + n % 10)) }
}

var lineBuffer: [UInt8] = []

func emit(_ bands: [Float]) {
    lineBuffer.removeAll(keepingCapacity: true)
    lineBuffer.append(0x5B) // [
    for (i, v) in bands.enumerated() {
        if i > 0 { lineBuffer.append(0x2C) }
        appendNumber(v, to: &lineBuffer)
    }
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
    var bands = 32
    var fps = 20
    var testTone = false
}

func parseArgs() -> Options {
    var o = Options()
    var args = CommandLine.arguments.dropFirst()
    func number(_ flag: String) -> Int {
        guard let raw = args.popFirst(), let n = Int(raw) else { die("\(flag) needs a number") }
        return n
    }
    while let a = args.popFirst() {
        switch a {
        case "--bands": o.bands = min(max(number(a), 8), 64)
        case "--fps": o.fps = min(max(number(a), 5), 30)
        case "--test-tone": o.testTone = true
        default: die("unknown argument \(a)")
        }
    }
    return o
}

// MARK: - Analysis

let fftSize = 1024
let fftLog2: vDSP_Length = 10
let loFreq: Float = 40
let hiFreq: Float = 16000
let floorDB: Float = -80
let ceilDB: Float = -10

// Smooths band levels: fast attack, slower decay.
struct Smoother {
    var prev: [Float]
    init(bands: Int) { prev = [Float](repeating: 0, count: bands) }
    mutating func apply(_ raw: [Float]) -> [Float] {
        for i in 0..<prev.count {
            let d = raw[i] - prev[i]
            prev[i] += d * (d > 0 ? 0.7 : 0.22)
        }
        return prev
    }
}

// Band edges in FFT bin units (fractional), log-spaced between loFreq and hiFreq.
func bandEdges(bands: Int, sampleRate: Float) -> [Float] {
    let binHz = sampleRate / Float(fftSize)
    let top = min(hiFreq, sampleRate / 2 - binHz)
    let ratio = powf(top / loFreq, 1 / Float(bands))
    return (0...bands).map { loFreq * powf(ratio, Float($0)) / binHz }
}

final class Analyzer {
    let bands: Int
    let edges: [Float]
    var smoother: Smoother
    private let setup: FFTSetup
    private var window = [Float](repeating: 0, count: fftSize)
    private var samples = [Float](repeating: 0, count: fftSize)
    private var real = [Float](repeating: 0, count: fftSize / 2)
    private var imag = [Float](repeating: 0, count: fftSize / 2)
    private var power = [Float](repeating: 0, count: fftSize / 2)
    private var db = [Float](repeating: floorDB, count: fftSize / 2)

    init(bands: Int, sampleRate: Float) {
        self.bands = bands
        edges = bandEdges(bands: bands, sampleRate: sampleRate)
        smoother = Smoother(bands: bands)
        guard let s = vDSP_create_fftsetup(fftLog2, FFTRadix(kFFTRadix2)) else { die("FFT setup failed") }
        setup = s
        for i in 0..<fftSize { window[i] = 0.5 - 0.5 * cosf(2 * .pi * Float(i) / Float(fftSize)) }
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    // `input` holds fftSize mono samples; returns raw band levels in 0...1 (unsmoothed).
    func levels(_ input: UnsafePointer<Float>) -> [Float] {
        vDSP_vmul(input, 1, window, 1, &samples, 1, vDSP_Length(fftSize))
        let half = fftSize / 2
        real.withUnsafeMutableBufferPointer { rp in
            imag.withUnsafeMutableBufferPointer { ip in
                var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
                samples.withUnsafeBufferPointer { sp in
                    sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) {
                        vDSP_ctoz($0, 2, &split, 1, vDSP_Length(half))
                    }
                }
                vDSP_fft_zrip(setup, &split, 1, fftLog2, FFTDirection(FFT_FORWARD))
                vDSP_zvmags(&split, 1, &power, 1, vDSP_Length(half))
            }
        }
        // A full-scale sine under a Hann window peaks at |X| = A*N/4, doubled by zrip's scaling to N/2:
        // power / (N/2)^2 is then dB relative to full scale.
        let norm = 4 / Float(fftSize * fftSize)
        for i in 0..<half { db[i] = 10 * log10f(power[i] * norm + 1e-12) }

        var out = [Float](repeating: 0, count: bands)
        for b in 0..<bands {
            let lo = edges[b], hi = edges[b + 1]
            var level: Float
            if hi - lo < 1 {
                // Narrower than one bin: interpolate at the band centre instead of repeating one bin.
                let c = (lo + hi) / 2
                let i0 = min(max(Int(c), 1), half - 2)
                let f = min(max(c - Float(i0), 0), 1)
                level = db[i0] * (1 - f) + db[i0 + 1] * f
            } else {
                let i0 = max(Int(lo.rounded(.down)), 1)
                let i1 = min(max(Int(hi.rounded(.up)) - 1, i0), half - 1)
                level = db[i0]
                if i1 > i0 { for i in (i0 + 1)...i1 { level = max(level, db[i]) } }
            }
            out[b] = min(max((level - floorDB) / (ceilDB - floorDB), 0), 1)
        }
        return out
    }
}

// MARK: - Ring buffer (written by the IOProc, read by the timer)

// A tiny lock guards the ring. The audio thread only try-locks (it drops a buffer rather than wait).
final class Ring {
    static let size = 8192 // power of two, > fftSize
    let data = UnsafeMutablePointer<Float>.allocate(capacity: Ring.size)
    let lock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    var written = 0 // total frames ever written
    var peak: Float = 0 // largest |sample| since the last snapshot

    init() {
        data.initialize(repeating: 0, count: Ring.size)
        lock.initialize(to: os_unfair_lock())
    }

    deinit {
        data.deallocate()
        lock.deallocate()
    }

    // Audio thread: mixes every buffer/channel down to mono and appends.
    func push(_ list: UnsafePointer<AudioBufferList>) {
        guard os_unfair_lock_trylock(lock) else { return }
        defer { os_unfair_lock_unlock(lock) }
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
        var frames = Int.max
        for b in buffers where b.mData != nil {
            frames = min(frames, Int(b.mDataByteSize) / (MemoryLayout<Float>.size * max(Int(b.mNumberChannels), 1)))
        }
        if frames == Int.max || frames == 0 { return }
        frames = min(frames, Ring.size)
        let mask = Ring.size - 1
        let gain = 1 / Float(buffers.count)
        var p: Float = 0
        for i in 0..<frames {
            var sum: Float = 0
            for b in buffers {
                guard let raw = b.mData else { continue }
                let ch = max(Int(b.mNumberChannels), 1)
                let s = raw.assumingMemoryBound(to: Float.self)
                var acc: Float = 0
                for c in 0..<ch { acc += s[i * ch + c] }
                sum += acc / Float(ch)
            }
            let v = sum * gain
            data[(written + i) & mask] = v
            p = max(p, abs(v))
        }
        written += frames
        peak = max(peak, p)
    }

    // Timer thread: copies the newest fftSize samples; returns the running frame count and the peak
    // seen since the previous call.
    func snapshot(into out: UnsafeMutablePointer<Float>) -> (written: Int, peak: Float) {
        os_unfair_lock_lock(lock)
        defer { os_unfair_lock_unlock(lock) }
        let mask = Ring.size - 1
        let start = written - fftSize
        for i in 0..<fftSize { out[i] = start + i >= 0 ? data[(start + i) & mask] : 0 }
        let p = peak
        peak = 0
        return (written, p)
    }
}

// MARK: - Core Audio capture

struct Fail: Error { let reason: String }

func check(_ status: OSStatus, _ what: String) throws {
    if status != noErr { throw Fail(reason: "\(what) failed (OSStatus \(status))") }
}

func defaultOutputUID() throws -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var device = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device),
              "reading the default output device")
    addr.mSelector = kAudioDevicePropertyDeviceUID
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try check(AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &uid), "reading the output device UID")
    guard let value = uid?.takeRetainedValue() else { throw Fail(reason: "no default output device") }
    return value as String
}

final class Capture {
    let ring = Ring()
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private(set) var sampleRate: Float = 48000

    func start() throws {
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.name = "TabDeck visualizer"
        desc.muteBehavior = .unmuted
        desc.isPrivate = true
        try check(AudioHardwareCreateProcessTap(desc, &tapID), "creating the audio tap")

        var fmtAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        var fmt = AudioStreamBasicDescription()
        var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &fmt), "reading the tap format")
        let isFloat32 = fmt.mFormatID == kAudioFormatLinearPCM
            && fmt.mFormatFlags & kAudioFormatFlagIsFloat != 0 && fmt.mBitsPerChannel == 32
        if !isFloat32 { throw Fail(reason: "unexpected tap sample format") }
        if fmt.mSampleRate >= 8000 { sampleRate = Float(fmt.mSampleRate) }

        // The aggregate gets the default output as clock/main sub-device; the tap rides on it.
        let outputUID = try defaultOutputUID()
        let tapUID = desc.uuid.uuidString
        let config: [String: Any] = [
            kAudioAggregateDeviceNameKey: "TabDeck visualizer",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        try check(AudioHardwareCreateAggregateDevice(config as CFDictionary, &aggregateID), "creating the aggregate device")

        let ring = self.ring
        try check(AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, nil) { _, input, _, _, _ in
            ring.push(input)
        }, "creating the IOProc")
        // With tap auto-start, AudioDeviceStart may wait for the first audio: keep it off the main thread.
        let device = aggregateID
        let proc = procID
        DispatchQueue.global().async {
            let status = AudioDeviceStart(device, proc)
            if status != noErr { die("starting the audio device failed (OSStatus \(status))") }
        }
    }

    func stop() {
        if let proc = procID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
        }
        procID = nil
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
    }
}

// MARK: - Test tone

// A moving fake spectrum (sweeping peak plus pulsing low end), pushed through the same output path.
func testSpectrum(bands: Int, t: Double) -> [Float] {
    let sweep = Float((sin(t * 0.5) + 1) / 2) * Float(bands - 1)
    let pulse = Float(max(0, sin(t * 6))) // ~1 Hz beat
    return (0..<bands).map { i in
        let d = (Float(i) - sweep) / 2.5
        var v = 0.85 * expf(-d * d)
        if i < max(bands / 8, 2) { v = max(v, 0.15 + 0.8 * pulse) }
        return min(v + 0.05, 1)
    }
}

// MARK: - Main

signal(SIGPIPE, SIG_IGN)
setvbuf(stderr, nil, _IOLBF, 0)
let options = parseArgs()
let capture = Capture()
var shuttingDown = false

func shutdown() -> Never {
    if !shuttingDown {
        shuttingDown = true
        if !options.testTone { capture.stop() }
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
timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(5))

if options.testTone {
    var smoother = Smoother(bands: options.bands)
    let t0 = Date()
    timer.setEventHandler {
        emit(smoother.apply(testSpectrum(bands: options.bands, t: Date().timeIntervalSince(t0))))
    }
    say("ready")
} else {
    do { try capture.start() } catch let e as Fail { capture.stop(); die(e.reason) } catch { capture.stop(); die("\(error)") }
    let analyzer = Analyzer(bands: options.bands, sampleRate: capture.sampleRate)
    let window = UnsafeMutablePointer<Float>.allocate(capacity: fftSize)
    window.initialize(repeating: 0, count: fftSize)
    var lastWritten = 0
    var lastSound = Date()
    var silentReported = false
    timer.setEventHandler {
        let snap = capture.ring.snapshot(into: window)
        // No new frames since the last tick (stream stalled): do not re-analyse stale samples.
        if snap.written == lastWritten { window.update(repeating: 0, count: fftSize) }
        lastWritten = snap.written
        if snap.peak > 0 {
            lastSound = Date()
            if silentReported {
                silentReported = false
                say("audio")
            }
        } else if !silentReported && Date().timeIntervalSince(lastSound) >= 3 {
            silentReported = true
            say("silent")
        }
        emit(analyzer.smoother.apply(analyzer.levels(window)))
    }
    say("ready")
}
timer.resume()
dispatchMain()
