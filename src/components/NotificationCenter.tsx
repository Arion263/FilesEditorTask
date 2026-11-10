"use client";

import {
  type LiveQueryState,
  type SealedLiveQuery,
} from "@neon/realtime/client";
import { RealtimeProvider, useLiveQuery } from "@neon/realtime-react";
import { useRouter } from "next/navigation";
import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type AppNotification } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { getRealtimeClient } from "@/lib/realtime-client";
import type { RealtimeNotificationRow } from "@/lib/realtime-server";
import { useAuth } from "./AuthProvider";

function normalizeRow(row: RealtimeNotificationRow | AppNotification): AppNotification {
  const created =
    row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id,
    recipient_id: row.recipient_id,
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    actor_email: row.actor_email,
    document_id: row.document_id,
    document_title: row.document_title,
    role: row.role,
    is_read: Boolean(row.is_read),
    created_at: created,
  };
}

interface LiveSubscriberProps {
  sealedQuery: SealedLiveQuery<RealtimeNotificationRow>;
  refreshQuery: () => Promise<SealedLiveQuery<RealtimeNotificationRow>>;
  onRows: (rows: AppNotification[]) => void;
  onState: (state: LiveQueryState) => void;
}

function LiveNotificationSubscriber({
  sealedQuery,
  refreshQuery,
  onRows,
  onState,
}: LiveSubscriberProps) {
  const [query] = useState(sealedQuery);
  const { data, status, error, utils } = useLiveQuery(query, { refreshQuery });

  useEffect(() => {
    if (data !== undefined) {
      onRows(data.map(normalizeRow));
    }
  }, [data, onRows]);

  useEffect(() => {
    onState({ status, error } as LiveQueryState);
  }, [status, error, onState]);

  useEffect(() => {
    return utils.onUpdate((update) => {
      if (update.type === "changes") {
        console.debug(
          `[Neon Realtime WebSocket] Applied ${update.changes.length} change(s) from txids: ${update.batch.txids.join(", ")}`,
        );
      }
    });
  }, [utils]);

  return null;
}

class RealtimeErrorBoundary extends Component<
  { onError: (error: Error) => void; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { onError: (error: Error) => void; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("[Neon Realtime WebSocket ErrorBoundary]:", error);
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}

function RealtimeSubscriberRoot({
  realtimeUrl,
  sealedQuery,
  refreshQuery,
  onRows,
  onState,
}: {
  realtimeUrl: string;
  sealedQuery: SealedLiveQuery<RealtimeNotificationRow>;
  refreshQuery: () => Promise<SealedLiveQuery<RealtimeNotificationRow>>;
  onRows: (rows: AppNotification[]) => void;
  onState: (state: LiveQueryState) => void;
}) {
  const client = useMemo(() => getRealtimeClient(realtimeUrl), [realtimeUrl]);

  const handleBoundaryError = useCallback(
    (err: Error) => {
      onState({ status: "error", error: err } as LiveQueryState);
    },
    [onState],
  );

  return (
    <RealtimeErrorBoundary onError={handleBoundaryError}>
      <RealtimeProvider client={client}>
        <LiveNotificationSubscriber
          key={sealedQuery.queryFingerprint}
          sealedQuery={sealedQuery}
          refreshQuery={refreshQuery}
          onRows={onRows}
          onState={onState}
        />
      </RealtimeProvider>
    </RealtimeErrorBoundary>
  );
}

export function NotificationCenter() {
  const { user } = useAuth();
  const router = useRouter();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [sealedQuery, setSealedQuery] =
    useState<SealedLiveQuery<RealtimeNotificationRow> | null>(null);
  const [liveState, setLiveState] = useState<LiveQueryState>({
    status: "connecting",
    error: undefined,
  });
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [sealError, setSealError] = useState<string | null>(null);

  const seenIdsRef = useRef<Set<string> | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const realtimeUrl =
    process.env.NEXT_PUBLIC_NEON_REALTIME_URL ||
    (typeof window !== "undefined" ? (window as unknown as { __NEON_RT_URL?: string }).__NEON_RT_URL : undefined);

  // Directly fetch sealed query from Next.js serverless route
  const fetchSealedQuery = useCallback(async (userId: string): Promise<SealedLiveQuery<RealtimeNotificationRow>> => {
    const res = await fetch("/realtime/notifications/seal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || `Sealing failed with HTTP ${res.status}`);
    }

    const sealed = (await res.json()) as SealedLiveQuery<RealtimeNotificationRow>;
    console.log(
      `[Neon Realtime WebSocket] Query sealed successfully. Fingerprint: ${sealed.queryFingerprint.slice(0, 12)}... Expires in 60s`,
    );
    return sealed;
  }, []);

  // Connect WebSocket when user is authenticated
  const initWebSocketConnection = useCallback(async () => {
    if (!user) return;
    setSealError(null);
    try {
      const sealed = await fetchSealedQuery(user.id);
      setSealedQuery(sealed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to seal query";
      console.error("[Neon Realtime WebSocket] Error initiating connection:", msg);
      setSealError(msg);
    }
  }, [user, fetchSealedQuery]);

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      setSealedQuery(null);
      seenIdsRef.current = null;
      return;
    }
    initWebSocketConnection();
  }, [user, initWebSocketConnection]);

  // Handle incoming live rows from Neon Realtime WebSocket
  const handleLiveRows = useCallback((incoming: AppNotification[]) => {
    setNotifications(incoming);
    setLastSyncTime(new Date());

    if (seenIdsRef.current === null) {
      seenIdsRef.current = new Set(incoming.map((n) => n.id));
      return;
    }

    const newlyArrived: AppNotification[] = [];
    for (const item of incoming) {
      if (!seenIdsRef.current.has(item.id)) {
        seenIdsRef.current.add(item.id);
        if (!item.is_read) {
          newlyArrived.push(item);
        }
      }
    }

    if (newlyArrived.length > 0) {
      console.log(`[Neon Realtime WebSocket] Received ${newlyArrived.length} new notification(s) in real time:`, newlyArrived);
      setToasts((prev) => [...newlyArrived, ...prev].slice(0, 4));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("fe:document-shared", { detail: newlyArrived }));
      }
    }
  }, []);

  const handleStateChange = useCallback((state: LiveQueryState) => {
    setLiveState(state);
    console.log(`[Neon Realtime WebSocket] Connection status: ${state.status}`, state);
  }, []);

  const refreshQuery = useCallback(async () => {
    if (!user) throw new Error("No active user session");
    return fetchSealedQuery(user.id);
  }, [user, fetchSealedQuery]);

  // Auto-dismiss toasts after 7 seconds
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      setToasts((prev) => prev.slice(1));
    }, 7000);
    return () => clearTimeout(timer);
  }, [toasts]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  // Direct Next.js -> Neon Postgres mutations (Zero Flask API calls)
  async function markRead(notif: AppNotification) {
    if (!user) return;
    setNotifications((prev) =>
      prev.map((n) => (n.id === notif.id ? { ...n, is_read: true } : n)),
    );
    setToasts((prev) => prev.filter((t) => t.id !== notif.id));
    try {
      await fetch("/realtime/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: notif.id, userId: user.id }),
      });
    } catch (err) {
      console.warn("Optimistic update error:", err);
    }
  }

  async function openSharedDocument(notif: AppNotification) {
    await markRead(notif);
    setOpen(false);
    router.push(`/documents/${notif.document_id}`);
  }

  async function markAllRead() {
    if (!user) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setToasts([]);
    try {
      await fetch("/realtime/notifications/read-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
    } catch (err) {
      console.warn("Optimistic update error:", err);
    }
  }

  async function removeNotification(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!user) return;
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setToasts((prev) => prev.filter((t) => t.id !== id));
    try {
      await fetch("/realtime/notifications/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, userId: user.id }),
      });
    } catch (err) {
      console.warn("Optimistic update error:", err);
    }
  }

  if (!user) return null;

  const unreadCount = notifications.filter((n) => !n.is_read).length;
  const isLive = liveState.status === "live";
  const isConnecting = liveState.status === "connecting";
  const isError = liveState.status === "error" || Boolean(sealError);

  return (
    <>
      {/* Realtime WebSocket client directly connected to Neon */}
      {sealedQuery && realtimeUrl && (
        <RealtimeSubscriberRoot
          realtimeUrl={realtimeUrl}
          sealedQuery={sealedQuery}
          refreshQuery={refreshQuery}
          onRows={handleLiveRows}
          onState={handleStateChange}
        />
      )}

      <div className="relative" ref={dropdownRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Notifications"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          title={`Notifications — Neon Realtime WebSocket: ${liveState.status}`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>

          {/* Unread badge */}
          {unreadCount > 0 && (
            <span
              data-testid="notification-badge"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold text-white shadow-sm"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}

          {/* Realtime status dot */}
          {unreadCount === 0 && (
            <span
              className={`absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full ring-2 ring-white ${
                isLive
                  ? "bg-emerald-500"
                  : isConnecting
                  ? "bg-amber-400 animate-pulse"
                  : "bg-red-400"
              }`}
              title={`Neon Realtime: ${liveState.status}`}
            />
          )}
        </button>

        {open && (
          <>
            {/* Mobile backdrop */}
            <div
              className="fixed inset-0 z-40 bg-slate-900/10 backdrop-blur-[1px] sm:hidden"
              onClick={() => setOpen(false)}
            />
            <div
              role="dialog"
              aria-label="Notifications list"
              className="fixed inset-x-3 top-16 z-50 overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-2xl transition-all sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2.5 sm:w-96 sm:max-w-sm sm:rounded-xl"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 bg-slate-50/50">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">Notifications</h3>
                  {/* Status indicator button to toggle debug details */}
                  <button
                    type="button"
                    onClick={() => setShowDebug((v) => !v)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
                      isLive
                        ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : isConnecting
                        ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                        : "bg-red-50 text-red-700 hover:bg-red-100"
                    }`}
                    title="Click to view Neon Realtime WebSocket connection diagnostics"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isLive
                          ? "bg-emerald-500"
                          : isConnecting
                          ? "bg-amber-500 animate-pulse"
                          : "bg-red-500"
                      }`}
                    />
                    {isLive ? "Neon Live" : isConnecting ? "Connecting…" : "Offline"}
                  </button>
                </div>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={markAllRead}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Mark all as read
                  </button>
                )}
              </div>

              {/* Debug Panel (Expanded when status pill is clicked) */}
              {showDebug && (
                <div className="border-b border-slate-200 bg-slate-900 p-3 text-[11px] text-slate-300 font-mono">
                  <div className="flex items-center justify-between font-semibold text-slate-100 mb-1.5">
                    <span>Neon Realtime WebSocket Debug</span>
                    <button
                      type="button"
                      onClick={() => initWebSocketConnection()}
                      className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] text-white hover:bg-blue-500"
                    >
                      Reconnect
                    </button>
                  </div>
                  <div className="space-y-0.5 text-[10px]">
                    <div>
                      <span className="text-slate-400">Status: </span>
                      <span
                        className={
                          isLive
                            ? "text-emerald-400 font-bold"
                            : isConnecting
                            ? "text-amber-400"
                            : "text-red-400"
                        }
                      >
                        {liveState.status}
                      </span>
                    </div>
                    <div className="truncate" title={realtimeUrl}>
                      <span className="text-slate-400">Endpoint: </span>
                      {realtimeUrl ? realtimeUrl.replace(/^https?:\/\//, "wss://") : "Not configured"}
                    </div>
                    {sealedQuery && (
                      <div>
                        <span className="text-slate-400">Fingerprint: </span>
                        {sealedQuery.queryFingerprint.slice(0, 16)}…
                      </div>
                    )}
                    {lastSyncTime && (
                      <div>
                        <span className="text-slate-400">Last event: </span>
                        {lastSyncTime.toLocaleTimeString()}
                      </div>
                    )}
                    {sealError && (
                      <div className="text-red-300">
                        <span className="text-red-400">Error: </span>
                        {sealError}
                      </div>
                    )}
                    <div className="mt-1 pt-1 border-t border-slate-800 text-[9px] text-slate-400">
                      Logs: Open browser devtools console (F12) to see raw Neon Realtime protocol events.
                    </div>
                  </div>
                </div>
              )}

              {/* Notification list */}
              {notifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">
                  No notifications yet. When someone shares a document with you, it will appear here in real time via Neon Realtime WebSocket.
                </div>
              ) : (
                <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                  {notifications.map((n) => (
                    <li
                      key={n.id}
                      onClick={() => openSharedDocument(n)}
                      className={`group flex cursor-pointer items-start justify-between gap-3 px-4 py-3 transition hover:bg-slate-50 ${
                        !n.is_read ? "bg-blue-50/40" : ""
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-2.5">
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                            !n.is_read ? "bg-blue-600" : "bg-transparent"
                          }`}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-slate-800">
                            <span className="font-semibold text-slate-900">{n.actor_name}</span>{" "}
                            shared{" "}
                            <span className="font-semibold text-blue-700">
                              &ldquo;{n.document_title}&rdquo;
                            </span>{" "}
                            with you
                          </p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span
                              className={`badge ${
                                n.role === "editor"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-amber-50 text-amber-700"
                              }`}
                            >
                              {n.role === "editor" ? "Can edit" : "View only"}
                            </span>
                            <span className="text-[11px] text-slate-400">
                              {formatRelative(n.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label="Dismiss notification"
                        onClick={(e) => removeNotification(n.id, e)}
                        className="rounded px-1.5 py-0.5 text-xs text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {/* Real-time incoming toast notifications */}
      {toasts.length > 0 && (
        <div
          aria-live="polite"
          className="pointer-events-none fixed top-16 right-3 sm:right-6 z-50 flex w-[calc(100vw-1.5rem)] max-w-sm flex-col gap-2.5 transition-all"
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className="pointer-events-auto flex items-start justify-between gap-3 rounded-xl border border-blue-200/90 bg-white/95 p-4 shadow-xl ring-1 ring-black/5 backdrop-blur-md transition-all animate-in fade-in slide-in-from-top-2 duration-200"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-blue-600 animate-pulse" />
                  <p className="text-xs font-semibold text-blue-700">
                    New shared document
                  </p>
                </div>
                <p className="mt-1 text-sm text-slate-800">
                  <span className="font-semibold text-slate-900">{t.actor_name}</span> shared{" "}
                  <span className="font-semibold text-blue-700">&ldquo;{t.document_title}&rdquo;</span> with you (
                  {t.role === "editor" ? "Can edit" : "View only"}).
                </p>
                <div className="mt-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openSharedDocument(t)}
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-95"
                  >
                    Open document
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setToasts((prev) => prev.filter((item) => item.id !== t.id))
                    }
                    className="rounded-md px-2.5 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <button
                type="button"
                aria-label="Close toast"
                onClick={() =>
                  setToasts((prev) => prev.filter((item) => item.id !== t.id))
                }
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
