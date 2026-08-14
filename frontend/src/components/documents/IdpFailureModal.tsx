import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type IdpFailureReason =
  | "quota_exhausted"
  | "subscription_inactive"
  | "anthropic_key_missing"
  | "unreachable"
  | "rate_limited"
  | "auth_error"
  | "extraction_error"
  | string;

function reasonCopy(reason: IdpFailureReason): { title: string; body: string } {
  switch (reason) {
    case "quota_exhausted":
      return {
        title: "Claude page allowance used up",
        body: "This organization's Claude extraction quota for the current period is exhausted. You can fill metadata manually or use pattern matching if your admin enabled it.",
      };
    case "subscription_inactive":
      return {
        title: "Claude extraction is unavailable",
        body: "The paid Claude extraction service is not active for this organization. Please fill metadata manually or contact your administrator to renew.",
      };
    case "anthropic_key_missing":
      return {
        title: "Claude is not configured",
        body: "No Claude API credentials are available. Fill metadata manually or ask an administrator to configure extraction.",
      };
    case "unreachable":
      return {
        title: "Claude could not be reached",
        body: "The extraction service timed out or is temporarily unavailable. You can retry pattern matching or fill the fields manually.",
      };
    case "rate_limited":
      return {
        title: "Claude is temporarily busy",
        body: "The extraction service is rate-limited. Fill metadata manually or use pattern matching if enabled.",
      };
    case "auth_error":
      return {
        title: "Claude authentication failed",
        body: "The extraction service rejected the API credentials. Fill metadata manually while an administrator resolves the configuration.",
      };
    default:
      return {
        title: "Automatic extraction unavailable",
        body: "Claude could not extract fields from this document. Fill metadata manually or use pattern matching if your admin enabled it.",
      };
  }
}

interface Props {
  open: boolean;
  reason: IdpFailureReason;
  allowRegex: boolean;
  pending?: boolean;
  documentCount?: number;
  onManual: () => void;
  onRegex?: () => void;
}

export default function IdpFailureModal({
  open,
  reason,
  allowRegex,
  pending = false,
  documentCount,
  onManual,
  onRegex,
}: Props) {
  const copy = reasonCopy(reason);
  const batch = documentCount != null && documentCount > 1;

  return (
    <Dialog open={open} onOpenChange={() => { /* controlled by parent */ }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>
            {batch
              ? `${documentCount} documents in this batch could not be extracted by Claude. ${copy.body}`
              : copy.body}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-col sm:space-x-0">
          <button
            type="button"
            disabled={pending}
            onClick={onManual}
            className="inline-flex w-full items-center justify-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
          >
            Fill manually{batch ? " for all" : ""}
          </button>
          {allowRegex && onRegex && (
            <button
              type="button"
              disabled={pending}
              onClick={onRegex}
              className="inline-flex w-full items-center justify-center gap-2 border border-[#AEB5BB] bg-white px-4 py-2.5 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF3F7] disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Use pattern matching{batch ? " for all" : ""}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
