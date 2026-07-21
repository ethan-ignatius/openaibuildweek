import { useEffect, useReducer, useState } from "react";
import type { BoardServerEvent } from "@teacher-brain/shared";
import {
  boardReducer,
  createStarterState,
  type BoardState,
} from "./board-state";

type ConnectionState = "connecting" | "connected" | "offline";

function defaultBoardSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:8000/ws/board`;
}

function isBoardServerEvent(payload: unknown): payload is BoardServerEvent {
  if (!payload || typeof payload !== "object" || !("type" in payload)) {
    return false;
  }

  const type = (payload as { type: unknown }).type;
  return ["board.snapshot", "board.action", "echo", "error"].includes(
    String(type),
  );
}

export function useBoardSocket(): {
  state: BoardState;
  connection: ConnectionState;
} {
  const [state, dispatch] = useReducer(boardReducer, undefined, createStarterState);
  const [connection, setConnection] = useState<ConnectionState>("connecting");

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let retryCount = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      setConnection("connecting");
      const socketUrl =
        import.meta.env.VITE_BOARD_WS_URL ?? defaultBoardSocketUrl();
      const activeSocket = new WebSocket(socketUrl);
      socket = activeSocket;

      activeSocket.addEventListener("open", () => {
        retryCount = 0;
        setConnection("connected");
      });

      activeSocket.addEventListener("message", (message) => {
        try {
          const payload: unknown = JSON.parse(String(message.data));
          if (isBoardServerEvent(payload)) {
            dispatch(payload);
          }
        } catch {
          // A malformed event is ignored; the last valid board state stays visible.
        }
      });

      activeSocket.addEventListener("close", () => {
        if (disposed) {
          return;
        }
        setConnection("offline");
        const delay = Math.min(500 * 2 ** retryCount, 5000);
        retryCount += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      });

      activeSocket.addEventListener("error", () => {
        activeSocket.close();
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, []);

  return { state, connection };
}
