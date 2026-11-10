"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { useRequireAuth, useSessionGuard } from "@/components/AuthProvider";
import {
  api,
  type DocumentSummary,
  UPLOAD_ACCEPT,
  UPLOAD_HELP,
  validateUpload,
} from "@/lib/api";
import { errorMessage, formatRelative } from "@/lib/format";

export function Dashboard() {
  const { user, loading } = useRequireAuth();
  const handleSession = useSessionGuard();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  const [owned, setOwned] = useState<DocumentSummary[] | null>(null);
  const [shared, setShared] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "create" | "upload">(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listDocuments();
      setOwned(data.owned);
      setShared(data.shared);
      setError(null);
    } catch (err) {
      if (!handleSession(err)) setError(errorMessage(err, "Couldn't load your documents."));
    }
  }, [handleSession]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  async function createDoc() {
    setBusy("create");
    setError(null);
    try {
      const { document } = await api.createDocument();
      router.push(`/documents/${document.id}`);
    } catch (err) {
      if (!handleSession(err)) setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function uploadFile(file: File | undefined) {
    if (!file) return;
    const problem = validateUpload(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy("upload");
    setError(null);
    try {
      const { document } = await api.importDocument(file);
      router.push(`/documents/${document.id}`);
    } catch (err) {
      if (!handleSession(err)) setError(errorMessage(err));
      setBusy(null);
    }
  }

  async function deleteDoc(doc: DocumentSummary) {
    if (!window.confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    try {
      await api.deleteDocument(doc.id);
      setOwned((docs) => docs?.filter((d) => d.id !== doc.id) ?? null);
    } catch (err) {
      if (!handleSession(err)) setError(errorMessage(err));
    }
  }

  async function leaveDoc(doc: DocumentSummary) {
    if (!user || !window.confirm(`Remove "${doc.title}" from your shared documents?`)) return;
    try {
      await api.revokeShare(doc.id, user.id);
      setShared((docs) => docs?.filter((d) => d.id !== doc.id) ?? null);
    } catch (err) {
      if (!handleSession(err)) setError(errorMessage(err));
    }
  }

  if (loading || !user) return <FullPageSpinner />;

  return (
    <div
      className="min-h-screen bg-slate-50"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void uploadFile(e.dataTransfer.files?.[0]);
      }}
    >
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Documents</h1>
            <p className="mt-1 text-sm text-slate-500">Welcome back, {user.name}.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileInput.current?.click()}
              disabled={busy !== null}
              title={UPLOAD_HELP}
            >
              {busy === "upload" ? "Importing…" : "Upload file"}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={createDoc}
              disabled={busy !== null}
            >
              {busy === "create" ? "Creating…" : "+ New document"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void uploadFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <div
          className={`mt-6 rounded-xl border-2 border-dashed px-4 py-5 text-center text-sm transition ${
            dragging
              ? "border-blue-500 bg-blue-50 text-blue-700"
              : "border-slate-300 bg-white text-slate-500"
          }`}
        >
          <strong className="font-medium text-slate-700">Import a file as a new document</strong>
          {" — "}drop it anywhere on this page or use <em>Upload file</em>. {UPLOAD_HELP}.
        </div>

        {error && (
          <p role="alert" className="alert-error mt-4">
            {error}
          </p>
        )}

        <Section
          title="My documents"
          subtitle="Documents you own"
          docs={owned}
          empty="You don't own any documents yet. Create one or upload a file."
          render={(doc) => (
            <DocCard key={doc.id} doc={doc} onRemove={() => deleteDoc(doc)} removeLabel="Delete">
              <span className="badge bg-blue-50 text-blue-700">Owner</span>
              {doc.share_count ? (
                <span className="badge bg-slate-100 text-slate-600">
                  Shared with {doc.share_count}
                </span>
              ) : (
                <span className="badge bg-slate-100 text-slate-500">Private</span>
              )}
            </DocCard>
          )}
        />

        <Section
          title="Shared with me"
          subtitle="Documents other people gave you access to"
          docs={shared}
          empty="Nothing has been shared with you yet."
          render={(doc) => (
            <DocCard key={doc.id} doc={doc} onRemove={() => leaveDoc(doc)} removeLabel="Remove">
              <RoleBadge role={doc.role} />
              <span className="truncate text-xs text-slate-500" title={doc.owner?.email}>
                from {doc.owner?.name}
              </span>
            </DocCard>
          )}
        />
      </main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  docs,
  empty,
  render,
}: {
  title: string;
  subtitle: string;
  docs: DocumentSummary[] | null;
  empty: string;
  render: (doc: DocumentSummary) => React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className="text-sm text-slate-500">
          {subtitle}
          {docs ? ` · ${docs.length}` : ""}
        </span>
      </div>
      {docs === null ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-28 animate-pulse bg-slate-100" />
          ))}
        </div>
      ) : docs.length === 0 ? (
        <p className="card px-4 py-8 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{docs.map(render)}</div>
      )}
    </section>
  );
}

function DocCard({
  doc,
  children,
  onRemove,
  removeLabel,
}: {
  doc: DocumentSummary;
  children: React.ReactNode;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="card group relative flex flex-col p-4 transition hover:border-blue-300 hover:shadow-md">
      <Link
        href={`/documents/${doc.id}`}
        className="line-clamp-2 pr-14 font-medium text-slate-900 after:absolute after:inset-0"
      >
        {doc.title}
      </Link>
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      <p className="mt-auto pt-3 text-xs text-slate-400">Edited {formatRelative(doc.updated_at)}</p>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-3 top-3 z-10 rounded px-2 py-1 text-xs text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
      >
        {removeLabel}
      </button>
    </div>
  );
}

export function RoleBadge({ role }: { role: DocumentSummary["role"] }) {
  if (role === "owner") return <span className="badge bg-blue-50 text-blue-700">Owner</span>;
  if (role === "editor")
    return <span className="badge bg-emerald-50 text-emerald-700">Can edit</span>;
  return <span className="badge bg-amber-50 text-amber-700">View only</span>;
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
    </div>
  );
}
