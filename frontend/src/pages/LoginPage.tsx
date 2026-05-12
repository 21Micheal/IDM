// src/pages/auth/LoginPage.tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Mail, RefreshCw, Lock, ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { api, authAPI, documentsAPI, notificationsAPI, workflowAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import { FlaxemLogo } from "@/components/shared/FlaxemLogo";
import type { AuthUser } from "@/store/authStore";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const credSchema = z.object({
  email:    z.string().email("Please enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});
const otpSchema = z.object({
  otp: z.string().length(6, "Verification code must be 6 digits."),
});

type CredForm = z.infer<typeof credSchema>;
type OTPForm  = z.infer<typeof otpSchema>;

// ─── Theme tokens ─────────────────────────────────────────────────────────────

const T = {
  bg:          "#ffffff",
  bgPanel:     "#0c1e32",
  fieldBg:     "#fcfcfc",
  fieldBorder: "#d1d5db",
  text:        "#0f172a",
  muted:       "#64748b",
  faint:       "#3d5a75",
  blue:        "#004a99",
  blueBright:  "#0056b3",
  blueLight:   "#3b82f6",
  blueDim:     "rgba(0,102,204,0.15)",
  blueDimBorder:"rgba(0,102,204,0.25)",
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const { setTokens, setUser } = useAuthStore();

  const [step,           setStep]          = useState<"credentials" | "otp">("credentials");
  const [pendingUserId,  setPendingUserId]  = useState("");
  const [userEmail,      setUserEmail]      = useState("");
  const [loading,        setLoading]        = useState(false);
  const [resending,      setResending]      = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [showPassword,   setShowPassword]   = useState(false);

  const credForm = useForm<CredForm>({ resolver: zodResolver(credSchema) });
  const otpForm  = useForm<OTPForm>({  resolver: zodResolver(otpSchema)  });

  // ── Unchanged post-login logic ─────────────────────────────────────────────

  const completeLogin = async (tokenData: {
    access: string;
    refresh: string;
    must_change_password?: boolean;
    user?: AuthUser;
  }) => {
    setTokens(tokenData.access, tokenData.refresh);
    if (tokenData.user) {
      setUser(tokenData.user);
    } else {
      try {
        const { data: me } = await authAPI.me(tokenData.access);
        setUser(me);
      } catch {
        toast.warn("Signed in, but your profile could not be loaded yet.");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.allSettled([
      qc.prefetchQuery({
        queryKey: ["documents", "recent"],
        queryFn:  () => documentsAPI.list({ page_size: 5, ordering: "-created_at" }).then((r) => r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["documents", "pending", "count"],
        queryFn:  () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
      }),
      qc.prefetchQuery({
        queryKey: ["workflow", "my-tasks"],
        queryFn:  () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["audit", "recent"],
        queryFn:  () => api.get("/audit/", { params: { ordering: "-timestamp", page_size: 5 } }).then((r) => r.data.results ?? r.data),
      }),
      qc.prefetchQuery({
        queryKey: ["notifications"],
        queryFn:  () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
      }),
    ]);
    if (tokenData.must_change_password) {
      navigate("/change-password", { replace: true });
    } else {
      navigate("/", { replace: true });
    }
  };

  const onCredentials = async (values: CredForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.login(values.email, values.password);
      if (data.mfa_required) {
        setPendingUserId(data.user_id);
        setUserEmail(values.email);
        setStep("otp");
        toast.info("A 6-digit verification code has been sent to your email.");
      } else {
        await completeLogin(data);
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Invalid email or password.");
    } finally {
      setLoading(false);
    }
  };

  const onOTP = async (values: OTPForm) => {
    setLoading(true);
    try {
      const { data } = await authAPI.verifyOTP(pendingUserId, values.otp);
      await completeLogin(data);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || "Invalid or expired verification code.");
    } finally {
      setLoading(false);
    }
  };

  const resendOTP = async () => {
    if (resendCooldown > 0) return;
    setResending(true);
    try {
      await authAPI.resendOTP(pendingUserId);
      toast.success("A new verification code has been sent.");
      setResendCooldown(60);
      const timer = setInterval(() => {
        setResendCooldown((prev) => {
          if (prev <= 1) { clearInterval(timer); return 0; }
          return prev - 1;
        });
      }, 1000);
    } catch {
      toast.error("Unable to resend code. Please try again shortly.");
    } finally {
      setResending(false);
    }
  };

  // ── Shared field style ─────────────────────────────────────────────────────

  const fieldStyle: React.CSSProperties = {
    background:  T.fieldBg,
    border:      `1px solid ${T.fieldBorder}`,
    color:       "#111827",
    caretColor:  T.blue,
  };
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = T.blue;
    e.target.style.boxShadow   = `0 0 0 3px rgba(0,102,204,0.15)`;
  };
  const onBlur  = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = T.fieldBorder;
    e.target.style.boxShadow   = "none";
  };

  const otpValue = otpForm.watch("otp") ?? "";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen flex"
      style={{ fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", background: T.bg }}
    >

      {/* ── Left brand panel ──────────────────────────────────────────── */}
      <div
        className="hidden lg:flex flex-col justify-between w-[480px] shrink-0 relative overflow-hidden p-12"
        style={{ background: `linear-gradient(155deg, #0c2340 0%, #0f3460 45%, #1a4a7a 100%)` }}
      >
        {/* Geometric SVG decoration */}
        <svg className="absolute inset-0 w-full h-full opacity-10 pointer-events-none" viewBox="0 0 480 900" fill="none">
          <circle cx="480" cy="0"   r="300" stroke="#5ba3d9" strokeWidth="1.5" fill="none" />
          <circle cx="480" cy="0"   r="460" stroke="#5ba3d9" strokeWidth="1"   fill="none" />
          <circle cx="0"   cy="900" r="260" stroke="#5ba3d9" strokeWidth="1.5" fill="none" />
          <circle cx="0"   cy="900" r="400" stroke="#5ba3d9" strokeWidth="1"   fill="none" />
          <line x1="0" y1="0" x2="480" y2="900" stroke="#5ba3d9" strokeWidth="0.5" />
          <line x1="240" y1="0" x2="240" y2="900" stroke="#5ba3d9" strokeWidth="0.5" />
        </svg>

        {/* Subtle blue glow orb */}
        <div
          className="absolute bottom-40 left-6 w-56 h-56 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(0,102,204,0.25) 0%, transparent 70%)" }}
        />
        <div
          className="absolute top-10 right-0 w-40 h-40 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(96,165,250,0.15) 0%, transparent 70%)" }}
        />

        {/* Logo */}
        <div className="relative z-10">
          <FlaxemLogo variant="light" className="h-9" />
        </div>

        {/* Center content */}
        <div className="relative z-10">
          {/* Badge */}
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold mb-7"
            style={{
              background: T.blueDim,
              color:      T.blueLight,
              border:     `1px solid ${T.blueDimBorder}`,
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
            Powered by Infor IDM
          </div>

          <h2 className="text-4xl font-bold text-white leading-tight mb-4">
            Enterprise Document<br />
            <span style={{ color: T.blueLight }}>Management</span>
          </h2>
          <p className="text-base leading-relaxed" style={{ color: "#8ab4d4" }}>
            Securely manage, route, and archive your business documents with
            enterprise-grade controls and compliance built in.
          </p>

          {/* Feature list */}
          <div className="mt-10 space-y-4">
            {[
              { icon: "🔒", label: "SOC 2 & ISO 27001 compliant security"       },
              { icon: "📄", label: "Intelligent document routing & approval"      },
              { icon: "🔍", label: "Full-text search across all document content" },
            ].map(({ icon, label }) => (
              <div key={label} className="flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-sm shrink-0"
                  style={{ background: T.blueDim, border: `1px solid ${T.blueDimBorder}` }}
                >
                  {icon}
                </div>
                <span className="text-sm" style={{ color: "#a8c8e8" }}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Bottom */}
        <p className="relative z-10 text-xs" style={{ color: "#4a6d8a" }}>
          © {new Date().getFullYear()} Flaxem Systems Enterprises. All rights reserved.
        </p>
      </div>

      {/* ── Right form panel ──────────────────────────────────────────── */}
      <div
        className="flex-1 flex items-center justify-center p-8"
        style={{ background: T.bg }}
      >
        <div className="w-full max-w-md">

          {/* Mobile logo */}
          <div className="lg:hidden text-center mb-8">
            <FlaxemLogo variant="light" className="h-8 mx-auto" />
          </div>

          {/* ── Step 1: Credentials ─────────────────────────────────── */}
          {step === "credentials" && (
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="mb-8">
                <h1 className="text-3xl font-semibold text-slate-900 tracking-tight mb-2">Sign In</h1>
                <p className="text-sm text-slate-500">Enter your credentials to access your workspace</p>
              </div>

              <form onSubmit={credForm.handleSubmit(onCredentials)} className="space-y-5">

                {/* Email */}
                <div>
                  <label className="block text-[11px] font-bold mb-1.5 uppercase tracking-wider text-slate-600">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none text-slate-400" />
                    <input
                      {...credForm.register("email")}
                      type="email"
                      placeholder="name@company.com"
                      autoComplete="email"
                      autoFocus
                      className="w-full pl-10 pr-4 py-2.5 rounded-lg text-sm outline-none transition-all"
                      style={fieldStyle}
                      onFocus={onFocus}
                      onBlur={onBlur}
                    />
                  </div>
                  {credForm.formState.errors.email && (
                    <p className="text-red-400 text-xs mt-1.5">
                      {credForm.formState.errors.email.message}
                    </p>
                  )}
                </div>

                {/* Password */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-xs font-semibold uppercase tracking-widest"
                      style={{ color: T.muted }}>
                      Password
                    </label>
                    <button type="button" className="text-xs font-medium transition-colors"
                      style={{ color: T.blueLight }}>
                      Forgot password?
                    </button>
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                      style={{ color: T.faint }} />
                    <input
                      {...credForm.register("password")}
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••••"
                      autoComplete="current-password"
                      className="w-full pl-10 pr-12 py-3 rounded-xl text-sm outline-none transition-all"
                      style={fieldStyle}
                      onFocus={onFocus}
                      onBlur={onBlur}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3.5 top-1/2 -translate-y-1/2 transition-colors"
                      style={{ color: T.faint }}
                    >
                      {showPassword
                        ? <EyeOff className="w-4 h-4" />
                        : <Eye    className="w-4 h-4" />}
                    </button>
                  </div>
                  {credForm.formState.errors.password && (
                    <p className="text-red-400 text-xs mt-1.5">
                      {credForm.formState.errors.password.message}
                    </p>
                  )}
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all disabled:opacity-70"
                  style={{
                    background:  T.blue,
                    color:       "#fff",
                    boxShadow:   "0 1px 2px rgba(0,0,0,0.05)",
                  }}
                >
                  {loading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Signing in…</>
                    : <>Sign In <ArrowRight className="w-4 h-4" /></>}
                </button>
              </form>
            </div>
          )}

          {/* ── Step 2: OTP ─────────────────────────────────────────── */}
          {step === "otp" && (
            <div>
              {/* Back */}
              <button
                onClick={() => setStep("credentials")}
                className="flex items-center gap-1.5 text-sm mb-8 transition-colors"
                style={{ color: T.muted }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
                Back to sign in
              </button>

              <div className="mb-8">
                <div
                  className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5"
                  style={{ background: T.blueDim, border: `1px solid ${T.blueDimBorder}` }}
                >
                  <Mail className="w-7 h-7" style={{ color: T.blueLight }} />
                </div>
                <h1 className="text-2xl font-bold text-slate-900 mb-2">Check your inbox</h1>
                <p className="text-sm leading-relaxed" style={{ color: T.muted }}>
                  We sent a 6-digit verification code to{" "}
                  <span className="font-semibold" style={{ color: "#8ab4d4" }}>
                    {userEmail || "your email"}
                  </span>
                </p>
              </div>

              <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-6">
                <div>
                  <label className="block text-xs font-semibold mb-3 uppercase tracking-widest"
                    style={{ color: T.muted }}>
                    Verification Code
                  </label>
                  <input
                    {...otpForm.register("otp")}
                    type="text"
                    maxLength={6}
                    placeholder="000000"
                    autoFocus
                    inputMode="numeric"
                    className="w-full text-center py-4 rounded-xl text-3xl font-mono outline-none tracking-[0.6em] transition-all"
                    style={{
                      ...fieldStyle,
                      color:         T.blueLight,
                      letterSpacing: "0.5em",
                    }}
                    onFocus={onFocus}
                    onBlur={onBlur}
                    onChange={(e) => {
                      const val = e.target.value.replace(/\D/g, "").slice(0, 6);
                      otpForm.setValue("otp", val);
                      if (val.length === 6) otpForm.handleSubmit(onOTP)();
                    }}
                  />
                  {otpForm.formState.errors.otp && (
                    <p className="text-red-400 text-xs mt-1.5">
                      {otpForm.formState.errors.otp.message}
                    </p>
                  )}

                  {/* Progress dots */}
                  <div className="flex items-center justify-center gap-2 mt-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full transition-all"
                        style={{
                          background: i < otpValue.length ? T.blue : T.fieldBorder,
                          transform:  i < otpValue.length ? "scale(1.3)" : "scale(1)",
                        }}
                      />
                    ))}
                  </div>
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  disabled={loading || otpValue.length < 6}
                  className="w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all"
                  style={{
                    background:  otpValue.length === 6 && !loading
                      ? `linear-gradient(135deg, ${T.blue} 0%, ${T.blueBright} 100%)`
                      : T.fieldBg,
                    color:       otpValue.length === 6 && !loading ? "#fff" : T.faint,
                    border:      otpValue.length === 6 && !loading ? "none" : `1px solid ${T.fieldBorder}`,
                    boxShadow:   otpValue.length === 6 && !loading ? "0 4px 20px rgba(0,102,204,0.4)" : "none",
                    cursor:      otpValue.length < 6 ? "not-allowed" : "pointer",
                  }}
                >
                  {loading
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Verifying…</>
                    : <><ShieldCheck className="w-4 h-4" /> Verify &amp; Sign In</>}
                </button>
              </form>

              {/* Resend row */}
              <div
                className="flex items-center justify-between mt-6 pt-6"
                style={{ borderTop: `1px solid #1e2e40` }}
              >
                <span className="text-xs" style={{ color: T.faint }}>Didn't receive the code?</span>
                <button
                  type="button"
                  onClick={resendOTP}
                  disabled={resending || resendCooldown > 0}
                  className="flex items-center gap-1.5 text-xs font-semibold transition-colors disabled:opacity-50"
                  style={{ color: T.blue }}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${resending ? "animate-spin" : ""}`} />
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Code"}
                </button>
              </div>

              {/* Security note */}
              <div
                className="mt-5 flex items-start gap-2.5 px-4 py-3 rounded-xl"
                style={{ background: "rgba(91,163,217,0.06)", border: "1px solid rgba(91,163,217,0.12)" }}
              >
                <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#5ba3d9" }} />
                <p className="text-xs leading-relaxed" style={{ color: "#4a6d8a" }}>
                  This code expires in{" "}
                  <span style={{ color: "#8ab4d4" }}>10 minutes</span>. Never share it with anyone,
                  including Flaxem support.
                </p>
              </div>
            </div>
          )}

          {/* Footer */}
          <p className="text-center text-xs mt-8" style={{ color: "#2d4055" }}>
            Trouble signing in?{" "}
            <button
              type="button"
              className="font-medium transition-colors"
              style={{ color: T.faint }}
            >
              Contact IT Support
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

// 5. Updated File: src/pages/auth/LoginPage.tsx
// Centered, modern card design with better spacing and Flaxem branding.
// import { useState } from "react";
// import { useNavigate } from "react-router-dom";
// import { useQueryClient } from "@tanstack/react-query";
// import { useForm } from "react-hook-form";
// import { zodResolver } from "@hookform/resolvers/zod";
// import { z } from "zod";
// import { Loader2, Mail, RefreshCw, Lock, ArrowRight } from "lucide-react";
// import { api, authAPI, documentsAPI, notificationsAPI, workflowAPI } from "@/services/api";
// import { useAuthStore } from "@/store/authStore";
// import { toast } from "@/components/ui/vault-toast";
// import { FlaxemLogo } from "@/components/shared/FlaxemLogo";
// import type { AuthUser } from "@/store/authStore";

// const credSchema = z.object({
//   email: z.string().email("Please enter a valid email address."),
//   password: z.string().min(1, "Password is required."),
// });
// const otpSchema = z.object({
//   otp: z.string().length(6, "Verification code must be 6 digits."),
// });

// type CredForm = z.infer<typeof credSchema>;
// type OTPForm = z.infer<typeof otpSchema>;

// export default function LoginPage() {
//   const navigate = useNavigate();
//   const qc = useQueryClient();
//   const { setTokens, setUser } = useAuthStore();
//   const [step, setStep] = useState<"credentials" | "otp">("credentials");
//   const [pendingUserId, setPendingUserId] = useState("");
//   const [userEmail, setUserEmail] = useState("");
//   const [loading, setLoading] = useState(false);
//   const [resending, setResending] = useState(false);
//   const [resendCooldown, setResendCooldown] = useState(0);

//   const credForm = useForm<CredForm>({ resolver: zodResolver(credSchema) });
//   const otpForm = useForm<OTPForm>({ resolver: zodResolver(otpSchema) });

//   const completeLogin = async (tokenData: {
//     access: string;
//     refresh: string;
//     must_change_password?: boolean;
//     user?: AuthUser;
//   }) => {
//     setTokens(tokenData.access, tokenData.refresh);

//     if (tokenData.user) {
//       setUser(tokenData.user);
//     } else {
//       try {
//         const { data: me } = await authAPI.me(tokenData.access);
//         setUser(me);
//       } catch {
//         toast.warn("Signed in, but your profile could not be loaded yet.");
//       }
//     }

//     // Warm the dashboard caches so the first protected screen has data immediately.
//     // Small artificial delay ensures the authStore update has propagated to Axios interceptors.
//     await new Promise((resolve) => setTimeout(resolve, 100));

//     // Warm the dashboard caches so the first protected screen has data immediately.
//     await Promise.allSettled([
//       qc.prefetchQuery({
//         queryKey: ["documents", "recent"],
//         queryFn: () => documentsAPI.list({ page_size: 5, ordering: "-created_at" }).then((r) => r.data),
//       }),
//       qc.prefetchQuery({
//         queryKey: ["documents", "pending", "count"],
//         queryFn: () => documentsAPI.list({ status: "pending_approval", page_size: 1 }).then((r) => r.data.count ?? 0),
//       }),
//       qc.prefetchQuery({
//         queryKey: ["workflow", "my-tasks"],
//         queryFn: () => workflowAPI.myTasks().then((r) => r.data.results ?? r.data),
//       }),
//       qc.prefetchQuery({
//         queryKey: ["audit", "recent"],
//         queryFn: () => api.get("/audit/", { params: { ordering: "-timestamp", page_size: 5 } }).then((r) => r.data.results ?? r.data),
//       }),
//       qc.prefetchQuery({
//         queryKey: ["notifications"],
//         queryFn: () => notificationsAPI.list().then((r) => r.data.results ?? r.data),
//       }),
//     ]);

//     if (tokenData.must_change_password) {
//       navigate("/change-password", { replace: true });
//     } else {
//       navigate("/", { replace: true });
//     }
//   };

//   const onCredentials = async (values: CredForm) => {
//     setLoading(true);
//     try {
//       const { data } = await authAPI.login(values.email, values.password);
//       if (data.mfa_required) {
//         setPendingUserId(data.user_id);
//         setUserEmail(values.email);
//         setStep("otp");
//         toast.info("A 6-digit verification code has been sent to your email.");
//       } else {
//         await completeLogin(data);
//       }
//     } catch (err: any) {
//       toast.error(err?.response?.data?.detail || "Invalid email or password.");
//     } finally {
//       setLoading(false);
//     }
//   };

//   const onOTP = async (values: OTPForm) => {
//     setLoading(true);
//     try {
//       const { data } = await authAPI.verifyOTP(pendingUserId, values.otp);
//       await completeLogin(data);
//     } catch (err: any) {
//       toast.error(err?.response?.data?.detail || "Invalid or expired verification code.");
//     } finally {
//       setLoading(false);
//     }
//   };

//   const resendOTP = async () => {
//     if (resendCooldown > 0) return;
//     setResending(true);
//     try {
//       await authAPI.resendOTP(pendingUserId);
//       toast.success("A new verification code has been sent.");
//       setResendCooldown(60);
//       const timer = setInterval(() => {
//         setResendCooldown((prev) => {
//           if (prev <= 1) { clearInterval(timer); return 0; }
//           return prev - 1;
//         });
//       }, 1000);
//     } catch {
//       toast.error("Unable to resend code. Please try again shortly.");
//     } finally {
//       setResending(false);
//     }
//   };

//   return (
//     <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center p-4">
//       <div className="w-full max-w-md">
//         <div className="text-center mb-8">
//           <div className="flex justify-center">
//             <FlaxemLogo variant="dark" className="h-10" />
//           </div>
//           <p className="text-slate-600 text-sm mt-3">Secure Document Management System</p>
//         </div>

//         <div className="bg-white rounded-2xl shadow-xl border border-slate-100 p-8">
//           {step === "credentials" ? (
//             <>
//               <h2 className="text-xl font-semibold text-slate-900 mb-6">Sign in to your account</h2>
//               <form onSubmit={credForm.handleSubmit(onCredentials)} className="space-y-5">
//                 <div>
//                   <label className="block text-sm font-medium text-slate-700 mb-1">Email address</label>
//                   <div className="relative">
//                     <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
//                     <input
//                       {...credForm.register("email")}
//                       type="email"
//                       className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-colors"
//                       placeholder="you@company.com"
//                       autoComplete="email"
//                       autoFocus
//                     />
//                   </div>
//                   {credForm.formState.errors.email && <p className="text-red-500 text-xs mt-1">{credForm.formState.errors.email.message}</p>}
//                 </div>
//                 <div>
//                   <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
//                   <div className="relative">
//                     <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
//                     <input
//                       {...credForm.register("password")}
//                       type="password"
//                       className="w-full pl-9 pr-3 py-2.5 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary transition-colors"
//                       placeholder="••••••••"
//                       autoComplete="current-password"
//                     />
//                   </div>
//                   {credForm.formState.errors.password && <p className="text-red-500 text-xs mt-1">{credForm.formState.errors.password.message}</p>}
//                 </div>
//                 <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary hover:bg-primary/90 text-white font-medium rounded-lg shadow-sm transition-colors disabled:opacity-70">
//                   {loading && <Loader2 className="w-4 h-4 animate-spin" />}
//                   Sign in <ArrowRight className="w-4 h-4" />
//                 </button>
//               </form>
//             </>
//           ) : (
//             <>
//               <div className="flex items-center gap-4 mb-6">
//                 <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center">
//                   <Mail className="w-6 h-6 text-primary" />
//                 </div>
//                 <div>
//                   <h2 className="font-semibold text-slate-900">Two-Factor Authentication</h2>
//                   <p className="text-sm text-slate-500">We sent a code to <span className="font-medium text-slate-700">{userEmail}</span></p>
//                 </div>
//               </div>
//               <form onSubmit={otpForm.handleSubmit(onOTP)} className="space-y-5">
//                 <div>
//                   <label className="block text-sm font-medium text-slate-700 mb-1">Verification Code</label>
//                   <input
//                     {...otpForm.register("otp")}
//                     className="w-full text-center text-2xl tracking-[0.5em] font-mono py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-primary"
//                     placeholder="000000"
//                     maxLength={6}
//                     autoFocus
//                     onChange={(e) => {
//                       const val = e.target.value.replace(/\D/g, "").slice(0, 6);
//                       otpForm.setValue("otp", val);
//                       if (val.length === 6) otpForm.handleSubmit(onOTP)();
//                     }}
//                   />
//                   {otpForm.formState.errors.otp && <p className="text-red-500 text-xs mt-1">{otpForm.formState.errors.otp.message}</p>}
//                 </div>
//                 <button type="submit" disabled={loading} className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary hover:bg-primary/90 text-white font-medium rounded-lg shadow-sm transition-colors">
//                   {loading && <Loader2 className="w-4 h-4 animate-spin" />}
//                   Verify & Sign In
//                 </button>
//               </form>
//               <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-100">
//                 <button onClick={() => setStep("credentials")} className="text-sm text-slate-500 hover:text-slate-700 transition-colors">← Use a different account</button>
//                 <button onClick={resendOTP} disabled={resending || resendCooldown > 0} className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 disabled:opacity-50">
//                   <RefreshCw className={`w-3.5 h-3.5 ${resending ? "animate-spin" : ""}`} />
//                   {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Code"}
//                 </button>
//               </div>
//             </>
//           )}
//         </div>
//         <p className="text-center text-slate-500 text-xs mt-6">© {new Date().getFullYear()} Flaxem Systems. All rights reserved.</p>
//       </div>
//     </div>
//   );
// }
