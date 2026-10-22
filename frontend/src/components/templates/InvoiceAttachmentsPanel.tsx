import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Mail, Paperclip, Upload } from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

type SupplierResponse = {
  code: string;
  name: string;
  email?: string;
  status: "sent" | "received" | "awaiting_manual";
  response_source?: "email" | "manual";
  files?: { name: string }[];
};

type RfqStatus = {
  sent_at?: string;
  suppliers: SupplierResponse[];
  all_received: boolean;
  attachment_field: string;
};

interface Props {
  documentId: string;
  values: Record<string, unknown>;
  onBeforeSend?: () => Promise<void>;
  onUpdated?: () => void;
}

export default function InvoiceAttachmentsPanel({ documentId, values, onBeforeSend, onUpdated }: Props) {
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadingSupplier, setUploadingSupplier] = useState<string | null>(null);
  const { data: status, isLoading } = useQuery<RfqStatus>({
    queryKey: ["rfq", documentId],
    queryFn: () => documentsAPI.rfq(documentId).then((response) => response.data),
    refetchInterval: 10_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["rfq", documentId] });
    qc.invalidateQueries({ queryKey: ["form", documentId] });
    onUpdated?.();
  };

  const sendMutation = useMutation({
    mutationFn: async () => {
      await onBeforeSend?.();
      return documentsAPI.sendRfq(documentId);
    },
    onSuccess: ({ data }) => {
      toast.success(data.sent_count ? `RFQ sent to ${data.sent_count} supplier(s).` : "Supplier responses can be uploaded manually.");
      refresh();
    },
    onError: (error: any) => toast.error(error?.response?.data?.detail || "Could not send the RFQ."),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ supplier, files }: { supplier: SupplierResponse; files: File[] }) => {
      const field = status?.attachment_field;
      if (!field) throw new Error("No Multiple Attachments field is configured on this form.");
      setUploadingSupplier(supplier.code);
      const currentIndexes = Object.keys(values)
        .filter((key) => key.startsWith(`${field}~`))
        .map((key) => Number(key.slice(field.length + 1)))
        .filter((index) => Number.isInteger(index) && index >= 0);
      let nextIndex = currentIndexes.length ? Math.max(...currentIndexes) + 1 : 0;
      const attachments = files.map((file) => ({ field: `attachment_${field}~${nextIndex++}`, file }));
      return documentsAPI.updateForm(documentId, values, attachments, { rfqSupplierCode: supplier.code });
    },
    onSuccess: () => {
      toast.success("Supplier response attached.");
      setUploadingSupplier(null);
      refresh();
    },
    onError: (error: any) => {
      setUploadingSupplier(null);
      toast.error(error?.response?.data?.detail || error?.message || "Could not upload the supplier response.");
    },
  });

  const chooseFiles = (supplier: SupplierResponse) => {
    if (fileInput.current) {
      fileInput.current.dataset.supplierCode = supplier.code;
      fileInput.current.click();
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <Mail className="h-4 w-4 text-[#287EAD]" /> Supplier quotations and invoices
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Send the configured RFQ email. Supplier replies with the reference in the subject are attached automatically; other responses can be uploaded here.
          </p>
        </div>
        <button
          type="button"
          onClick={() => sendMutation.mutate()}
          disabled={sendMutation.isPending}
          className="inline-flex items-center gap-2 rounded bg-[#287EAD] px-3 py-2 text-xs font-semibold text-white hover:bg-[#216b95] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
          {status?.sent_at ? "Resend RFQ" : "Send RFQ"}
        </button>
      </div>

      {isLoading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading supplier responses…</div>
      ) : status?.suppliers?.length ? (
        <div className="mt-4 divide-y divide-slate-100 rounded border border-slate-100">
          {status.suppliers.map((supplier) => {
            const received = supplier.status === "received";
            return (
              <div key={supplier.code} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                    {received ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Paperclip className="h-4 w-4 text-slate-400" />}
                    <span>{supplier.name}</span><span className="text-xs text-slate-500">{supplier.code}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {received ? `Response received${supplier.response_source ? ` (${supplier.response_source})` : ""}` : supplier.email ? `Waiting for ${supplier.email}` : "No email address; upload the response manually"}
                    {supplier.files?.length ? ` · ${supplier.files.map((file) => file.name).join(", ")}` : ""}
                  </div>
                </div>
                {(
                  <button type="button" onClick={() => chooseFiles(supplier)} disabled={uploadingSupplier === supplier.code}
                    className="inline-flex items-center gap-1.5 rounded border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                    {uploadingSupplier === supplier.code ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                    {received ? "Add files" : "Upload response"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-4 rounded bg-slate-50 px-3 py-2 text-xs text-slate-600">Select suppliers in the requisition form, save the form, then send the RFQ. Responses are required before this stage can be approved.</p>
      )}

      {status?.suppliers?.length ? (
        <p className={`mt-3 text-xs font-medium ${status.all_received ? "text-emerald-700" : "text-amber-700"}`}>
          {status.all_received ? "All selected suppliers have responded. Finance can approve this stage." : "Finance approval is held until every selected supplier has responded."}
        </p>
      ) : null}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || []);
          const code = event.currentTarget.dataset.supplierCode;
          const supplier = status?.suppliers?.find((item) => item.code === code);
          event.currentTarget.value = "";
          if (supplier && files.length) uploadMutation.mutate({ supplier, files });
        }}
      />
    </section>
  );
}
