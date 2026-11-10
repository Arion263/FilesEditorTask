import { sealNotificationsQuery } from "@/lib/realtime-server";

export async function POST(request: Request) {
  let body: { userId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body
  }

  const userId = body.userId;
  if (!userId) {
    return Response.json(
      { error: { code: "missing_user", message: "userId is required to seal the query." } },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (!process.env.NEON_REALTIME_SECRET) {
    return Response.json(
      { error: { code: "realtime_not_configured", message: "Neon Realtime is not configured." } },
      { status: 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const sealedQuery = await sealNotificationsQuery(userId);
    return Response.json(sealedQuery, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not seal live query.";
    return Response.json(
      { error: { code: "seal_failed", message } },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
