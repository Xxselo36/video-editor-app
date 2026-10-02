// /app/new: start a video — one start screen (UX6)
// (features/start/NewVideoPage).
import type { Metadata } from "next";
import { NewVideoPage } from "@/features/start/NewVideoPage";

export const metadata: Metadata = { title: "New video" };

export default function NewVideo() {
  return <NewVideoPage />;
}
