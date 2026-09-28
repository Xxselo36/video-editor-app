"use client";
import { SignIn, SignUp } from "@clerk/nextjs";

// Path routing under the /sign-in and /sign-up catch-all routes. The
// ?redirect_url= set by AppGate / the pricing page is honoured by Clerk.
export default function ClerkAuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  return mode === "sign-in" ? <SignIn /> : <SignUp />;
}
