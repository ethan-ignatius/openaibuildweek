"use client";

import { Excalidraw, FONT_FAMILY, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawScene } from "../../headless/whiteboard/excalidraw-tool";

const controlUrl = process.env.NEXT_PUBLIC_CC_CONTROL_URL ?? "http://127.0.0.1:4317";

function toExcalidrawSkeleton(scene: ExcalidrawScene) {
  return scene.elements.map((element) => {
    if (element.type === "text") return {
      ...element,
      fontFamily: FONT_FAMILY.Helvetica,
      lineHeight: 1.25,
    };
    if (element.type === "line" || element.type === "arrow") return {
      ...element,
      endArrowhead: element.type === "arrow" ? "arrow" : null,
      label: element.label ? { text: element.label } : undefined,
    };
    return {
      ...element,
      label: element.label ? { text: element.label } : undefined,
      roughness: 1,
    };
  }) as Parameters<typeof convertToExcalidrawElements>[0];
}

export function ExcalidrawProjector() {
  const [scene, setScene] = useState<ExcalidrawScene | null>(null);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline">("connecting");
  const lastRevision = useRef(-1);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${controlUrl}/board`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Board service returned ${response.status}`);
        const candidate = await response.json() as ExcalidrawScene;
        if (!disposed && candidate.revision !== lastRevision.current) {
          lastRevision.current = candidate.revision;
          setScene(candidate);
        }
        if (!disposed) setConnection("connected");
      } catch {
        if (!disposed) setConnection("offline");
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 350);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  const elements = useMemo(
    () => scene ? convertToExcalidrawElements(toExcalidrawSkeleton(scene), { regenerateIds: false }) : [],
    [scene],
  );

  return (
    <main className="excalidraw-projector">
      <div className="excalidraw-canvas" aria-label="Classroom Compass Excalidraw board">
        {scene && <Excalidraw
          key={`${scene.sceneId}-${scene.revision}`}
          initialData={{
            elements,
            appState: {
              viewBackgroundColor: "#fffdf7",
              zenModeEnabled: true,
            },
            scrollToContent: true,
          }}
          theme="light"
          zenModeEnabled
          excalidrawAPI={(api: ExcalidrawImperativeAPI) => {
            window.requestAnimationFrame(() => api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.82 }));
          }}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
              toggleTheme: false,
            },
          }}
        />}
      </div>
      {!scene || connection !== "connected" || scene.status === "paused" || scene.status === "closed" ? (
        <section className="projector-status" role="status">
          <span className={`projector-dot ${connection}`} />
          <strong>{scene?.status === "paused" ? "Activity paused" : scene?.status === "closed" ? "Session ended" : connection === "offline" ? "Waiting for the local tutor service" : "Connecting to Classroom Compass"}</strong>
          <small>No camera, microphone, transcript, or student profile data is shown here.</small>
        </section>
      ) : null}
      <aside className="projector-badge">
        <span className={`projector-dot ${connection}`} />
        Local Excalidraw board · {scene?.source === "agent-drawing" ? "agent drawing" : "reviewed visual"}
      </aside>
    </main>
  );
}
