"use client";

import { useEffect, useState, type ComponentType } from "react";

export function ExcalidrawProjectorClient() {
  const [Projector, setProjector] = useState<ComponentType | null>(null);

  useEffect(() => {
    let disposed = false;
    void import("./ExcalidrawProjector").then((module) => {
      if (!disposed) setProjector(() => module.ExcalidrawProjector);
    });
    return () => { disposed = true; };
  }, []);

  if (!Projector) return <main className="projector-status" role="status"><strong>Loading the local Excalidraw board…</strong></main>;
  return <Projector />;
}
