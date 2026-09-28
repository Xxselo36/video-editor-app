"use client";
import dynamic from "next/dynamic";
import { AUTH_ENABLED } from "@/lib/auth";

// Separate chunk, only loaded when accounts are on.
const ClerkShell = dynamic(() => import("./ClerkShell"));

/** <ClerkProvider> around the app when accounts are on; nothing otherwise. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  return AUTH_ENABLED ? <ClerkShell>{children}</ClerkShell> : <>{children}</>;
}
