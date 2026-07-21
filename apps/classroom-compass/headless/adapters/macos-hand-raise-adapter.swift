import Foundation
import AVFoundation
import Vision

private let adapterID = "macos-vision-hand-raise@1.0.0"

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
    fputs("Classroom Compass camera adapter: \(message)\n", stderr)
    exit(2)
}

private func cameraPermissionGranted() -> Bool {
    if AVCaptureDevice.authorizationStatus(for: .video) == .authorized { return true }
    let semaphore = DispatchSemaphore(value: 0)
    var granted = false
    AVCaptureDevice.requestAccess(for: .video) { allowed in
        granted = allowed
        semaphore.signal()
    }
    semaphore.wait()
    return granted
}

private struct RaisedHand {
    let zone: String
    let confidenceBand: String
}

final class HandRaiseDetector: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let bodyRequest = VNDetectHumanBodyPoseRequest()
    private let handRequest: VNDetectHumanHandPoseRequest = {
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 4
        return request
    }()
    private let debug = ProcessInfo.processInfo.environment["CC_CAMERA_DEBUG"] == "1"
    private var lastProcessedAt = Date.distantPast
    private var lastDebugAt = Date.distantPast
    private var raisedFrames = 0
    private var loweredFrames = 0
    private var raiseActive = false

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        autoreleasepool {
            let now = Date()
            guard now.timeIntervalSince(lastProcessedAt) >= 0.12,
                  let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lastProcessedAt = now
            let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
            do {
                try handler.perform([bodyRequest, handRequest])
                update(bodyObservations: bodyRequest.results ?? [], handObservations: handRequest.results ?? [])
            } catch {
                // A failed frame is dropped. Later frames continue through the local detector.
            }
        }
    }

    private func update(bodyObservations: [VNHumanBodyPoseObservation], handObservations: [VNHumanHandPoseObservation]) {
        if debug && Date().timeIntervalSince(lastDebugAt) >= 1.0 {
            lastDebugAt = Date()
            fputs("Pose candidates visible: bodies=\(bodyObservations.count), hands=\(handObservations.count).\n", stderr)
        }
        let raised = bodyObservations.compactMap(detectRaisedHand).first ?? handObservations.compactMap(detectOpenRaisedPalm).first
        if let raised {
            loweredFrames = 0
            raisedFrames += 1
            if raisedFrames >= 3 && !raiseActive {
                raiseActive = true
                writeEvent(
                    kind: "hand_raise",
                    payload: ["seat": raised.zone, "detail": "A sustained raised-hand gesture was observed across multiple frames."],
                    confidenceBand: raised.confidenceBand
                )
                fputs("Observed a hand raise in \(raised.zone).\n", stderr)
            }
        } else {
            raisedFrames = 0
            if raiseActive {
                loweredFrames += 1
                if loweredFrames >= 8 {
                    raiseActive = false
                    loweredFrames = 0
                }
            }
        }
    }

    private func detectOpenRaisedPalm(in observation: VNHumanHandPoseObservation) -> RaisedHand? {
        guard let wrist = try? observation.recognizedPoint(.wrist), wrist.confidence >= 0.25 else { return nil }
        let tipNames: [VNHumanHandPoseObservation.JointName] = [.indexTip, .middleTip, .ringTip, .littleTip]
        let visibleTips = tipNames.compactMap { name -> VNRecognizedPoint? in
            guard let point = try? observation.recognizedPoint(name), point.confidence >= 0.25 else { return nil }
            return point
        }
        let extendedTips = visibleTips.filter { point in
            point.location.y > wrist.location.y + 0.05 && hypot(point.location.x - wrist.location.x, point.location.y - wrist.location.y) > 0.08
        }
        guard extendedTips.count >= 3 else { return nil }
        let centerX = ([wrist.location.x] + extendedTips.map(\.location.x)).reduce(0, +) / CGFloat(extendedTips.count + 1)
        let zone = centerX < 0.38 ? "camera-left" : centerX > 0.62 ? "camera-right" : "camera-center"
        let relevantConfidence = ([wrist.confidence] + extendedTips.map(\.confidence)).min() ?? wrist.confidence
        let band = relevantConfidence >= 0.70 ? "high" : relevantConfidence >= 0.45 ? "medium" : "low"
        return RaisedHand(zone: zone, confidenceBand: band)
    }

    private func detectRaisedHand(in observation: VNHumanBodyPoseObservation) -> RaisedHand? {
        let leftWrist = try? observation.recognizedPoint(.leftWrist)
        let rightWrist = try? observation.recognizedPoint(.rightWrist)
        let leftShoulder = try? observation.recognizedPoint(.leftShoulder)
        let rightShoulder = try? observation.recognizedPoint(.rightShoulder)
        let minimumConfidence: VNConfidence = 0.25
        let margin: CGFloat = 0.05
        let leftRaised = leftWrist.map { wrist in
            leftShoulder.map { shoulder in
                wrist.confidence >= minimumConfidence && shoulder.confidence >= minimumConfidence && wrist.location.y > shoulder.location.y + margin
            } ?? false
        } ?? false
        let rightRaised = rightWrist.map { wrist in
            rightShoulder.map { shoulder in
                wrist.confidence >= minimumConfidence && shoulder.confidence >= minimumConfidence && wrist.location.y > shoulder.location.y + margin
            } ?? false
        } ?? false
        guard leftRaised || rightRaised,
              let raisedWrist = leftRaised ? leftWrist : rightWrist,
              let raisedShoulder = leftRaised ? leftShoulder : rightShoulder else { return nil }

        let visibleShoulderXs = [leftShoulder, rightShoulder].compactMap { point in
            point.flatMap { $0.confidence >= minimumConfidence ? $0.location.x : nil }
        }
        let centerX = visibleShoulderXs.isEmpty
            ? raisedShoulder.location.x
            : visibleShoulderXs.reduce(0, +) / CGFloat(visibleShoulderXs.count)
        let zone = centerX < 0.38 ? "camera-left" : centerX > 0.62 ? "camera-right" : "camera-center"
        let relevantConfidence = min(raisedWrist.confidence, raisedShoulder.confidence)
        let band = relevantConfidence >= 0.70 ? "high" : relevantConfidence >= 0.45 ? "medium" : "low"
        return RaisedHand(zone: zone, confidenceBand: band)
    }
}

if CommandLine.arguments.contains("--self-test") {
    writeEvent(kind: "camera_connected", payload: ["device": "self-test"])
    writeEvent(kind: "hand_raise", payload: ["seat": "camera-center", "detail": "Synthetic adapter self-test."], confidenceBand: "high")
    exit(0)
}

guard cameraPermissionGranted() else {
    fail("Camera permission was denied. Enable Terminal or Classroom Compass Camera Adapter in System Settings → Privacy & Security → Camera.")
}

let selector = CommandLine.arguments.dropFirst().first
let deviceTypes: [AVCaptureDevice.DeviceType] = [.external, .builtInWideAngleCamera]
let devices = AVCaptureDevice.DiscoverySession(deviceTypes: deviceTypes, mediaType: .video, position: .unspecified).devices
let selectedDevice = selector.flatMap { requested in
    devices.first { $0.uniqueID == requested || $0.localizedName.localizedCaseInsensitiveContains(requested) }
} ?? devices.first { $0.deviceType == .external }

guard let device = selectedDevice else {
    fail("No matching camera was found. Available devices: \(devices.map(\.localizedName).joined(separator: ", ")).")
}

let session = AVCaptureSession()
session.sessionPreset = .high
let input: AVCaptureDeviceInput
do {
    input = try AVCaptureDeviceInput(device: device)
} catch {
    fail("Unable to open \(device.localizedName): \(error.localizedDescription)")
}
guard session.canAddInput(input) else { fail("Camera input cannot be added to the capture session.") }
session.addInput(input)

let detector = HandRaiseDetector()
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
output.setSampleBufferDelegate(detector, queue: DispatchQueue(label: "org.classroomcompass.hand-raise", qos: .userInitiated))
guard session.canAddOutput(output) else { fail("In-memory camera analysis output cannot be added.") }
session.addOutput(output)

session.startRunning()
guard session.isRunning else { fail("The camera capture session did not start.") }
writeEvent(kind: "camera_connected", payload: ["device": device.localizedName])
fputs("Classroom Compass camera adapter ready on \(device.localizedName). No video frames are saved.\n", stderr)

signal(SIGINT) { _ in session.stopRunning(); exit(0) }
signal(SIGTERM) { _ in session.stopRunning(); exit(0) }
RunLoop.main.run()
