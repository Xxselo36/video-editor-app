"use client";
/**
 * The UX12 gate of /app (./LibraryRoute: /app/library): the v2 Projects page on the v2
 * opt-in, the dashboard and library of before for everyone else
 * (./useProjectsV2). The Projects page is its own chunk: browsers off
 * the opt-in never load it. Every variant starts with the same skeleton,
 * so the first paint never shows the picker.
 */
import dynamic from "next/dynamic";
import { AppPage } from "@/components/AppPage";
import { DashboardPage, DashboardSkeleton } from "./DashboardPage";
import { useProjectsV2 } from "./useProjectsV2";

function Skeleton() {
  return (
    <AppPage width="2xl">
      <DashboardSkeleton />
    </AppPage>
  );
}

const ProjectsPage = dynamic(() => import("./ProjectsPage").then((m) => m.ProjectsPage), {
  ssr: false,
  loading: Skeleton,
});

/** /app */
export function AppHome() {
  const v2 = useProjectsV2();
  if (v2 === null) return <Skeleton />;
  return v2 ? <ProjectsPage /> : <DashboardPage />;
}
