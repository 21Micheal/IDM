import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { MessageCircleMore, X } from "lucide-react";
import { chatAPI } from "@/services/api";
import { chatWebSocket } from "@/services/chatWebSocket";
import { vaultToast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import type { WebSocketMessage } from "@/types/chat";

const ChatPanel = lazy(() =>
  import("./ChatPanel").then((module) => ({ default: module.ChatPanel }))
);

/**
 * Header chat launcher.
 * - Persistent unread badge (polled + WS-incremented)
 * - Receiver-side toast pop-up via vaultToast on every chat_notification
 * - Click toast to deep-link into the right room
 */
export function ChatLauncher({ variant = "light" }: { variant?: "light" | "blue" }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [open, setOpen] = useState(false);
  const [initialRoomId, setInitialRoomId] = useState<string | undefined>();
  const [activeRoomId, setActiveRoomId] = useState<string | undefined>();
  const [unread, setUnread] = useState(0);
  const [pulse, setPulse] = useState(false);
  const openRef = useRef(open);
  const activeRoomIdRef = useRef(activeRoomId);
  const lastServerUnreadRef = useRef<number | null>(null);
  const lastSocketPopupAtRef = useRef(0);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);

  // ── Initial unread + 30s fallback poll ────────────────────────────────────
  useEffect(() => {
    if (!accessToken) {
      setUnread(0);
      return;
    }

    let mounted = true;
    const fetchUnread = async () => {
      // This is a fallback to the realtime WebSocket; skip it while the tab is
      // backgrounded so idle tabs stop polling and don't add baseline load.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await chatAPI.unread.count();
        if (!mounted) return;
        const nextUnread = r.data.unread_count ?? 0;
        const previousServerUnread = lastServerUnreadRef.current;
        const recentlyToasted = Date.now() - lastSocketPopupAtRef.current < 5000;

        setUnread(nextUnread);
        lastServerUnreadRef.current = nextUnread;

        if (
          previousServerUnread !== null &&
          nextUnread > previousServerUnread &&
          !recentlyToasted &&
          !openRef.current
        ) {
          setPulse(true);
          window.setTimeout(() => setPulse(false), 1200);
          vaultToast.message("New chat message", {
            description: "Open chat to read the latest message.",
            action: {
              label: "Open",
              onClick: () => setOpen(true),
            },
          });
        }
      } catch {
        /* silent */
      }
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 30_000);
    // Refresh immediately when the user returns to a backgrounded tab, since
    // polling was paused while it was hidden.
    const onVisible = () => { if (!document.hidden) fetchUnread(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accessToken]);

  // ── Realtime: increment badge + show vault toast ──────────────────────────
  useEffect(() => {
    if (!accessToken) return;

    const handler = (data: WebSocketMessage) => {
      if (data.type !== "chat_notification" || !data.notification) return;
      const n = data.notification;
      if (seenNotificationIdsRef.current.has(n.id)) return;
      seenNotificationIdsRef.current.add(n.id);
      if (seenNotificationIdsRef.current.size > 100) {
        const [oldest] = seenNotificationIdsRef.current;
        seenNotificationIdsRef.current.delete(oldest);
      }

      setUnread((count) => {
        const next = count + 1;
        lastServerUnreadRef.current = Math.max(lastServerUnreadRef.current ?? 0, next);
        return next;
      });
      lastSocketPopupAtRef.current = Date.now();
      setPulse(true);
      window.setTimeout(() => setPulse(false), 1200);

      // Don't toast if the panel is already open on that room
      if (openRef.current && activeRoomIdRef.current === n.room_id) return;

      vaultToast.message(`${n.sender.name} · ${n.room_name}`, {
        id: `chat-${n.id}`,
        description: n.message,
        action: {
          label: "Open",
          onClick: () => {
            setInitialRoomId(n.room_id);
            setOpen(true);
          },
        },
      });
    };

    chatWebSocket.onNotification(handler);
    return () => chatWebSocket.offNotification(handler);
  }, [accessToken]);

  const handleOpen = () => {
    setOpen(true);
    // Optimistically clear badge — server marks read on room open
    setUnread(0);
    lastServerUnreadRef.current = 0;
  };

  const isBlue = variant === "blue";
  const launcherClassName = isBlue
    ? "group relative flex h-9 w-9 items-center justify-center text-white/85 transition-colors hover:bg-white/10 hover:text-white active:scale-95"
    : "group relative flex h-9 w-9 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF6FB] hover:text-[#287EAD] active:scale-95";

  const handleClose = () => {
    setOpen(false);
    setInitialRoomId(undefined);
    setActiveRoomId(undefined);
  };

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      {/* ── Launcher ───────────────────────────────────────────────────── */}
      <button
        onClick={open ? handleClose : handleOpen}
        aria-label={open ? "Close chat" : "Open chat"}
        title={open ? "Close chat" : "Open chat"}
        className={launcherClassName}
      >
        {/* Animated accent ring on new message */}
        <span
          className={`pointer-events-none absolute inset-0 ring-2 ring-[#287EAD] transition-opacity ${
            pulse ? "animate-ping opacity-70" : "opacity-0"
          }`}
        />
        {open && <span className={`absolute inset-x-1 bottom-0 h-0.5 ${isBlue ? "bg-white" : "bg-[#287EAD]"}`} />}

        {open ? (
          <X className="h-5 w-5" strokeWidth={2.25} />
        ) : (
          <MessageCircleMore className="h-5 w-5" strokeWidth={2.25} />
        )}

        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] animate-pulse items-center justify-center bg-red-700 px-1 text-[9px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* ── Header anchored panel ──────────────────────────────────────── */}
      {open && (
        <Suspense fallback={null}>
          <ChatPanel
            onClose={handleClose}
            initialRoomId={initialRoomId}
            onActiveRoomChange={setActiveRoomId}
          />
        </Suspense>
      )}
    </>
  );
}
