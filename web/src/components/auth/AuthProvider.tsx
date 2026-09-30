"use client";
import dynamic from "next/dynamic";
import { AUTH_ENABLED, AUTH_TEST } from "@/lib/auth";

// Separate chunks, only loaded when accounts are on (the mock only in
// test-auth builds: AUTH_TEST is a build-time constant).
const ClerkShell = dynamic(() => import("./ClerkShell"));
const MockAuthProvider = AUTH_TEST ? dynamic(() => import("./MockAuthProvider")) : null;

/** <ClerkProvider> around the app when accounts are on (the test-auth
 *  mock with NEXT_PUBLIC_AUTH_TEST=1); nothing otherwise. */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  if (MockAuthProvider) return <MockAuthProvider>{children}</MockAuthProvider>;
  return AUTH_ENABLED ? <ClerkShell>{children}</ClerkShell> : <>{children}</>;
}
