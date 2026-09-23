/**
 * src/lib/oidcClient.ts
 *
 * Configures the oidc-client-ts UserManager for the DMS PKCE flow.
 *
 * Split-horizon URLs (matches idp/README.md §5 and IDM/settings.py):
 *   authority   → browser-facing localhost URL (Keycloak OIDC discovery)
 *   JWKS fetch  → handled server-side by Django via internal keycloak:8080
 *
 * Exports thin helper functions so the rest of the app never imports
 * UserManager directly.
 */

import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const KEYCLOAK_URL = import.meta.env.VITE_OIDC_AUTHORITY
  ?? "http://localhost:8080/realms/idp-dev";

const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID ?? "dms-client";

export const oidcManager = new UserManager({
  authority:              KEYCLOAK_URL,
  client_id:              CLIENT_ID,
  redirect_uri:           `${window.location.origin}/auth/callback`,
  silent_redirect_uri:    `${window.location.origin}/auth/silent-renew.html`,
  post_logout_redirect_uri: window.location.origin,
  response_type:          "code",
  scope:                  "openid profile email roles",
  // Store OIDC session in sessionStorage (cleared on tab close)
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

/** Redirect the browser to the Keycloak login page. */
export async function oidcLogin(): Promise<void> {
  await oidcManager.signinRedirect({ extraQueryParams: { prompt: "select_account" } });
}

/**
 * Handle the authorization code callback after Keycloak redirects back.
 * Returns the oidc-client-ts User object (which contains id_token).
 */
export async function handleOidcCallback() {
  return await oidcManager.signinRedirectCallback();
}

/**
 * Attempt a silent token renewal using an invisible iframe.
 * Returns the User if an active Keycloak session exists, null otherwise.
 * Used on the login page to auto-login when SSO is already established.
 */
export async function trySilentRenew() {
  try {
    return await oidcManager.signinSilent();
  } catch {
    // No active Keycloak session — user must click the login button
    return null;
  }
}

/**
 * End the Keycloak session and clear local OIDC state.
 * This actually signs out from Keycloak (invalidating the session) via signoutRedirect.
 * The browser will be redirected to Keycloak and then back to the post_logout_redirect_uri.
 */
export async function oidcLogout(): Promise<void> {
  try {
    // Sign out from Keycloak - this invalidates the Keycloak session
    // This will redirect the browser, so no code after this will execute
    await oidcManager.signoutRedirect();
  } catch (err) {
    // If signoutRedirect fails (e.g., no active session), at least clear local state
    console.warn("Keycloak signout failed, clearing local state:", err);
    try {
      await oidcManager.removeUser();
    } catch {
      try {
        sessionStorage.clear();
      } catch {}
    }
  }
}

/**
 * Clear local OIDC state without signing out from Keycloak.
 * Use this when you want to clear local tokens but keep the Keycloak session alive
 * (e.g., when the backend session expires but you want to preserve SSO capability).
 */
export async function clearLocalOidcState(): Promise<void> {
  try {
    await oidcManager.removeUser();
  } catch {
    try {
      sessionStorage.clear();
    } catch {}
  }
}
