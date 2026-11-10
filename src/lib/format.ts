export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)} d ago`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
