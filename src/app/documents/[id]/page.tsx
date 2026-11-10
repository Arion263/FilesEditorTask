"use client";

import type { Editor } from "@tiptap/react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { AppHeader } from "@/components/AppHeader";
import { useRequireAuth, useSessionGuard } from "@/components/AuthProvider";
import { FullPageSpinner, RoleBadge } from "@/components/Dashboard";
import { RichTextEditor } from "@/components/RichTextEditor";
import { ShareModal } from "@/components/ShareModal";
import {
  api,
  ApiError,
  type DocumentDetail,
  UPLOAD_ACCEPT,
  UPLOAD_HELP,
  validateUpload,
} from "@/lib/api";
import { errorMessage, formatRelative } from "@/lib/format";

type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading: authLoading } = useRequireAuth();
  const handleSession = useSessionGuard();

  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [banner, setBanner] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const editorRef = useRef<Editor | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  // Keep latest values in refs so the debounced/Ctrl+S save always sees them.
  const latestRef = useRef({ title: "", content: "", version: 1, dirty: false, saving: false });

  const applyServerDoc = useCallback((d: DocumentDetail, remountEditor = false) => {
    setDoc(d);
    setTitle(d.title);
    latestRef.current = {
      title: d.title,
      content: d.content,
      version: d.version,
      dirty: false,
      saving: false,
    };
    setSaveState("saved");
    setBanner(null);
    if (remountEditor) setEditorKey((k) => k + 1);
  }, []);

  const loadDoc = useCallback(
    async (remountEditor = false) => {
      try {
        const { document } = await api.getDocument(id);
        applyServerDoc(document, remountEditor);
        setLoadError(null);
      } catch (err) {
        if (!handleSession(err)) setLoadError(errorMessage(err, "Document not found."));
      }
    },
    [id, applyServerDoc, handleSession],
  );

  useEffect(() => {
    if (user) void loadDoc(true);
  }, [user, loadDoc]);

  const editable = doc ? doc.role === "owner" || doc.role === "editor" : false;

  const saveNow = useCallback(async () => {
    if (!doc || !editable) return;
    const snap = latestRef.current;
    if (snap.saving || !snap.dirty) return;
    const cleanTitle = snap.title.trim() || "Untitled document";
    snap.saving = true;
    setSaveState("saving");
    setBanner(null);
    try {
      const { document: saved } = await api.updateDocument(doc.id, {
        title: cleanTitle,
        content: snap.content,
        base_version: snap.version,
      });
      snap.version = saved.version;
      // Only clear dirty if the user didn't keep typing while the request was in flight.
      const stillMatches =
        (latestRef.current.title.trim() || "Untitled document") === cleanTitle &&
        latestRef.current.content === snap.content;
      snap.dirty = !stillMatches;
      snap.saving = false;
      setDoc((prev) => (prev ? { ...saved, shares: prev.shares ?? saved.shares } : saved));
      setSaveState(stillMatches ? "saved" : "dirty");
    } catch (err) {
      snap.saving = false;
      if (handleSession(err)) return;
      if (err instanceof ApiError && err.code === "version_conflict") {
        setSaveState("conflict");
        setBanner(err.message);
      } else {
        setSaveState("error");
        setBanner(errorMessage(err, "Couldn't save changes."));
      }
    }
  }, [doc, editable, handleSession]);

  // Autosave 900ms after the user stops typing.
  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = window.setTimeout(() => void saveNow(), 900);
    return () => window.clearTimeout(timer);
  }, [saveState, saveNow, title]);

  // Ctrl/Cmd+S saves immediately; warn before closing tab with unsaved edits.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveNow();
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (latestRef.current.dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [saveNow]);

  function onTitleChange(next: string) {
    setTitle(next);
    latestRef.current.title = next;
    latestRef.current.dirty = true;
    setSaveState("dirty");
  }

  function onContentChange(html: string) {
    if (html === latestRef.current.content) return;
    latestRef.current.content = html;
    latestRef.current.dirty = true;
    setSaveState("dirty");
  }

  async function importIntoDraft(file: File | undefined) {
    if (!file || !editorRef.current) return;
    const problem = validateUpload(file);
    if (problem) {
      setBanner(problem);
      return;
    }
    setBanner(null);
    try {
      const { html } = await api.convertFile(file);
      editorRef.current.chain().focus().insertContent(html).run();
    } catch (err) {
      if (!handleSession(err)) setBanner(errorMessage(err));
    }
  }

  if (authLoading || (!doc && !loadError)) return <FullPageSpinner />;

  if (loadError || !doc) {
    return (
      <div className="min-h-screen bg-slate-50">
        <AppHeader />
        <main className="mx-auto max-w-lg px-4 py-16 text-center">
          <div className="card p-8">
            <h1 className="text-lg font-semibold text-slate-900">Can&apos;t open document</h1>
            <p className="mt-2 text-sm text-slate-500">{loadError}</p>
            <Link href="/" className="btn-primary mt-5 inline-flex">
              Back to documents
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-100">
      <AppHeader>
        <input
          aria-label="Document title"
          value={title}
          disabled={!editable}
          maxLength={200}
          placeholder="Untitled document"
          onChange={(e) => onTitleChange(e.target.value)}
          onBlur={() => {
            if (!title.trim()) onTitleChange("Untitled document");
            void saveNow();
          }}
          className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-base font-medium text-slate-900 hover:border-slate-200 focus:border-blue-500 focus:bg-white focus:outline-none disabled:hover:border-transparent"
        />
        <RoleBadge role={doc.role} />
        <SaveIndicator state={saveState} updatedAt={doc.updated_at} onSave={() => void saveNow()} />
        {doc.role === "owner" && (
          <button type="button" className="btn-primary" onClick={() => setShareOpen(true)}>
            Share{doc.shares?.length ? ` (${doc.shares.length})` : ""}
          </button>
        )}
      </AppHeader>

      {!editable && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs text-amber-800">
          Shared with you by <strong>{doc.owner.name}</strong> ({doc.owner.email}) — view only.
        </div>
      )}
      {doc.role === "editor" && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-1.5 text-center text-xs text-emerald-800">
          Owned by <strong>{doc.owner.name}</strong> ({doc.owner.email}) — you have edit access.
        </div>
      )}
      {banner && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-center gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700"
        >
          <span>{banner}</span>
          {saveState === "conflict" && (
            <button
              type="button"
              onClick={() => void loadDoc(true)}
              className="rounded bg-red-600 px-2.5 py-1 font-medium text-white hover:bg-red-700"
            >
              Reload latest version
            </button>
          )}
        </div>
      )}

      <RichTextEditor
        key={editorKey}
        initialContent={doc.content}
        editable={editable}
        onChange={onContentChange}
        onReady={(e) => {
          editorRef.current = e;
        }}
        toolbarExtras={
          <>
            <button
              type="button"
              onClick={() => importInput.current?.click()}
              title={`Insert content from a file into this document. ${UPLOAD_HELP}`}
              className="rounded-md px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              Insert from file…
            </button>
            <input
              ref={importInput}
              type="file"
              accept={UPLOAD_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void importIntoDraft(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </>
        }
      />

      {shareOpen && doc.role === "owner" && (
        <ShareModal
          docId={doc.id}
          owner={doc.owner}
          shares={doc.shares ?? []}
          onSharesChange={(shares) => setDoc((d) => (d ? { ...d, shares } : d))}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

function SaveIndicator({
  state,
  updatedAt,
  onSave,
}: {
  state: SaveState;
  updatedAt: string;
  onSave: () => void;
}) {
  if (state === "saving") return <span className="text-xs text-slate-500">Saving…</span>;
  if (state === "dirty")
    return (
      <button
        type="button"
        onClick={onSave}
        className="text-xs font-medium text-blue-600 hover:underline"
        title="Ctrl+S to save now"
      >
        Save now
      </button>
    );
  if (state === "conflict")
    return <span className="text-xs font-medium text-red-600">Conflict</span>;
  if (state === "error")
    return (
      <button type="button" onClick={onSave} className="text-xs font-medium text-red-600 underline">
        Retry save
      </button>
    );
  return (
    <span className="hidden text-xs text-slate-400 sm:inline" title={updatedAt}>
      Saved {formatRelative(updatedAt)}
    </span>
  );
}
