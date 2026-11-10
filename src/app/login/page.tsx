"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "@/components/AuthProvider";
import { api, type DemoAccount } from "@/lib/api";
import { errorMessage } from "@/lib/format";

type Mode = "login" | "register";

export default function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [demo, setDemo] = useState<DemoAccount[]>([]);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  useEffect(() => {
    api
      .demoAccounts()
      .then(({ accounts }) => setDemo(accounts))
      .catch(() => setDemo([]));
  }, []);

  async function signIn(e: string, p: string) {
    setSubmitting(true);
    setError(null);
    try {
      const { user } = await api.login(e, p);
      setUser(user);
      router.replace("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (mode === "login") return signIn(email, password);
    setSubmitting(true);
    setError(null);
    try {
      const { user } = await api.register(name, email, password);
      setUser(user);
      router.replace("/");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-blue-600 text-xl font-bold text-white">
            F
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">Files Editor</h1>
          <p className="mt-1 text-sm text-slate-500">
            Write, import and share rich-text documents.
          </p>
        </div>

        <div className="card p-6">
          <div className="mb-5 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`rounded-md py-1.5 transition ${
                  mode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                }`}
              >
                {m === "login" ? "Sign in" : "Create account"}
              </button>
            ))}
          </div>

          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {mode === "register" && (
              <label className="block">
                <span className="label">Name</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                  autoComplete="name"
                />
              </label>
            )}
            <label className="block">
              <span className="label">Email</span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="block">
              <span className="label">Password</span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={mode === "register" ? 8 : undefined}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
              />
              {mode === "register" && (
                <span className="mt-1 block text-xs text-slate-500">At least 8 characters.</span>
              )}
            </label>

            {error && (
              <p role="alert" className="alert-error">
                {error}
              </p>
            )}

            <button type="submit" className="btn-primary w-full" disabled={submitting}>
              {submitting ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        </div>

        {demo.length > 0 && (
          <div className="card mt-4 p-5">
            <h2 className="text-sm font-semibold text-slate-800">Demo accounts</h2>
            <p className="mt-1 text-xs text-slate-500">
              One click to sign in. Use two browsers (or a private window) to try sharing between
              users. Password for all: <code className="rounded bg-slate-100 px-1">{demo[0].password}</code>
            </p>
            <ul className="mt-3 space-y-2">
              {demo.map((acc) => (
                <li key={acc.email}>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => signIn(acc.email, acc.password)}
                    className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm transition hover:border-blue-400 hover:bg-blue-50"
                  >
                    <span className="font-medium text-slate-800">{acc.name}</span>
                    <span className="text-slate-500">{acc.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
