// /app/preview: the Vorschau tab (features/project/PreviewRoute).
import type { Metadata } from "next";
import { PreviewRoute } from "@/features/project/PreviewRoute";

export const metadata: Metadata = { title: "Preview" };

export default function Preview() {
  return <PreviewRoute />;
}
