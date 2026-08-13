/**
 * WorkspaceCommandBar — Rev-2 (portal edition)
 * ─────────────────────────────────────────────
 * Renders its content into the blue command-bar slot (#wcb-slot) that Layout
 * owns.  This means:
 *
 *   • The bar's DOM position is always in Layout's Row 2 (the blue strip),
 *     so it is guaranteed to be the same height and position on every page,
 *     perfectly flush with the sidebar.
 *   • Pages keep the exact same JSX API — <WorkspaceCommandBar actions={…}>
 *     …children… </WorkspaceCommandBar> — nothing changes in the callers.
 *   • WorkspaceHeaderActions (bell / profile) now lives in Layout's Row 1
 *     (white bar) and is NOT rendered here anymore.
 *
 * The `sticky` + z-index tricks from Rev-1 are gone: the bar is Layout-owned
 * and always at the correct stacking level.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";

export function WorkspaceCommandBar({
  children,
  actions,
  className,
}: {
  /** Left / centre content: title block, search, filters. */
  children?: ReactNode;
  /** Optional page-specific controls rendered just left of the slot edge. */
  actions?: ReactNode;
  className?: string;
}) {
  // Wait until the DOM has mounted so getElementById is reliable.
  const [slot, setSlot] = useState<Element | null>(null);

  useEffect(() => {
    setSlot(document.getElementById("wcb-slot"));
  }, []);

  if (!slot) return null;

  return createPortal(
    <div className={clsx("flex h-full min-w-0 flex-1 items-center gap-3 px-4", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      {actions != null && (
        <div className="flex shrink-0 items-center gap-3">{actions}</div>
      )}
    </div>,
    slot,
  );
}
