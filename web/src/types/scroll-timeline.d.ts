/**
 * Scroll-driven animations (CSS Scroll-driven Animations 1), as far as
 * the landing's command rows use them (features/landing/sections/
 * CommandRows.tsx): TypeScript 5.9's lib.dom has the `timeline` option of
 * Element.animate() but neither ViewTimeline nor the animation range.
 * Drop these once lib.dom has them.
 */

interface ViewTimelineOptions {
  subject?: Element;
  axis?: "block" | "inline" | "x" | "y";
  /** One or two lengths, or "auto" (the default: the scroll container's
   *  scroll-padding). */
  inset?: string;
}

interface ViewTimeline extends AnimationTimeline {
  readonly subject: Element;
}

// eslint-disable-next-line no-var -- an interface object, as lib.dom declares them
declare var ViewTimeline: {
  prototype: ViewTimeline;
  new (options?: ViewTimelineOptions): ViewTimeline;
};

interface KeyframeAnimationOptions {
  /** Where on the timeline the effect starts and ends, as CSS
   *  `animation-range-start` / `-end` values ("exit-crossing 0%"). */
  rangeStart?: string;
  rangeEnd?: string;
}
