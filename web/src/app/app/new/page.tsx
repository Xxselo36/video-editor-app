// /app/new: start a video — workflow picker, file, settings
// (features/start/NewVideoPage).
import type { Metadata } from "next";
import { NewVideoPage } from "@/features/start/NewVideoPage";

export const metadata: Metadata = { title: "New video" };

export default function NewVideo() {
  return <NewVideoPage />;
}
