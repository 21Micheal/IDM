/**
 * src/lib/oidcClient.ts — DMS (IDM)
 *
 * Lazily constructs the OIDC UserManager so native (standalone) deployments
 * never talk to Keycloak. Session-monitor wiring only runs after first use.
 *
 * monitorSession loop fix (same as financial system):
 *   - UserSignedOut handler guards on isAuthenticated — no-op when already
 *     logged out, preventing the /login reload loop.
 *   - removeUser() clears the stale OIDC user (session_state) from
 *     localStorage before redirecting so the monitor stops firing.
 *   - oidcLogout() also calls removeUser() before signoutRedirect().
 */
import { UserManager, WebStorageStateStore, type User } from "oidc-client-ts";
import { useAuthStore } from "@/store/authStore";

const KEYCLOAK_URL =
  import.meta.env.VITE_OIDC_AUTHORITY ?? "http://localhost:8080/realms/idp-dev";

const CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID ?? "dms-client";

let oidcManager: UserManager | null = null;
let listenersAttached = false;

function getOidcManager(): UserManager {
  if (!oidcManager) {
    oidcManager = new UserManager({
      authority: KEYCLOAK_URL,
      client_id: CLIENT_ID,
      redirect_uri: `${window.location.origin}/auth/callback`,
      silent_redirect_uri: `${window.location.origin}/auth/silent-renew.html`,
      post_logout_redirect_uri: `${window.location.origin}/login`,
      response_type: "code",
      scope: "openid profile email roles",
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      monitorSession: true,
    });
  }

  if (!listenersAttached) {
    listenersAttached = true;
    // Fired when the Keycloak session ends from any registered client.
    oidcManager.events.addUserSignedOut(async () => {
      const { isAuthenticated, logout } = useAuthStore.getState();

      // GUARD: only act when we have a live local session.
      // Prevents the /login reload loop caused by stale session_state in localStorage.
      if (!isAuthenticated) return;

      // Clear the OIDC user (and its session_state) so the monitor has nothing to
      // track on the next page load, stopping any further UserSignedOut events.
      try {
        await oidcManager?.removeUser();
      } catch {
        /* ignore */
      }

      logout();
      window.location.replace("/login");
    });
  }

  return oidcManager;
}

/** Redirect the browser to the Keycloak login page. */
export async function oidcLogin(): Promise<void> {
  await getOidcManager().signinRedirect({
    extraQueryParams: { prompt: "select_account" },
  });
}

/** Handle the authorization code callback after Keycloak redirects back. */
export async function handleOidcCallback(): Promise<User> {
  return await getOidcManager().signinRedirectCallback();
}

/** Attempt a silent token renewal using an invisible iframe. */
export async function trySilentRenew(): Promise<User | null> {
  try {
    return await getOidcManager().signinSilent();
  } catch {
    return null;
  }
}

/**
 * End the Keycloak session. MUST be called last (redirects the browser).
 * Caller must blacklist the refresh token and clear local state first.
 */
export async function oidcLogout(idToken?: string | null): Promise<void> {
  const manager = getOidcManager();
  try {
    // Clear OIDC user from localStorage BEFORE redirecting to prevent the
    // session monitor from firing UserSignedOut on the /login landing page.
    try {
      await manager.removeUser();
    } catch {
      /* ignore */
    }
    await manager.signoutRedirect({
      id_token_hint: idToken ?? undefined,
      post_logout_redirect_uri: `${window.location.origin}/login`,
    });
  } catch (err) {
    console.warn("Keycloak signout failed:", err);
    try {
      await manager.removeUser();
    } catch {
      /* ignore */
    }
    window.location.replace("/login");
  }
}

/**
 * Clear local OIDC state without signing out from Keycloak.
 * Use when the backend session expires but you want to preserve SSO.
 */
export async function clearLocalOidcState(): Promise<void> {
  if (!oidcManager) return;
  try {
    await oidcManager.removeUser();
  } catch {
    /* ignore */
  }
}
