// src/pages/LoginPage.tsx
"use client";

import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2, ShieldCheck } from "lucide-react";

import { oidcLogin } from "@/lib/oidcClient";
import { toast } from "@/components/ui/vault-toast";

import dmsLogo from "@/assets/images/FSEDMSlogo.png";

// ── Main LoginPage ─────────────────────────────────────────────────────────────
//
// Primary auth path: single "Sign in with Keycloak" button → PKCE flow.
//
// Break-glass path: clicking the version tag 5 times in quick succession
// reveals a hidden link to the legacy email+password endpoint
// (/auth/local — not wired in the router, so it simply deep-links to the
// Django admin for break-glass admin access).  This keeps the API-level
// local auth alive without exposing a form to ordinary users.

export default function LoginPage() {
  const navigate   = useNavigate();
  const location   = useLocation();
  const [loading, setLoading]   = useState(false);
  const [checking, setChecking] = useState(true);  // SSO probe in progress

  // ── SSO silent-renew check disabled to prevent flickering issues
  // Users always click the sign-in button to authenticate
  useEffect(() => {
    setChecking(false);
  }, []);

  const handleSignIn = async () => {
    setLoading(true);
    try {
      // Preserve the original destination so OIDCCallbackPage can redirect back
      await oidcLogin();
      // Browser navigates away; no further code runs here
    } catch {
      toast.error("Could not reach the identity provider. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-sky-50 via-sky-100 to-blue-200 flex items-center justify-center p-4">
      <div className="w-full max-w-[440px]">
        <div className="shadow-[0_2px_6px_rgba(0,0,0,0.15)]">

          {/* Logo header */}
          <div
            className="flex justify-center px-10 pt-8 pb-6"
            style={{ backgroundColor: "#dff0fb" }}
          >
            <img
              src={dmsLogo}
              alt="Flaxem Document Management System"
              className="h-24 w-auto"
            />
          </div>

          {/* Sign-in card */}
          <div
            style={{
              background:
                "var(--gradient-sidebar, linear-gradient(180deg, hsl(203 64% 42%) 0%, hsl(203 78% 34%) 100%))",
            }}
          >
            <div className="px-10 pt-8 pb-10">
              <h2 className="text-[15px] font-semibold text-white">Sign in</h2>
              <p className="mt-1.5 text-[13px] text-white/70">
                Authenticate with your organisational account.
              </p>

              <div className="mt-7">
                {checking ? (
                  /* SSO probe running */
                  <div className="flex items-center gap-2 text-[13px] text-white/60">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Checking for existing session…</span>
                  </div>
                ) : (
                  <button
                    id="oidc-signin-btn"
                    type="button"
                    onClick={handleSignIn}
                    disabled={loading}
                    className="
                      inline-flex w-full items-center justify-center gap-2.5
                      h-10 bg-white px-6
                      text-[14px] font-medium text-[#155a86]
                      transition-all hover:bg-white/90 hover:shadow-md
                      disabled:opacity-70
                    "
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-4 w-4" />
                    )}
                    {loading ? "Redirecting…" : "Sign in with Keycloak"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="mt-4 text-center text-[11px] text-gray-400 select-none">
          Flaxem Document Management System
        </p>
      </div>
    </div>
  );
}