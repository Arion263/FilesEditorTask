"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { useAuth } from "./AuthProvider";
import { NotificationCenter } from "./NotificationCenter";

export function AppHeader({ children }: { children?: React.ReactNode }) {
  const { user, logout } = useAuth();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-blue-600 text-sm text-white">
            F
          </span>
          <span className="hidden sm:inline">Files Editor</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
        {user && (
          <div className="flex items-center gap-3 text-sm">
            <NotificationCenter />
            <span className="hidden text-slate-600 md:inline" title={user.email}>
              {user.name}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={async () => {
                await logout();
                router.replace("/login");
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
