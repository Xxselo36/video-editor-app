// The Vorschau's shape while it (or its job) loads (ProjectPage), and
// while the Vorschau tab finds the project it opens (PreviewRoute).
import s from "./preview.module.css";

/** The Vorschau's shape while it (or its job) loads: frame, title, buttons. */
export function PreviewSkeleton({ testId = "project-loading" }: { testId?: string }) {
  return (
    <div className={s.root} data-testid={testId} aria-busy="true">
      <div className={s.watch} data-shape="tall">
        <div className={s.media}>
          <div className={s.frameSkeleton} />
        </div>
        <div className={s.info}>
          <div className={s.titleSkeleton} />
          <div className={s.acts}>
            <div className={s.buttonSkeleton} />
            <div className={s.buttonSkeleton} />
          </div>
        </div>
      </div>
    </div>
  );
}
