import Foundation
import Speech
import AVFoundation

private let adapterID = "macos-on-device-speech@1.0.0"

private func writeEvent(kind: String, payload: [String: Any], confidenceBand: String? = nil) {
    var provenance: [String: String] = ["adapter": adapterID, "version": "1.0.0"]
    if let confidenceBand { provenance["confidenceBand"] = confidenceBand }
    let event: [String: Any] = [
        "kind": kind,
        "source": "live",
        "payload": payload,
        "provenance": provenance,
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: event),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

private func fail(_ message: String) -> Never {
    writeEvent(kind: "sensor_unavailable", payload: ["detail": message])
    fputs("Classroom Compass voice adapter: \(message)\n", stderr)
    exit(2)
}

private func speechPermissionGranted() -> Bool {
    if SFSpeechRecognizer.authorizationStatus() == .authorized { return true }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    SFSpeechRecognizer.requestAuthorization { status in
        granted = status == .authorized
        semaphore.signal()
    }
    semaphore.wait()
    return granted
}

private func microphonePermissionGranted() -> Bool {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized { return true }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .audio) { allowed in
        granted = allowed
        semaphore.signal()
    }
    semaphore.wait()
    return granted
}

final class ClassroomSpeechAdapter {
    private let audioEngine = AVAudioEngine()
    private let recognizer: SFSpeechRecognizer
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var partialTranscript = ""
    private var partialSegments: [[String: Any]] = []
    private var partialUpdatedAt = Date.distantPast
    private var emittedCount = 0
    private var timer: Timer?
    private let allowNetworkRecognition: Bool

    init(locale: Locale, allowNetworkRecognition: Bool) {
        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            fail("Speech recognition is unavailable for locale \(locale.identifier).")
        }
        self.recognizer = recognizer
        self.allowNetworkRecognition = allowNetworkRecognition
    }

    func start() {
        guard speechPermissionGranted() else {
            fail("Speech Recognition permission was denied. Enable it in System Settings → Privacy & Security → Speech Recognition.")
        }
        guard microphonePermissionGranted() else {
            fail("Microphone permission was denied. Enable it in System Settings → Privacy & Security → Microphone.")
        }
        guard recognizer.isAvailable else { fail("The macOS speech recognizer is currently unavailable.") }
        if !allowNetworkRecognition && !recognizer.supportsOnDeviceRecognition {
            fail("On-device speech recognition is unavailable for this locale. Set CC_ALLOW_NETWORK_SPEECH=1 only if cloud-assisted recognition is acceptable.")
        }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { fail("The selected microphone has no usable input format.") }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            self?.request?.append(buffer)
        }
        startRecognitionTask()
        audioEngine.prepare()
        do { try audioEngine.start() } catch { fail("Unable to start the microphone: \(error.localizedDescription)") }

        writeEvent(kind: "microphone_connected", payload: ["device": "MacBook Pro Microphone"])
        fputs("Classroom Compass voice adapter ready. Speak the decimal question, pause, then speak each answer after the tutor prompt.\n", stderr)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.flushAfterSilence() }
    }

    private func startRecognitionTask() {
        task?.cancel()
        request?.endAudio()
        let nextRequest = SFSpeechAudioBufferRecognitionRequest()
        nextRequest.shouldReportPartialResults = true
        nextRequest.taskHint = .dictation
        nextRequest.contextualStrings = [
            "zero point three five", "zero point four", "zero point four zero",
            "thirty-five hundredths", "forty hundredths", "0.35", "0.40",
        ]
        nextRequest.requiresOnDeviceRecognition = !allowNetworkRecognition
        request = nextRequest
        task = recognizer.recognitionTask(with: nextRequest) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty {
                        self.partialTranscript = text
                        self.partialSegments = result.bestTranscription.segments.map { segment in
                            [
                                "text": segment.substring,
                                "alternatives": Array(segment.alternativeSubstrings.prefix(4)),
                            ]
                        }
                        self.partialUpdatedAt = Date()
                    }
                    if result.isFinal { self.flushTranscript() }
                } else if error != nil && self.audioEngine.isRunning {
                    self.startRecognitionTask()
                }
            }
        }
    }

    private func flushAfterSilence() {
        guard !partialTranscript.isEmpty, Date().timeIntervalSince(partialUpdatedAt) >= 1.8 else { return }
        flushTranscript()
    }

    private func flushTranscript() {
        let transcript = partialTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        partialTranscript = ""
        let segments = partialSegments
        partialSegments = []
        let kind = emittedCount == 0 ? "question_transcribed" : "response_transcribed"
        emittedCount += 1
        writeEvent(
            kind: kind,
            payload: ["text": transcript, "transcriptionSegments": segments],
            confidenceBand: "medium"
        )
        fputs("Recognized \(kind == "question_transcribed" ? "question" : "response").\n", stderr)
        startRecognitionTask()
    }
}

if CommandLine.arguments.contains("--self-test") {
    writeEvent(kind: "microphone_connected", payload: ["device": "self-test"])
    writeEvent(kind: "question_transcribed", payload: ["text": "Why is zero point three five not bigger than zero point four?"], confidenceBand: "medium")
    exit(0)
}

let localeArgument = CommandLine.arguments.dropFirst().first ?? "en-US"
let allowNetwork = ProcessInfo.processInfo.environment["CC_ALLOW_NETWORK_SPEECH"] == "1"
let adapter = ClassroomSpeechAdapter(locale: Locale(identifier: localeArgument), allowNetworkRecognition: allowNetwork)
adapter.start()
RunLoop.main.run()
