/** The contract every academy demo mounts against. LEARN owns this file. */

export interface DemoCtx {
  /** The chapter's world seed — shared across chapters via the URL. */
  seed: number;
  /**
   * True when the page is being driven by the screenshot harness
   * (`?frozen`): demos must render a fixed, pixel-stable state and must not
   * start free-running animation.
   */
  frozen: boolean;
  /** Ask the shell to change the seed (updates the URL, re-renders the page). */
  onSeedChange(seed: number): void;
  /** Report observable learner/world state to the chapter's mission evaluator. */
  report(evidence: Record<string, number | string | boolean>): void;
}

/** A demo renders into `root` and may return a disposer (cancel animation). */
export type Demo = (root: HTMLElement, ctx: DemoCtx) => void | (() => void);
