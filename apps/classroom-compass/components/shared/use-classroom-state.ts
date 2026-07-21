"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createInitialState } from "../../demo/fixtures";
import type { AppState, PublicDisplayState } from "../../domain/types";

type ConnectionState = "loading" | "saved" | "offline" | "error";

export function useClassroomState() {
  const [state, setState] = useState<AppState>(createInitialState);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const channel = useRef<BroadcastChannel | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error("State API unavailable");
      setState(await response.json());
      setConnection("saved");
    } catch {
      setConnection(navigator.onLine ? "error" : "offline");
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const syncTimer = window.setInterval(load, 900);
    channel.current = new BroadcastChannel("classroom-compass-session");
    channel.current.onmessage = () => void load();
    return () => { window.clearTimeout(initialTimer); window.clearInterval(syncTimer); channel.current?.close(); };
  }, [load]);

  const update = useCallback((recipe: (current: AppState) => AppState) => {
    setState((current) => {
      const next = recipe(current);
      setConnection("loading");
      void fetch("/api/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }).then((response) => {
        if (!response.ok) throw new Error("Save failed");
        setConnection("saved");
        channel.current?.postMessage("updated");
      }).catch(() => setConnection(navigator.onLine ? "error" : "offline"));
      return next;
    });
  }, []);

  const reset = useCallback(async () => {
    const response = await fetch("/api/state", { method: "DELETE" });
    if (!response.ok) throw new Error("Reset failed");
    const next = await response.json() as AppState;
    setState(next);
    setConnection("saved");
    channel.current?.postMessage("updated");
  }, []);

  return { state, update, reset, reload: load, connection };
}

export function usePublicDisplayState() {
  const [state, setState] = useState<PublicDisplayState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("loading");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/state?public=1", { cache: "no-store" });
      if (!response.ok) throw new Error("Display state unavailable");
      setState(await response.json());
      setConnection("saved");
    } catch {
      setConnection(navigator.onLine ? "error" : "offline");
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, 900);
    const channel = new BroadcastChannel("classroom-compass-session");
    channel.onmessage = () => void load();
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); channel.close(); };
  }, [load]);

  return { state, connection, reload: load };
}
