// src/pages/OIDCCallbackPage.tsx
//
// Handles the Keycloak authorization-code redirect back to the DMS.
//
// Flow:
//   1. oidc-client-ts completes the PKCE code exchange with Keycloak
//      (this is fully handled by handleOidcCallback() — no network call to DMS yet)
//   2. We POST the resulting id_token to Django's /api/auth/oidc/exchange/
//   3. Django validates the token, resolves the DMS user, and returns
//      a simplejwt access + refresh pair (same shape as VerifyOTPView)
//   4. We store the tokens in Zustand and redirect to the original page

import { useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { handleOidcCallback } from "@/lib/oidcClient";
import { api } from "@/services/api";
import {
  useAuthStore,
  applyServerSessionPolicy,
} from "@/store/authStore";
import type { AuthUser, ServerSessionPolicy } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";

export default function OIDCCallbackPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setTokens, setUser, setSessionPolicy } = useAuthStore();
  const processed = useRef(false);   // prevent double-execution in React StrictMode

  useEffect(() => {
    if (processed.current) return;
    processed.current = true;

    (async () => {
      try {
        // Check if this is a valid callback (has code/state params)
        const params = new URLSearchParams(location.search);
        if (!params.has("code") && !params.has("state")) {
          // No callback params - this might be a direct navigation, redirect to login
          navigate("/login", { replace: true });
          return;
        }

        // 1. Complete PKCE exchange with Keycloak
        const oidcUser = await handleOidcCallback();
        if (!oidcUser?.id_token) {
          throw new Error("No id_token returned from Keycloak.");
        }

        // 2. Exchange with Django backend → simplejwt pair
        const res = await api.post("/auth/oidc/exchange/", {
          id_token: oidcUser.id_token,
        });

        const {
          access,
          refresh,
          user,
          session_policy,
        }: {
          access: string;
          refresh: string;
          user: AuthUser;
          session_policy: ServerSessionPolicy;
        } = res.data;

        // 3. Store in Zustand (same flow as VerifyOTPView response)
        applyServerSessionPolicy(session_policy);
        setTokens(access, refresh);
        setUser(user);

        // 4. Navigate to the original page or dashboard
        const from =
          (location.state as { from?: string } | null)?.from ?? "/";
        navigate(from, { replace: true });
      } catch (err: unknown) {
        console.error("OIDC callback error:", err);
        toast.error("Sign-in failed. Please try again.");
        navigate("/login", { replace: true });
      }
    })();
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0f1117]">
      <div className="flex flex-col items-center gap-4 text-white/70">
        <Loader2 className="h-10 w-10 animate-spin text-blue-400" />
        <p className="text-sm tracking-wide">Completing sign-in…</p>
      </div>
    </div>
  );
}
