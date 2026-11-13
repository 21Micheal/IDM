import { Info } from "lucide-react";

type Props = {
  message: string;
  onDismiss: () => void;
  onRaiseAnyway: () => void;
  submitting?: boolean;
};

export default function TravelPolicyNoticeModal({ message, onDismiss, onRaiseAnyway, submitting = false }: Props) {
  return (
    <div className="fixed inset-0 z-[310] flex items-start justify-center bg-black/40 px-4 pt-[10vh]">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="travel-policy-notice-title"
        className="w-full max-w-sm border border-[#C8CDD2] bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 px-6 pt-5 pb-4">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden="true" />
          <div>
            <h2 id="travel-policy-notice-title" className="text-sm font-bold text-[#1F2933]">
              Reconciliation required
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-[#5E6870]">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#E2E6E9] bg-[#F7F8F9] px-6 py-4">
          <button
            type="button"
            onClick={onDismiss}
            disabled={submitting}
            className="border border-[#C8CDD2] bg-white px-4 py-2 text-sm font-semibold text-[#5E6870] transition-colors hover:bg-[#EEF1F3] disabled:opacity-60"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={onRaiseAnyway}
            disabled={submitting}
            className="bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1E6F99]"
          >
            {submitting ? "Submitting…" : "Raise anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
