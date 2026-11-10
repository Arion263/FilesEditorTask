"use client";

import { useEffect, useState } from "react";

import { api, type Share, type User } from "@/lib/api";
import { errorMessage } from "@/lib/format";

interface Props {
  docId: string;
  owner: User;
  shares: Share[];
  onSharesChange: (shares: Share[]) => void;
  onClose: () => void;
}

export function ShareModal({ docId, owner, shares, onSharesChange, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    api
      .demoAccounts()
      .then(({ accounts }) =>
        setSuggestions(
          accounts.map((a) => a.email).filter((e) => e !== owner.email),
        ),
      )
      .catch(() => setSuggestions([]));
  }, [owner.email]);

  async function addShare(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { shares: next } = await api.share(docId, email, role);
      onSharesChange(next);
      setEmail("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateRole(targetEmail: string, nextRole: "viewer" | "editor") {
    setBusy(true);
    setError(null);
    try {
      const { shares: next } = await api.share(docId, targetEmail, nextRole);
      onSharesChange(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(userId: string) {
    setBusy(true);
    setError(null);
    try {
      const { shares: next } = await api.revokeShare(docId, userId);
      onSharesChange(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const unsharedSuggestions = suggestions.filter(
    (s) => !shares.some((sh) => sh.user.email === s),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="card w-full max-w-lg p-6 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="share-dialog-title" className="text-lg font-semibold text-slate-900">
              Share document
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Grant view or edit access to another registered account.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <form onSubmit={addShare} className="mt-4 flex flex-wrap gap-2">
          <input
            type="email"
            placeholder="Collaborator's email (e.g. bob@example.com)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input min-w-0 flex-1"
          />
          <select
            aria-label="Access role"
            value={role}
            onChange={(e) => setRole(e.target.value as "viewer" | "editor")}
            className="input w-auto"
          >
            <option value="editor">Can edit</option>
            <option value="viewer">View only</option>
          </select>
          <button type="submit" className="btn-primary" disabled={busy}>
            Share
          </button>
        </form>

        {unsharedSuggestions.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
            <span>Demo users:</span>
            {unsharedSuggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setEmail(s)}
                className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-slate-700 hover:border-blue-300 hover:bg-blue-50"
              >
                + {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="alert-error mt-3">
            {error}
          </p>
        )}

        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            People with access
          </h3>
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-900">{owner.name} (you)</p>
                <p className="truncate text-xs text-slate-500">{owner.email}</p>
              </div>
              <span className="badge bg-blue-50 text-blue-700">Owner</span>
            </li>
            {shares.map((sh) => (
              <li
                key={sh.user.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900">{sh.user.name}</p>
                  <p className="truncate text-xs text-slate-500">{sh.user.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Role for ${sh.user.email}`}
                    value={sh.role}
                    disabled={busy}
                    onChange={(e) =>
                      updateRole(sh.user.email, e.target.value as "viewer" | "editor")
                    }
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700"
                  >
                    <option value="editor">Can edit</option>
                    <option value="viewer">View only</option>
                  </select>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => revoke(sh.user.id)}
                    className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-red-50 hover:text-red-600"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
