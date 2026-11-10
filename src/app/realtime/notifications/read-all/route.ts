import { markAllNotificationsAsReadDirect } from "@/lib/realtime-server";

export async function POST(request: Request) {
  let body: { userId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body
  }

  const { userId } = body;
  if (!userId) {
    return Response.json(
      { error: { code: "bad_request", message: "userId is required." } },
      { status: 400 },
    );
  }

  try {
    const txid = await markAllNotificationsAsReadDirect(userId);
    return Response.json({ ok: true, txid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database error";
    return Response.json({ error: { message } }, { status: 500 });
  }
}
