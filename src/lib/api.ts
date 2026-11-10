/**
 * Typed client for the Flask API (served under /api by Vercel's Python runtime,
 * proxied to the local Flask dev server by next.config.ts in development).
 */

export type Role = "owner" | "editor" | "viewer";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Share {
  user: User;
  role: Exclude<Role, "owner">;
  created_at: string;
}

export interface Folder {
  id: string;
  name: string;
  created_at?: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  updated_at: string;
  role: Role;
  folder_id?: string | null;
  folder_name?: string | null;
  share_count?: number;
  owner?: User;
}

export interface DocumentDetail {
  id: string;
  title: string;
  content: string;
  version: number;
  folder_id?: string | null;
  folder_name?: string | null;
  created_at: string;
  updated_at: string;
  role: Role;
  owner: User;
  shares?: Share[];
}

export interface DemoAccount {
  email: string;
  name: string;
  password: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Upload limits mirrored from server/config.py so the UI can fail fast. */
export const SUPPORTED_UPLOAD_EXTENSIONS = [".txt", ".md", ".markdown", ".docx"];
export const UPLOAD_ACCEPT = SUPPORTED_UPLOAD_EXTENSIONS.join(",");
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const UPLOAD_HELP = "Supported: .txt, .md, .docx (max 4 MB)";

export function validateUpload(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!SUPPORTED_UPLOAD_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    return `Unsupported file type. ${UPLOAD_HELP}.`;
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is larger than 4 MB.";
  return null;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers:
        init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json", ...init.headers }
          : init.headers,
    });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the server. Check your connection.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? "http_error",
      err?.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

function fileForm(file: File) {
  const form = new FormData();
  form.append("file", file);
  return form;
}

export const api = {
  me: () => request<{ user: User }>("/auth/me"),
  demoAccounts: () => request<{ accounts: DemoAccount[] }>("/auth/demo-accounts"),
  login: (email: string, password: string) =>
    request<{ user: User }>("/auth/login", { method: "POST", body: json({ email, password }) }),
  register: (name: string, email: string, password: string) =>
    request<{ user: User }>("/auth/register", {
      method: "POST",
      body: json({ name, email, password }),
    }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  listDocuments: () =>
    request<{ folders: Folder[]; owned: DocumentSummary[]; shared: DocumentSummary[] }>("/documents"),
  createDocument: (title?: string, folder_id?: string) =>
    request<{ document: DocumentDetail }>("/documents", {
      method: "POST",
      body: json({ ...(title ? { title } : {}), ...(folder_id ? { folder_id } : {}) }),
    }),
  createFolder: (name: string) =>
    request<{ folder: Folder }>("/folders", {
      method: "POST",
      body: json({ name }),
    }),
  deleteFolder: (id: string) => request<void>(`/folders/${id}`, { method: "DELETE" }),
  getDocument: (id: string) => request<{ document: DocumentDetail }>(`/documents/${id}`),
  updateDocument: (
    id: string,
    changes: { title?: string; content?: string; folder_id?: string | null; base_version: number },
  ) =>
    request<{ document: DocumentDetail }>(`/documents/${id}`, {
      method: "PATCH",
      body: json(changes),
    }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),

  share: (id: string, email: string, role: "viewer" | "editor") =>
    request<{ shares: Share[] }>(`/documents/${id}/shares`, {
      method: "POST",
      body: json({ email, role }),
    }),
  revokeShare: (id: string, userId: string) =>
    request<{ shares: Share[] }>(`/documents/${id}/shares/${userId}`, { method: "DELETE" }),

  importDocument: (file: File) =>
    request<{ document: DocumentDetail }>("/documents/import", {
      method: "POST",
      body: fileForm(file),
    }),
  convertFile: (file: File, docId?: string) =>
    request<{ title: string; html: string }>(
      docId ? `/convert?doc_id=${encodeURIComponent(docId)}` : "/convert",
      { method: "POST", body: fileForm(file) },
    ),
};
