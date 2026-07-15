import { useState } from "react";
import { KeyRound } from "lucide-react";
import { toast } from "@/components/ui/vault-toast";

// Shows a one-time temporary password to the admin so it can be shared with the
// user. Used by both the create-user flow and the admin password-reset flow —
// the reliable channel, since outbound email may not be configured/delivered.
export function TemporaryPasswordModal({
  temporary_password,
  onClose,
  title = "Temporary Password",
  subtitle = "Share this with the user",
}: {
  temporary_password: string;
  onClose: () => void;
  title?: string;
  subtitle?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    // navigator.clipboard only exists in a secure context (HTTPS or localhost).
    // Over plain HTTP on a LAN IP it's undefined, so fall back to execCommand.
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(temporary_password);
        ok = true;
      } else {
        const ta = document.createElement("textarea");
        ta.value = temporary_password;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success("Password copied to clipboard");
    } else {
      toast.error("Couldn't copy automatically — select and copy it manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white w-full max-w-md border border-[#C8CDD2] shadow-xl p-8 space-y-6">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] flex-shrink-0">
            <KeyRound className="w-6 h-6 text-[#287EAD]" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-[#1F2933]">{title}</h2>
            <p className="text-sm text-[#5E6870]">{subtitle}</p>
          </div>
        </div>

        <div className="bg-[#F5F7F8] border border-[#C8CDD2] p-5">
          <p className="text-xs text-[#5E6870] mb-2">One-time password</p>
          <div className="flex items-center justify-between bg-white border border-[#C8CDD2] px-5 py-4 font-mono text-xl tracking-widest">
            {temporary_password}
            <button
              onClick={copyToClipboard}
              className="text-sm font-medium text-[#287EAD] hover:underline"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="text-sm bg-[#EEF6FB] border border-[#BDE3F5] p-4 text-[#1F2933]">
          The user will be prompted to set a new strong password on first login.<br />
          MFA is enabled by default.
        </div>

        <button onClick={onClose} className="inline-flex w-full items-center justify-center gap-2 bg-[#287EAD] px-5 py-2.5 font-medium text-white transition-colors hover:bg-[#206D99]">
          I have saved this password
        </button>
      </div>
    </div>
  );
}
