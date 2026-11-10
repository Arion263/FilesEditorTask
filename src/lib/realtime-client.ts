"use client";

import { createRealtimeClient, type RealtimeClient } from "@neon/realtime/client";

/**
 * Singleton instance of the Neon Realtime WebSocket client.
 *
 * Neon's RealtimeClient coordinates a persistent WebSocket connection that multiplexes
 * all live query subscriptions. Disposing or recreating the client eagerly on React
 * re-renders causes `Error: Realtime client is closed`.
 *
 * This singleton ensures the client stays open across component lifecycles, route
 * changes, and React StrictMode mount/unmount cycles.
 */
let sharedClient: RealtimeClient | null = null;
let sharedUrl: string | null = null;

export function getRealtimeClient(url: string): RealtimeClient {
  const isDisposed = Boolean(
    sharedClient &&
      (sharedClient as unknown as { disposed?: boolean }).disposed,
  );

  if (sharedClient && sharedUrl === url && !isDisposed) {
    return sharedClient;
  }

  // If URL changed or previous instance was disposed, create a fresh one
  console.log(`[Neon Realtime WebSocket] Initializing persistent connection to: ${url}`);
  sharedClient = createRealtimeClient({
    url,
    logLevel: "debug",
    logger: (entry) => {
      const prefix = `[Neon Realtime WebSocket ${entry.level.toUpperCase()}]`;
      if (entry.level === "error") {
        console.error(`${prefix} ${entry.event}: ${entry.message}`, entry);
      } else if (entry.level === "warn") {
        console.warn(`${prefix} ${entry.event}: ${entry.message}`, entry);
      } else {
        console.log(`${prefix} ${entry.event}: ${entry.message}`, entry);
      }
    },
  });
  sharedUrl = url;

  return sharedClient;
}
