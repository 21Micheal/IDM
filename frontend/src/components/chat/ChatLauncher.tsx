import { Suspense, lazy, useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { chatAPI } from "@/services/api";
import { chatWebSocket } from "@/services/chatWebSocket";
import { vaultToast } from "@/components/ui/vault-toast";
import type { WebSocketMessage } from "@/types/chat";

const ChatPanel = lazy(() =>
  import("./ChatPanel").then((module) => ({ default: module.ChatPanel }))
);

/**
 * Floating bottom-right chat launcher.
 * - Persistent unread badge (polled + WS-incremented)
 * - Receiver-side toast pop-up via vaultToast on every chat_notification
 * - Click toast to deep-link into the right room
 */
export function ChatLauncher() {
  const [open, setOpen] = useState(false);
  const [initialRoomId, setInitialRoomId] = useState<string | undefined>();
  const [unread, setUnread] = useState(0);
  const [pulse, setPulse] = useState(false);

  // ── Initial unread + 30s fallback poll ────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const fetchUnread = async () => {
      try {
        const r = await chatAPI.unread.count();
        if (!mounted) return;
        setUnread(r.data.unread_count ?? 0);
      } catch {
        /* silent */
      }
    };
    fetchUnread();
    const id = setInterval(fetchUnread, 30_000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // ── Realtime: increment badge + show vault toast ──────────────────────────
  useEffect(() => {
    const handler = (data: WebSocketMessage) => {
      if (data.type !== "chat_notification" || !data.notification) return;

      setUnread((n) => n + 1);
      setPulse(true);
      window.setTimeout(() => setPulse(false), 1200);

      // Don't toast if the panel is already open on that room
      if (open && initialRoomId === data.notification.room_id) return;

      const n = data.notification;
      vaultToast.info(`${n.sender.name} · ${n.room_name}`, {
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
  }, [open, initialRoomId]);

  const handleOpen = () => {
    setOpen(true);
    // Optimistically clear badge — server marks read on room open
    setUnread(0);
  };

  const handleClose = () => {
    setOpen(false);
    setInitialRoomId(undefined);
  };

  return (
    <>
      {/* ── Launcher (FAB) ─────────────────────────────────────────────── */}
      <button
        onClick={open ? handleClose : handleOpen}
        aria-label={open ? "Close chat" : "Open chat"}
        className="group fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full text-primary-foreground transition-all duration-300 hover:scale-105 active:scale-95"
        style={{
          background: "var(--gradient-sidebar)",
          boxShadow: "var(--shadow-elegant)",
        }}
      >
        {/* Animated accent ring on new message */}
        <span
          className={`pointer-events-none absolute inset-0 rounded-full ring-2 ring-accent transition-opacity ${
            pulse ? "animate-ping opacity-70" : "opacity-0"
          }`}
        />
        <span className="absolute inset-0 rounded-full ring-1 ring-sidebar-border/40" />

        {open ? (
          <X className="h-5 w-5" strokeWidth={2.25} />
        ) : (
          <MessageSquare className="h-5 w-5" strokeWidth={2.25} />
        )}

        {!open && unread > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-destructive px-1.5 text-[10px] font-bold text-destructive-foreground ring-2 ring-background animate-pulse">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* ── Slide-up panel ─────────────────────────────────────────────── */}
      {open && (
        <Suspense fallback={null}>
          <ChatPanel onClose={handleClose} initialRoomId={initialRoomId} />
        </Suspense>
      )}
    </>
  );
}
