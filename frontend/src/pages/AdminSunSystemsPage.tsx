/**
 * AdminSunSystemsPage — configure the SunSystems Connect connection.
 *
 * One global connection (gateway URL + SecurityProvider/ComponentExecutor paths
 * + credentials + default business unit / budget code). Blank fields fall back
 * to the SUNSYSTEMS_* environment defaults. "Test connection" acquires a
 * SecurityProvider token without saving.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Plug, Save, ShieldCheck, XCircle } from "lucide-react";
import { sunsystemsAPI, type SunSystemsConnection } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

const FIELDS: Array<{
  key: keyof SunSystemsConnection; label: string; placeholder?: string; mono?: boolean; help?: string;
}> = [
  { key: "base_url", label: "Gateway base URL", placeholder: "http://host:81/sunsystems-connect/wsdl", mono: true, help: "The SunSystems Connect WSDL base — SecurityProvider and ComponentExecutor WSDLs sit under it." },
  { key: "security_path", label: "SecurityProvider path", placeholder: "SecurityProvider", mono: true },
  { key: "executor_path", label: "ComponentExecutor path", placeholder: "ComponentExecutor", mono: true },
  { key: "username", label: "Username", placeholder: "service account user" },
  { key: "password", label: "Password", placeholder: "••••••••" },
  { key: "business_unit", label: "Default business unit", placeholder: "e.g. PK1", help: "Used when a template doesn't set its own." },
  { key: "budget_code", label: "Default budget code", placeholder: "e.g. A" },
];

const inputCls =
  "h-10 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
  "placeholder:text-[#8C969E] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

export default function AdminSunSystemsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["sunsystems-connection"],
    queryFn: () => sunsystemsAPI.getConnection().then((r) => r.data),
  });

  const [form, setForm] = useState<SunSystemsConnection>({});
  const [verifyTls, setVerifyTls] = useState(true);
  const [clearPassword, setClearPassword] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail?: string } | null>(null);

  // Seed the form from the saved connection (passwords arrive masked).
  useEffect(() => {
    if (data) {
      setForm({ ...data.connection });
      setVerifyTls(data.connection.verify_tls ?? data.effective.verify_tls ?? true);
      setClearPassword(false);
    }
  }, [data]);

  const set = (key: keyof SunSystemsConnection, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const payload = (): SunSystemsConnection => ({
    ...form,
    password: clearPassword ? "" : form.password,
    verify_tls: verifyTls,
    clear_password: clearPassword,
  });

  const saveMut = useMutation({
    mutationFn: () => sunsystemsAPI.updateConnection(payload()).then((r) => r.data),
    onSuccess: () => {
      toast.success("SunSystems connection saved.");
      qc.invalidateQueries({ queryKey: ["sunsystems-connection"] });
    },
    onError: () => toast.error("Could not save the connection."),
  });

  const testMut = useMutation({
    mutationFn: () => sunsystemsAPI.testConnection(payload()).then((r) => r.data),
    onSuccess: (res) => {
      setTestResult(res);
      if (res.ok) toast.success("Connected — token acquired.");
      else toast.error(res.detail || "Connection failed.");
    },
    onError: () => { setTestResult({ ok: false, detail: "Request failed." }); toast.error("Could not reach the server."); },
  });

  const eff = data?.effective;

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-8">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded bg-[#EEF6FB] text-[#287EAD]">
          <Plug className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[#1F2933]">SunSystems connection</h1>
          <p className="text-xs text-[#5E6870]">Gateway URL and credentials for budget checks and journal posting.</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 p-8 text-sm text-[#5E6870]"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : (
        <>
          <div className="border border-[#C8CDD2] bg-white shadow-sm">
            <div className="border-b border-[#C8CDD2] bg-[#F3F5F6] px-5 py-3">
              <h2 className="text-sm font-bold text-[#1F2933]">Connection</h2>
              <p className="mt-0.5 text-xs text-[#5E6870]">Leave a field blank to fall back to its <code>SUNSYSTEMS_*</code> environment default.</p>
            </div>
            <div className="space-y-4 p-5">
              {FIELDS.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <label className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">{f.label}</label>
                  <input
                    type={f.key === "password" ? "password" : "text"}
                    autoComplete={f.key === "password" ? "new-password" : "off"}
                    value={(form[f.key] as string) ?? ""}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                    className={f.mono ? `${inputCls} font-mono` : inputCls}
                  />
                  {f.help && <p className="text-[10px] text-[#8C969E]">{f.help}</p>}
                  {eff && eff[f.key] && !form[f.key] && (
                    <p className="text-[10px] text-[#8C969E]">Using env default: <span className="font-mono">{String(eff[f.key])}</span></p>
                  )}
                  {f.key === "password" && data?.has_password && (
                    <label className="flex cursor-pointer items-center gap-2 pt-1 text-xs text-[#5E6870]">
                      <input
                        type="checkbox"
                        checked={clearPassword}
                        onChange={(e) => setClearPassword(e.target.checked)}
                        className="h-3.5 w-3.5 accent-[#287EAD]"
                      />
                      Clear saved password and use the environment default
                    </label>
                  )}
                </div>
              ))}
              <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[#1F2933]">
                <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} className="h-4 w-4 accent-[#287EAD]" />
                Verify TLS certificate
              </label>
            </div>
          </div>

          {testResult && (
            <div className={`flex items-start gap-2 border px-4 py-3 text-sm ${testResult.ok ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
              {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <XCircle className="mt-0.5 h-4 w-4" />}
              <span>{testResult.ok ? "Connected — SecurityProvider returned a token." : testResult.detail}</span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => { setTestResult(null); testMut.mutate(); }}
              disabled={testMut.isPending}
              className="inline-flex items-center gap-2 border border-[#287EAD] px-4 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB] disabled:opacity-60"
            >
              {testMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Test connection
            </button>
            <button
              type="button"
              onClick={() => saveMut.mutate()}
              disabled={saveMut.isPending}
              className="inline-flex items-center gap-2 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-60"
            >
              {saveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save connection
            </button>
          </div>
        </>
      )}
    </div>
  );
}
