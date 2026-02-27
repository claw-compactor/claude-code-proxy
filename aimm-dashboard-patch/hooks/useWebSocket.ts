"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export type WSStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface UseWebSocketOptions {
  url: string;
  symbols?: string[];
  onMessage?: (msg: WSMessage) => void;
  autoReconnect?: boolean;
  onConnect?: () => void;
}

/** Build subscription topics for the given symbols. */
function buildTopics(symbols: string[]): string[] {
  const perSymbol = [
    "book",
    "kline",
    "trade",
    "position",
    "order",
    "fill",
    "fills_snapshot",
    "strategy",
    "strategy_state",
  ];
  const global = ["account", "exchange_status"];

  const topics: string[] = [];
  for (const sym of symbols) {
    for (const prefix of perSymbol) {
      topics.push(`${prefix}.${sym}`);
    }
  }
  topics.push(...global);
  return topics;
}

const MAX_RECONNECT_DELAY = 30_000; // 30s
const INITIAL_RECONNECT_DELAY = 1_000; // 1s
const PING_INTERVAL_MS = 20_000; // 20s keepalive

export function useWebSocket({
  url,
  symbols = ["SOLUSDT"],
  onMessage,
  autoReconnect = true,
  onConnect,
}: UseWebSocketOptions) {
  const [status, setStatus] = useState<WSStatus>("disconnected");
  const [reconnectCount, setReconnectCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  const subscribedRef = useRef(false);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);

  // Keep callbacks in refs so the stable `connect` closure sees current versions
  const onMessageRef = useRef(onMessage);
  const onConnectRef = useRef(onConnect);
  const symbolsRef = useRef(symbols);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { onConnectRef.current = onConnect; }, [onConnect]);
  useEffect(() => { symbolsRef.current = symbols; }, [symbols]);

  const send = useCallback((data: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const sendSubscribe = useCallback((ws: WebSocket) => {
    if (\!subscribedRef.current && ws.readyState === WebSocket.OPEN) {
      subscribedRef.current = true;
      const topics = buildTopics(symbolsRef.current);
      ws.send(JSON.stringify({ type: "subscribe", topics }));
    }
  }, []);

  const connect = useCallback(() => {
    if (\!mounted.current) return;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    subscribedRef.current = false;

    // Clear any pending timers
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (fallbackTimer.current) { clearTimeout(fallbackTimer.current); fallbackTimer.current = null; }
    if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }

    try {
      setStatus("connecting");
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        if (\!mounted.current) return;
        setStatus("connected");
        reconnectDelayRef.current = INITIAL_RECONNECT_DELAY; // reset backoff on success

        // Auth
        ws.send(JSON.stringify({ type: "auth", token: "aimm-demo-2026" }));

        // Fallback: subscribe after 1s if auth_ok never arrives
        fallbackTimer.current = setTimeout(() => {
          if (mounted.current) sendSubscribe(ws);
        }, 1000);

        // Ping keepalive every 20s to prevent idle disconnection
        pingTimer.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, PING_INTERVAL_MS);

        // Notify caller (used for seeding klines on first connect)
        onConnectRef.current?.();
      };

      ws.onmessage = (event) => {
        try {
          const msg: WSMessage = JSON.parse(event.data);

          // Intercept auth confirmation -> send subscribe
          if (
            msg.type === "auth_ok" ||
            msg.type === "authenticated" ||
            (msg.type === "auth" && (msg.status === "ok" || msg.success === true))
          ) {
            if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
            sendSubscribe(ws);
            return;
          }

          // Skip subscription confirmations and pongs
          if (
            msg.type === "subscribed" ||
            msg.type === "subscribe_ok" ||
            msg.type === "pong"
          ) {
            return;
          }

          onMessageRef.current?.(msg);
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        if (\!mounted.current) return;
        setStatus("error");
        ws.close(); // triggers onclose -> reconnect
      };

      ws.onclose = () => {
        if (\!mounted.current) return;
        setStatus("disconnected");
        wsRef.current = null;
        subscribedRef.current = false;

        // Clear keepalive and fallback timers
        if (fallbackTimer.current) { clearTimeout(fallbackTimer.current); fallbackTimer.current = null; }
        if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }

        if (autoReconnect) {
          const delay = reconnectDelayRef.current;
          console.log(`[WS] closed, reconnecting in ${delay}ms`);
          reconnectTimer.current = setTimeout(() => {
            reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
            setReconnectCount((c) => c + 1);
            connect();
          }, delay);
        }
      };
    } catch {
      setStatus("error");
      if (autoReconnect) {
        const delay = reconnectDelayRef.current;
        reconnectTimer.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY);
          setReconnectCount((c) => c + 1);
          connect();
        }, delay);
      }
    }
  }, [url, autoReconnect, sendSubscribe]);

  useEffect(() => {
    mounted.current = true;
    connect();
    return () => {
      mounted.current = false;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, send, reconnectCount };
}
