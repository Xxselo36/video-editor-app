// The app's screens in the shell (components/shell/AppShell): Projekte
// (/app), Neues Video (/app/new), a project's Vorschau (/app/p/[jobId]),
// the Vorschau tab (/app/preview), Einstellungen (/app/settings), the
// account (/app/account) and the library's redirect (/app/library). A
// layout keeps the menu mounted from one screen to the next; the editor
// (/app/edit) is outside it, full screen.
import { AppShell } from "@/components/shell/AppShell";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
