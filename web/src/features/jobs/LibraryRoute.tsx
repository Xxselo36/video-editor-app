"use client";
/**
 * /app/library (UX12 gate, ./useProjectsV2): the library of before for
 * everyone not on the v2 opt-in; on it, on to the Projects page (/app).
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LibraryPage } from "./LibraryPage.legacy";
import { useProjectsV2 } from "./useProjectsV2";

export function LibraryRoute() {
  const v2 = useProjectsV2();
  const router = useRouter();
  useEffect(() => {
    if (v2) router.replace("/app");
  }, [v2, router]);
  return v2 === false ? <LibraryPage /> : null;
}
