/**
 * Job shapes of the /app screens (moved verbatim from app/app/page.tsx in
 * UX4): GET /jobs/{id} and what a dashboard card shows of GET /jobs/status.
 */

// What a dashboard card shows of its job (from GET /jobs/status).
export type CardStatus = {
  progress: number;
  message: string;
  status: string;
  /** Place in line while waiting for a free server slot. */
  queuePosition: number | null;
};

export type JobStatus = {
  id: string;
  status:
    | "pending"
    | "processing"
    | "awaiting_review"
    | "done"
    | "error"
    | "cancelled";
  message: string;
  progress: number;
  error: string | null;
  error_code?: string | null;
  refunded?: boolean | null;
  has_output: boolean;
  audio_warnings?: string[];
  audio_levels?: { mean_db?: number | null; max_db?: number | null };
  duration?: number;
  cut_ranges?: CutRange[];
  // The user's saved timeline (job.segments + effects). Seed the editor
  // from this — cut_ranges only describe the automatic cuts.
  edit_segments?: SavedSeg[];
  // Segments the served preview.mp4 was built from + its version.
  preview_segments?: [number, number][];
  preview_version?: number;
  // GET /jobs/{id}/proxy-video exists: the editor plays it and applies
  // the edit itself (lib/editPlayback). Missing = unknown, probed.
  has_proxy?: boolean;
  caption_preset?: string | null;
};

export type SavedSeg = {
  start: number;
  end: number;
  speed?: number;
  fadeIn?: number;
  fadeOut?: number;
  volume?: number;
};

export type CutRange = {
  id: number;
  start: number;
  end: number;
};
