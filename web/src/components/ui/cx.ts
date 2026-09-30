/** Class names joined, falsy parts skipped. Parts must not set the same
 *  property twice: Tailwind orders its CSS itself, not by the order here. */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
