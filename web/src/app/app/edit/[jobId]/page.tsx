// /app/edit/[jobId]: the editor (features/editor/EditorRoute picks v1 or v2).
import type { Metadata } from "next";
import { EditorRoute } from "@/features/editor/EditorRoute";

export const metadata: Metadata = { title: "Editor" };

export default async function Edit({ params }: PageProps<"/app/edit/[jobId]">) {
  const { jobId } = await params;
  return <EditorRoute key={jobId} jobId={jobId} />;
}
