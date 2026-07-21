import AVFoundation
import Foundation

let bytesPerFrame = 2
guard let format = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 24_000,
    channels: 1,
    interleaved: false
) else {
    fputs("Unable to create PCM audio format.\n", stderr)
    exit(2)
}

let engine = AVAudioEngine()
let player = AVAudioPlayerNode()
engine.attach(player)
engine.connect(player, to: engine.mainMixerNode, format: nil)
let outputFormat = player.outputFormat(forBus: 0)
guard let converter = AVAudioConverter(from: format, to: outputFormat) else {
    fputs("Unable to create PCM audio converter.\n", stderr)
    exit(2)
}

do {
    try engine.start()
} catch {
    fputs("Unable to start audio engine.\n", stderr)
    exit(2)
}

player.play()
let scheduled = DispatchGroup()
var pending = Data()
while true {
    let data = FileHandle.standardInput.readData(ofLength: 9_600)
    if data.isEmpty { break }
    pending.append(data)
    let playableByteCount = pending.count - (pending.count % bytesPerFrame)
    if playableByteCount == 0 { continue }
    let playable = pending.prefix(playableByteCount)
    pending.removeFirst(playableByteCount)
    let frameCount = AVAudioFrameCount(playable.count / bytesPerFrame)
    guard frameCount > 0,
          let inputBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount),
          let channel = inputBuffer.int16ChannelData?[0] else { continue }
    inputBuffer.frameLength = frameCount
    playable.withUnsafeBytes { source in
        if let address = source.baseAddress {
            memcpy(channel, address, Int(frameCount) * bytesPerFrame)
        }
    }
    let ratio = outputFormat.sampleRate / format.sampleRate
    let outputCapacity = AVAudioFrameCount(ceil(Double(frameCount) * ratio)) + 32
    guard let outputBuffer = AVAudioPCMBuffer(
        pcmFormat: outputFormat,
        frameCapacity: outputCapacity
    ) else { continue }
    var supplied = false
    var conversionError: NSError?
    let status = converter.convert(to: outputBuffer, error: &conversionError) { _, inputStatus in
        if supplied {
            inputStatus.pointee = .noDataNow
            return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return inputBuffer
    }
    if status == .error || conversionError != nil { continue }
    scheduled.enter()
    player.scheduleBuffer(outputBuffer, completionCallbackType: .dataPlayedBack) { _ in
        scheduled.leave()
    }
}

scheduled.wait()
player.stop()
engine.stop()
