/**
 * Whether the overlay is showing anything, re-measured on demand. The page reports each change to main, which
 * parks the window while it is empty so screenshot tools that walk the window list see no full-screen layer.
 */
export class Occupancy {
  private occupied = false;

  constructor(
    private readonly measure: () => boolean,
    private readonly report: (occupied: boolean) => void,
  ) {}

  /** Re-measures and reports once per change; repeated measures of the same state stay silent. */
  refresh(): void {
    const now = this.measure();
    if (now === this.occupied) return;
    this.occupied = now;
    this.report(now);
  }
}
