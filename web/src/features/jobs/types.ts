/**
 * Job shapes of the /app screens (moved from app/app/page.tsx in
 * UX4): GET /jobs/{id} and what a dashboard card shows of GET /jobs/status.
 */
import type { ErrorParams } from "@/lib/errors";

// What a dashboard card shows of its job (from GET /jobs/status).
export type CardStatus = {
  progress: number;
  message: string;
  status: string;
  /** Place in line while waiting for a free server slot. */
  queuePosition: number | null;
  /** Why it failed / where it is (backend/errors.py codes, UX5). */
  error_code?: string | null;
  error_params?: ErrorParams | null;
  refunded?: boolean | null;
  stage?: string | null;
  stage_params?: ErrorParams | null;
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
  queue_position?: number | null;
  /** Its error code for everyone but admins (the raw text, UX5). */
  error: string | null;
  error_code?: string | null;
  error_params?: ErrorParams | null;
  refunded?: boolean | null;
  /** Where a running job is (backend/errors.py STAGES). */
  stage?: string | null;
  stage_params?: ErrorParams | null;
  has_output: boolean;
  /** English sentences (what builds before UX5 show). */
  audio_warnings?: string[];
  /** The same as codes (lib/errors.ts audioWarningText), UX5. */
  audio_warning_codes?: string[];
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
  /** UT5: GET /jobs/{id}/poster (the first kept frame) answers. */
  has_poster?: boolean;
  caption_preset?: string | null;
  // The frame rate of the video the editor plays and the renders cut
  // (the mezz, UT3): the v2 editor's trim frame grid (UX10).
  fps?: number | null;
  // The finished job (done): what the Done view shows.
  outputs?: string[];
  social_caption?: string;
  social_hashtags?: string[];
  hook_clips?: { key: string; title: string; reason: string; start: number; end: number }[];
  /** The uploaded file's name (the v2 editor's default title). */
  filename?: string | null;
  preset_id?: string | null;
  preset_label?: string | null;
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
  /** Why the analysis cut it (UX10, backend/cut_kinds.py): "silence",
   *  "filler", "voice_cmd" or "bad_take"; missing on jobs from before. */
  kind?: string;
};
