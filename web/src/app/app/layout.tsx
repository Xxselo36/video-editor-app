import { AUTH_ENABLED } from "@/lib/auth";
import { AppGate } from "@/components/auth/AppGate";
import { SiteFooter } from "@/components/site/SiteFooter";

// /app, /app/library, /app/account. With accounts off the gate adds
// nothing: the editor stays open to everyone, exactly as in the beta.
// The legal footer sits below every app screen (and below the sign-in
// gate), so imprint and privacy are always one click away.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {AUTH_ENABLED ? <AppGate>{children}</AppGate> : children}
      <SiteFooter />
    </>
  );
}
