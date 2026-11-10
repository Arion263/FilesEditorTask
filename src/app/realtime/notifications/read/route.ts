import { markNotificationAsReadDirect } from "@/lib/realtime-server";

export async function POST(request: Request) {
  let body: { id?: string; userId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body
  }

  const { id, userId } = body;
  if (!id || !userId) {
    return Response.json(
      { error: { code: "bad_request", message: "id and userId are required." } },
      { status: 400 },
    );
  }

  try {
    const txid = await markNotificationAsReadDirect(id, userId);
    return Response.json({ ok: true, txid });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Database error";
    return Response.json({ error: { message } }, { status: 500 });
  }
}
