#!/usr/bin/env python3
"""Local multi-person RTMPose camera adapter with an optional diagnostic window."""

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


ADAPTER_ID = "local-rtmpose-m@1.0.0"
COCO_LINKS = (
    (5, 7), (7, 9), (6, 8), (8, 10), (5, 6),
    (5, 11), (6, 12), (11, 12), (11, 13), (13, 15),
    (12, 14), (14, 16), (0, 1), (0, 2), (1, 3), (2, 4),
)


def emit(kind: str, payload: dict[str, Any], confidence_band: str | None = None) -> None:
    provenance: dict[str, str] = {"adapter": ADAPTER_ID, "version": "1.0.0"}
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
    return [
        SeatRegion("camera-left", "Camera left", ((0.0, 0.0), (1 / 3, 0.0), (1 / 3, 1.0), (0.0, 1.0))),
        SeatRegion("camera-center", "Camera center", ((1 / 3, 0.0), (2 / 3, 0.0), (2 / 3, 1.0), (1 / 3, 1.0))),
        SeatRegion("camera-right", "Camera right", ((2 / 3, 0.0), (1.0, 0.0), (1.0, 1.0), (2 / 3, 1.0))),
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


def raised_hand(keypoints: np.ndarray, scores: np.ndarray, threshold: float = 0.35) -> tuple[bool, float]:
    """Return whether either COCO wrist is above its matching shoulder."""
    if keypoints.shape[0] < 11 or scores.shape[0] < 11:
        return False, 0.0
    candidates: list[float] = []
    for shoulder_index, wrist_index in ((5, 9), (6, 10)):
        shoulder_score = float(scores[shoulder_index])
        wrist_score = float(scores[wrist_index])
        if min(shoulder_score, wrist_score) < threshold:
            continue
        visible = keypoints[scores >= threshold]
        body_height = float(np.ptp(visible[:, 1])) if len(visible) else 0.0
        margin = max(8.0, body_height * 0.05)
        if float(keypoints[wrist_index][1]) < float(keypoints[shoulder_index][1]) - margin:
            candidates.append(min(shoulder_score, wrist_score))
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
    visible = scores >= threshold
    for start, end in COCO_LINKS:
        if start < len(scores) and end < len(scores) and visible[start] and visible[end]:
            a = tuple(np.asarray(keypoints[start], dtype=int))
            b = tuple(np.asarray(keypoints[end], dtype=int))
            cv2.line(frame, a, b, color, 2, cv2.LINE_AA)
    for index, point in enumerate(keypoints):
        if index < len(scores) and visible[index]:
            cv2.circle(frame, tuple(np.asarray(point, dtype=int)), 4, color, -1, cv2.LINE_AA)
    points = keypoints[visible]
    if len(points):
        x0, y0 = np.min(points, axis=0).astype(int)
        x1, y1 = np.max(points, axis=0).astype(int)
        cv2.rectangle(frame, (x0 - 12, y0 - 12), (x1 + 12, y1 + 12), color, 2)
        status = "HAND RAISED" if raised else "Pose detected"
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
                "detail": "RTMPose observed a wrist above its matching shoulder across multiple frames.",
            }, confidence_band(score))
            print(f"Hand raise: {region.label}", file=sys.stderr, flush=True)
        if state.active and state.lowered_frames >= 8:
            state.active = False
            state.lowered_frames = 0
            state.recent.clear()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Classroom Compass RTMPose camera adapter")
    parser.add_argument("--camera", type=int, default=1, help="OpenCV camera index")
    parser.add_argument("--preview", action="store_true", help="Show a local diagnostic window")
    parser.add_argument("--regions", help="JSON file containing normalized seat polygons")
    parser.add_argument("--mode", choices=("lightweight", "balanced", "performance"), default="balanced")
    parser.add_argument("--detection-interval", type=int, default=3, help="Run person detection every N frames; pose estimation still runs every frame")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--self-test", action="store_true")
    return parser.parse_args()


def self_test() -> None:
    keypoints = np.zeros((17, 2), dtype=np.float32)
    scores = np.zeros(17, dtype=np.float32)
    keypoints[5] = (100, 200)
    keypoints[9] = (100, 80)
    scores[[5, 9]] = 0.9
    assert raised_hand(keypoints, scores)[0]
    assert assigned_region(default_regions(), (500, 300), 900, 600).id == "camera-center"
    emit("camera_connected", {"device": "self-test"})
    emit("hand_raise", {"seat": "camera-center", "detail": "Synthetic RTMPose adapter self-test."}, "high")


def main() -> int:
    args = parse_args()
    if args.self_test:
        self_test()
        return 0

    regions = load_regions(args.regions)
    with contextlib.redirect_stdout(sys.stderr):
        from rtmlib import Body, PoseTracker
        model = PoseTracker(
            Body,
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

    emit("camera_connected", {"device": f"camera-index-{args.camera} (RTMPose-m)"})
    print("RTMPose camera ready. Frames remain in memory and are not saved.", file=sys.stderr, flush=True)
    states: dict[str, RaiseState] = {}
    smoothed_fps = 0.0

    try:
        while running:
            ok, frame = capture.read()
            if not ok:
                emit("sensor_unavailable", {"detail": "The camera stopped returning frames."})
                break
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
                    is_raised, score = raised_hand(pose, pose_scores)
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
                header = f"RTMPose-m · {len(pose_rows)} pose{'s' if len(pose_rows) != 1 else ''} · {smoothed_fps:.1f} FPS · raw media saved: 0"
                cv2.putText(frame, header, (14, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (245, 245, 245), 2, cv2.LINE_AA)
                cv2.putText(frame, "Raise wrist above shoulder · Q or Esc closes", (14, height - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (245, 245, 245), 2, cv2.LINE_AA)
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
