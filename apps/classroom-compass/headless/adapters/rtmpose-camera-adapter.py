#!/usr/bin/env python3
"""Local multi-person RTMW camera adapter with open-palm raise confirmation."""

from __future__ import annotations

import argparse
import contextlib
from collections import deque
from dataclasses import dataclass, field
import json
from pathlib import Path
import signal
import sys
import time
from typing import Any

import cv2
import numpy as np


ADAPTER_ID = "local-rtmw-m-palm@1.1.0"
COCO_LINKS = (
    (5, 7), (7, 9), (6, 8), (8, 10), (5, 6),
    (5, 11), (6, 12), (11, 12), (11, 13), (13, 15),
    (12, 14), (14, 16), (0, 1), (0, 2), (1, 3), (2, 4),
)
LEFT_HAND_START = 91
RIGHT_HAND_START = 112
HAND_LINKS = tuple(
    (finger_start + offset, finger_start + offset + 1)
    for finger_start in (1, 5, 9, 13, 17)
    for offset in range(3)
) + ((0, 1), (0, 5), (0, 9), (0, 13), (0, 17))


def emit(kind: str, payload: dict[str, Any], confidence_band: str | None = None) -> None:
    provenance: dict[str, str] = {"adapter": ADAPTER_ID, "version": "1.1.0"}
    if confidence_band:
        provenance["confidenceBand"] = confidence_band
    print(json.dumps({
        "kind": kind,
        "source": "live",
        "payload": payload,
        "provenance": provenance,
    }), flush=True)


@dataclass(frozen=True)
class SeatRegion:
    id: str
    label: str
    polygon: tuple[tuple[float, float], ...]

    def pixels(self, width: int, height: int) -> np.ndarray:
        return np.asarray([(int(x * width), int(y * height)) for x, y in self.polygon], dtype=np.int32)

    def contains(self, point: tuple[float, float], width: int, height: int) -> bool:
        return cv2.pointPolygonTest(self.pixels(width, height), point, False) >= 0


@dataclass
class RaiseState:
    recent: deque[bool] = field(default_factory=lambda: deque(maxlen=8))
    active: bool = False
    lowered_frames: int = 0
    last_seen: float = 0.0


def default_regions() -> list[SeatRegion]:
    # The current prototype has two fixed seats. Ethan occupies the left third;
    # Emanuel occupies the rest of the camera view. Keeping only enrolled seat
    # regions prevents a valid raise near the middle from becoming an anonymous
    # fallback profile.
    return [
        SeatRegion("camera-left", "Camera left", ((0.0, 0.0), (1 / 3, 0.0), (1 / 3, 1.0), (0.0, 1.0))),
        SeatRegion("camera-right", "Camera right · Emanuel", ((1 / 3, 0.0), (1.0, 0.0), (1.0, 1.0), (1 / 3, 1.0))),
    ]


def load_regions(path: str | None) -> list[SeatRegion]:
    if not path:
        return default_regions()
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    regions = []
    for item in value.get("regions", []):
        polygon = tuple((float(point[0]), float(point[1])) for point in item["polygon"])
        if len(polygon) < 3 or any(not (0 <= coordinate <= 1) for point in polygon for coordinate in point):
            raise ValueError("Seat-region polygons need at least three normalized points.")
        regions.append(SeatRegion(str(item["id"]), str(item.get("label", item["id"])), polygon))
    if not regions:
        raise ValueError("The seat-region file contains no regions.")
    return regions


def confidence_band(value: float) -> str:
    if value >= 0.70:
        return "high"
    if value >= 0.45:
        return "medium"
    return "low"


def open_palm(
    keypoints: np.ndarray,
    scores: np.ndarray,
    start: int,
    threshold: float = 0.25,
) -> tuple[bool, float]:
    """Confirm at least three extended fingers from RTMW's 21 hand landmarks."""
    if keypoints.shape[0] < start + 21 or scores.shape[0] < start + 21:
        return False, 0.0
    hand_points = keypoints[start:start + 21]
    hand_scores = scores[start:start + 21]
    wrist = hand_points[0]
    if float(hand_scores[0]) < threshold:
        return False, 0.0
    extended_scores: list[float] = []
    for mcp, pip, tip in ((5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20)):
        required_score = min(float(hand_scores[index]) for index in (mcp, pip, tip))
        if required_score < threshold:
            continue
        pip_distance = float(np.linalg.norm(hand_points[pip] - wrist))
        tip_distance = float(np.linalg.norm(hand_points[tip] - wrist))
        if pip_distance > 1.0 and tip_distance >= pip_distance * 1.12:
            extended_scores.append(required_score)
    return len(extended_scores) >= 3, min(extended_scores, default=0.0)


def raised_hand(
    keypoints: np.ndarray,
    scores: np.ndarray,
    threshold: float = 0.35,
    require_open_palm: bool = True,
) -> tuple[bool, float]:
    """Confirm a deliberate vertical raise, optionally with an open RTMW palm."""
    if keypoints.shape[0] < 11 or scores.shape[0] < 11:
        return False, 0.0
    candidates: list[float] = []
    visible_body = keypoints[:17][scores[:17] >= threshold]
    body_height = float(np.ptp(visible_body[:, 1])) if len(visible_body) else 0.0
    shoulder_width = (
        float(np.linalg.norm(keypoints[5] - keypoints[6]))
        if min(float(scores[5]), float(scores[6])) >= threshold
        else body_height * 0.25
    )
    for shoulder_index, elbow_index, wrist_index, hand_start in (
        (5, 7, 9, LEFT_HAND_START),
        (6, 8, 10, RIGHT_HAND_START),
    ):
        shoulder_score = float(scores[shoulder_index])
        elbow_score = float(scores[elbow_index])
        wrist_score = float(scores[wrist_index])
        if min(shoulder_score, elbow_score, wrist_score) < threshold:
            continue
        shoulder = keypoints[shoulder_index]
        elbow = keypoints[elbow_index]
        wrist = keypoints[wrist_index]
        vertical_margin = max(12.0, body_height * 0.10, shoulder_width * 0.35)
        wrist_is_high = float(wrist[1]) < float(shoulder[1]) - vertical_margin
        forearm_points_up = float(wrist[1]) < float(elbow[1]) - max(8.0, body_height * 0.04)
        not_flared_sideways = abs(float(wrist[0] - shoulder[0])) <= max(45.0, shoulder_width * 1.40)
        if not (wrist_is_high and forearm_points_up and not_flared_sideways):
            continue
        palm_visible, palm_score = open_palm(keypoints, scores, hand_start)
        if require_open_palm and not palm_visible:
            continue
        candidates.append(min(shoulder_score, elbow_score, wrist_score, palm_score or wrist_score))
    return (bool(candidates), max(candidates, default=0.0))


def pose_anchor(keypoints: np.ndarray, scores: np.ndarray, threshold: float = 0.35) -> tuple[float, float] | None:
    shoulders = [keypoints[index] for index in (5, 6) if float(scores[index]) >= threshold]
    if shoulders:
        center = np.mean(shoulders, axis=0)
        return float(center[0]), float(center[1])
    visible = keypoints[scores >= threshold]
    if len(visible):
        center = np.mean(visible, axis=0)
        return float(center[0]), float(center[1])
    return None


def assigned_region(regions: list[SeatRegion], anchor: tuple[float, float], width: int, height: int) -> SeatRegion | None:
    return next((region for region in regions if region.contains(anchor, width, height)), None)


def draw_regions(frame: np.ndarray, regions: list[SeatRegion]) -> None:
    height, width = frame.shape[:2]
    overlay = frame.copy()
    for region in regions:
        polygon = region.pixels(width, height)
        cv2.polylines(overlay, [polygon], True, (220, 220, 220), 1, cv2.LINE_AA)
        x, y = polygon[0]
        cv2.putText(overlay, region.label, (x + 8, max(24, y + 24)), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (240, 240, 240), 1, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)


def draw_pose(frame: np.ndarray, keypoints: np.ndarray, scores: np.ndarray, raised: bool, region: SeatRegion | None) -> None:
    threshold = 0.35
    color = (70, 220, 120) if raised else (255, 190, 70)
    body_scores = scores[:17]
    body_points = keypoints[:17]
    visible = body_scores >= threshold
    for start, end in COCO_LINKS:
        if start < len(body_scores) and end < len(body_scores) and visible[start] and visible[end]:
            a = tuple(np.asarray(keypoints[start], dtype=int))
            b = tuple(np.asarray(keypoints[end], dtype=int))
            cv2.line(frame, a, b, color, 2, cv2.LINE_AA)
    for index, point in enumerate(body_points):
        if visible[index]:
            cv2.circle(frame, tuple(np.asarray(point, dtype=int)), 4, color, -1, cv2.LINE_AA)
    if raised and len(keypoints) >= RIGHT_HAND_START + 21:
        for hand_start in (LEFT_HAND_START, RIGHT_HAND_START):
            for start, end in HAND_LINKS:
                a_index, b_index = hand_start + start, hand_start + end
                if float(scores[a_index]) >= 0.25 and float(scores[b_index]) >= 0.25:
                    a = tuple(np.asarray(keypoints[a_index], dtype=int))
                    b = tuple(np.asarray(keypoints[b_index], dtype=int))
                    cv2.line(frame, a, b, (90, 255, 160), 2, cv2.LINE_AA)
    points = body_points[visible]
    if len(points):
        x0, y0 = np.min(points, axis=0).astype(int)
        x1, y1 = np.max(points, axis=0).astype(int)
        cv2.rectangle(frame, (x0 - 12, y0 - 12), (x1 + 12, y1 + 12), color, 2)
        status = "OPEN PALM RAISED" if raised else "Pose detected"
        label = f"{region.label if region else 'Unassigned'} · {status}"
        cv2.putText(frame, label, (max(8, x0 - 12), max(28, y0 - 20)), cv2.FONT_HERSHEY_SIMPLEX, 0.58, color, 2, cv2.LINE_AA)


def update_states(
    states: dict[str, RaiseState],
    regions: list[SeatRegion],
    observations: dict[str, tuple[bool, float]],
    now: float,
) -> None:
    for region in regions:
        raised, score = observations.get(region.id, (False, 0.0))
        state = states.setdefault(region.id, RaiseState())
        state.recent.append(raised)
        if region.id in observations:
            state.last_seen = now
        if raised:
            state.lowered_frames = 0
        elif state.active:
            state.lowered_frames += 1
        if not state.active and len(state.recent) >= 5 and sum(state.recent) >= 5:
            state.active = True
            emit("hand_raise", {
                "seat": region.id,
                "detail": "RTMW observed an open palm on a deliberately raised, upward-pointing arm across multiple frames.",
            }, confidence_band(score))
            print(f"Hand raise: {region.label}", file=sys.stderr, flush=True)
        if state.active and state.lowered_frames >= 8:
            state.active = False
            state.lowered_frames = 0
            state.recent.clear()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Classroom Compass multi-person RTMW camera adapter")
    parser.add_argument("--camera", type=int, default=1, help="OpenCV camera index")
    parser.add_argument("--preview", action="store_true", help="Show a local diagnostic window")
    parser.add_argument("--regions", help="JSON file containing normalized seat polygons")
    parser.add_argument("--mode", choices=("lightweight", "balanced", "performance"), default="lightweight")
    parser.add_argument("--gesture", choices=("open-palm", "raised-arm"), default="open-palm")
    parser.add_argument("--detection-interval", type=int, default=3, help="Run person detection every N frames; pose estimation still runs every frame")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def self_test() -> None:
    keypoints = np.zeros((133, 2), dtype=np.float32)
    scores = np.zeros(133, dtype=np.float32)
    keypoints[6] = (160, 200)
    scores[6] = 0.9
    keypoints[5] = (100, 200)
    keypoints[7] = (100, 145)
    keypoints[9] = (100, 90)
    scores[[5, 7, 9]] = 0.9
    for local_index, point in enumerate([
        (100, 90), (82, 82), (76, 72), (70, 62), (64, 52),
        (92, 76), (91, 62), (90, 48), (89, 32),
        (100, 74), (100, 58), (100, 42), (100, 24),
        (108, 76), (109, 62), (110, 48), (111, 32),
        (116, 80), (119, 68), (122, 56), (126, 43),
    ]):
        keypoints[LEFT_HAND_START + local_index] = point
        scores[LEFT_HAND_START + local_index] = 0.85
    assert raised_hand(keypoints, scores)[0]
    keypoints[9] = (20, 190)
    keypoints[7] = (60, 195)
    assert not raised_hand(keypoints, scores)[0]
    assert assigned_region(default_regions(), (500, 300), 900, 600).id == "camera-right"
    emit("camera_connected", {"device": "self-test"})
    emit("hand_raise", {"seat": "camera-right", "detail": "Synthetic open-palm RTMW adapter self-test."}, "high")


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0

    regions = load_regions(args.regions)
    with contextlib.redirect_stdout(sys.stderr):
        from rtmlib import Body, PoseTracker, Wholebody
        model = PoseTracker(
            Wholebody if args.gesture == "open-palm" else Body,
            det_frequency=max(1, args.detection_interval),
            tracking=False,
            mode=args.mode,
            backend="onnxruntime",
            device="cpu",
        )

    capture = cv2.VideoCapture(args.camera, cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, args.width)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, args.height)
    capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    if not capture.isOpened():
        emit("sensor_unavailable", {"detail": f"Unable to open camera index {args.camera}."})
        return 2

    running = True

    def stop(*_: Any) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    if args.preview:
        cv2.namedWindow("Classroom Compass · Pose Preview", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Classroom Compass · Pose Preview", 960, 540)

    model_label = "RTMW-m whole-body" if args.gesture == "open-palm" else "RTMPose-m body"
    emit("camera_connected", {"device": f"camera-index-{args.camera} ({model_label})"})
    print(f"{model_label} camera ready. Frames remain in memory and are not saved.", file=sys.stderr, flush=True)
    states: dict[str, RaiseState] = {}
    smoothed_fps = 0.0
    consecutive_read_failures = 0
    max_read_failures = 30

    try:
        while running:
            ok, frame = capture.read()
            if not ok:
                consecutive_read_failures += 1
                if consecutive_read_failures < max_read_failures:
                    time.sleep(0.1)
                    continue
                emit(
                    "sensor_unavailable",
                    {
                        "detail": (
                            f"Camera index {args.camera} opened but returned no frames for "
                            "3 seconds. Turn off video in Teams, Zoom, or another camera app, "
                            "then restart Classroom Compass."
                        )
                    },
                )
                break
            consecutive_read_failures = 0
            started = time.monotonic()
            keypoints, scores = model(frame)
            keypoints_array = np.asarray(keypoints)
            scores_array = np.asarray(scores).squeeze()
            if keypoints_array.ndim == 2:
                keypoints_array = keypoints_array[None, ...]
            if scores_array.ndim == 1 and len(scores_array):
                scores_array = scores_array[None, ...]

            height, width = frame.shape[:2]
            observations: dict[str, tuple[bool, float]] = {}
            pose_rows: list[tuple[np.ndarray, np.ndarray, bool, SeatRegion | None]] = []
            if keypoints_array.ndim == 3 and scores_array.ndim == 2:
                for pose, pose_scores in zip(keypoints_array, scores_array):
                    anchor = pose_anchor(pose, pose_scores)
                    region = assigned_region(regions, anchor, width, height) if anchor else None
                    is_raised, score = raised_hand(pose, pose_scores, require_open_palm=args.gesture == "open-palm")
                    if region:
                        prior = observations.get(region.id, (False, 0.0))
                        observations[region.id] = (prior[0] or is_raised, max(prior[1], score))
                    pose_rows.append((pose, pose_scores, is_raised, region))
            update_states(states, regions, observations, time.monotonic())

            elapsed = max(time.monotonic() - started, 1e-6)
            fps = 1.0 / elapsed
            smoothed_fps = fps if smoothed_fps == 0 else smoothed_fps * 0.85 + fps * 0.15
            if args.preview:
                draw_regions(frame, regions)
                for pose, pose_scores, is_raised, region in pose_rows:
                    draw_pose(frame, pose, pose_scores, is_raised, region)
                cv2.rectangle(frame, (0, 0), (width, 42), (18, 24, 28), -1)
                header = f"{model_label} · {len(pose_rows)} pose{'s' if len(pose_rows) != 1 else ''} · {smoothed_fps:.1f} FPS · raw media saved: 0"
                cv2.putText(frame, header, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (245, 245, 245), 2, cv2.LINE_AA)
                instruction = "Show an open palm above your shoulder · Q or Esc closes" if args.gesture == "open-palm" else "Raise wrist above shoulder · Q or Esc closes"
                cv2.putText(frame, instruction, (14, height - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (245, 245, 245), 2, cv2.LINE_AA)
                cv2.imshow("Classroom Compass · Pose Preview", frame)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                if cv2.getWindowProperty("Classroom Compass · Pose Preview", cv2.WND_PROP_VISIBLE) < 1:
                    break
    finally:
        capture.release()
        if args.preview:
            cv2.destroyAllWindows()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
