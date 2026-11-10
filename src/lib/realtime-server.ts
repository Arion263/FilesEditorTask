import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { createRealtime, rawSql, type SealedLiveQuery } from "@neon/realtime/server";

export interface RealtimeNotificationRow {
  id: string;
  recipient_id: string;
  actor_id: string;
  actor_name: string;
  actor_email: string;
  document_id: string;
  document_title: string;
  role: "viewer" | "editor";
  is_read: boolean;
  created_at: Date | string;
}

/** Extract the Postgres database name from DATABASE_URL (defaults to 'neondb'). */
export function resolveDatabaseName(): string {
  if (process.env.NEON_REALTIME_DB) {
    return process.env.NEON_REALTIME_DB;
  }
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (dbUrl) {
    try {
      const parsed = new URL(dbUrl);
      const name = parsed.pathname.replace(/^\/+/, "");
      if (name) return name;
    } catch {
      // Fallback to default
    }
  }
  return "neondb";
}

/** Get direct Neon serverless SQL client for database updates in Next.js. */
export function getNeonSql(): NeonQueryFunction<false, false> {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not configured.");
  }
  return neon(url);
}

/**
 * Deterministic, read-only live SQL query for a user's document share notifications.
 * Uses $1 parameter binding to prevent SQL injection and authorize per recipient_id.
 */
export function notificationsLiveQuery(userId: string) {
  return rawSql<RealtimeNotificationRow>(
    `SELECT id, recipient_id, actor_id, actor_name, actor_email, document_id, document_title, role, is_read, created_at
     FROM notifications
     WHERE recipient_id = $1
     ORDER BY created_at DESC
     LIMIT 30`,
    [userId],
  );
}

/** Seal the user's notifications live query using NEON_REALTIME_SECRET directly in Next.js. */
export async function sealNotificationsQuery(
  userId: string,
): Promise<SealedLiveQuery<RealtimeNotificationRow>> {
  const secret = process.env.NEON_REALTIME_SECRET;
  if (!secret) {
    throw new Error("NEON_REALTIME_SECRET is not configured.");
  }
  const realtime = createRealtime({
    secret,
    db: resolveDatabaseName(),
    debugMode: process.env.NODE_ENV === "development",
  });
  return realtime.seal({ query: notificationsLiveQuery(userId) });
}

/** Direct Neon Postgres mutation: mark notification as read. */
export async function markNotificationAsReadDirect(
  id: string,
  userId: string,
): Promise<string | null> {
  const sql = getNeonSql();
  const rows = (await sql.query(
    `UPDATE notifications
     SET is_read = true
     WHERE id = $1 AND recipient_id = $2
     RETURNING pg_current_xact_id()::text AS txid`,
    [id, userId],
  )) as Array<{ txid: string }>;
  return rows[0]?.txid || null;
}

/** Direct Neon Postgres mutation: mark all notifications as read. */
export async function markAllNotificationsAsReadDirect(
  userId: string,
): Promise<string | null> {
  const sql = getNeonSql();
  const rows = (await sql.query(
    `UPDATE notifications
     SET is_read = true
     WHERE recipient_id = $1 AND is_read = false
     RETURNING pg_current_xact_id()::text AS txid`,
    [userId],
  )) as Array<{ txid: string }>;
  return rows[0]?.txid || null;
}

/** Direct Neon Postgres mutation: delete/dismiss notification. */
export async function deleteNotificationDirect(
  id: string,
  userId: string,
): Promise<void> {
  const sql = getNeonSql();
  await sql.query(
    `DELETE FROM notifications
     WHERE id = $1 AND recipient_id = $2`,
    [id, userId],
  );
}
