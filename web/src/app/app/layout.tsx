import { AUTH_ENABLED } from "@/lib/auth";
import { AppGate } from "@/components/auth/AppGate";

// /app, /app/library, /app/account. With accounts off this adds nothing:
// the editor stays open to everyone, exactly as in the beta.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return AUTH_ENABLED ? <AppGate>{children}</AppGate> : children;
}
