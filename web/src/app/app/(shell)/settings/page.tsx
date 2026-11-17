// /app/settings: Einstellungen (features/settings/SettingsPage).
import type { Metadata } from "next";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const metadata: Metadata = { title: "Settings" };

export default function Settings() {
  return <SettingsPage />;
}
