/**
 * One undo for text and timeline (UX8, until UX10 merges the stacks):
 * the order in which undo steps were made in the two histories, so ⌘Z
 * undoes the latest step of either. Record a step only when its
 * history really added one (a coalesced slider drag is ONE step).
 */
export type Area = "doc" | "tl";

export class EditOrder {
  private undos: Area[] = [];
  private redos: Area[] = [];

  /** A new undo step in `area` (drops the redo order, like the histories). */
  record(area: Area): void {
    this.undos.push(area);
    this.redos = [];
  }

  /**
   * The area whose step undo (redo) takes next: the latest recorded one
   * that still has a step (`can`); with nothing recorded (a step the
   * order never saw), whichever area has one. Moves it to the other list.
   */
  take(kind: "undo" | "redo", can: (a: Area) => boolean): Area | null {
    const from = kind === "undo" ? this.undos : this.redos;
    const to = kind === "undo" ? this.redos : this.undos;
    let area: Area | undefined;
    while ((area = from.pop()) && !can(area)) {
      /* a step its history already dropped (limit) */
    }
    // Undo only: a step the order never saw (none after a new edit for redo).
    if (!area && kind === "undo") area = can("tl") ? "tl" : can("doc") ? "doc" : undefined;
    if (!area) return null;
    to.push(area);
    return area;
  }
}
