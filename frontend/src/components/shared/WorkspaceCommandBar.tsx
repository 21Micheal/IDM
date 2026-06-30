/**
 * WorkspaceCommandBar — the single source of truth for the blue command bar
 * that sits at the top of every workspace page (Dashboard, Documents, Trash,
 * Audit, Upload, Scan, Workflow, Notifications, …).
 *
 * Why this exists
 * ───────────────
 * Each page used to hand-roll its own `<div className="bg-[#287EAD] …">` header.
 * Small differences (vertical padding, min-h vs fixed height, where the actions
 * sat) meant the bars drifted out of alignment with each other and with the
 * sidebar's blue logo block — most visibly a few px of height variance at the
 * seam where the sidebar meets the page. Centralising the shell here guarantees:
 *
 *   • a FIXED 69px height (matches the sidebar logo block exactly, and can't
 *     grow when content would otherwise wrap on a narrow window), and
 *   • identical horizontal padding (px-5 / pr-6), and
 *   • the chat/bell/profile actions always pinned to the right.
 *
 * Pages pass their own left/centre content as `children`, plus any page-specific
 * right-side controls (export button, filter pills, counts) via `actions`.
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { WorkspaceHeaderActions } from "./Layout";

export function WorkspaceCommandBar({
  children,
  actions,
  className,
}: {
  /** Left / centre content: title block, search, filters. */
  children?: ReactNode;
  /** Optional page-specific controls rendered just left of the standard actions. */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex h-[69px] shrink-0 items-center gap-3 bg-[#287EAD] px-5 pr-6 text-white",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">{children}</div>
      <div className="flex shrink-0 items-center gap-3">
        {actions}
        <WorkspaceHeaderActions variant="blue" />
      </div>
    </div>
  );
}
