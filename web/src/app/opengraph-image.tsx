import { renderShareImage } from "@/lib/shareImage";

// Link previews (WhatsApp, iMessage, Slack, LinkedIn, …): one image for
// the whole site, generated at build time.
export const alt =
  "CleoCuts: cut pauses, add captions, post in minutes — a talking video turned into a captioned 9:16 short.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return renderShareImage();
}
