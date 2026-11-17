// /app/p/[jobId]: one project, by its status (features/project/ProjectPage).
import type { Metadata } from "next";
import { ProjectPage } from "@/features/project/ProjectPage";

export const metadata: Metadata = { title: "Project" };

export default async function Project({ params }: PageProps<"/app/p/[jobId]">) {
  const { jobId } = await params;
  return <ProjectPage key={jobId} jobId={jobId} />;
}
