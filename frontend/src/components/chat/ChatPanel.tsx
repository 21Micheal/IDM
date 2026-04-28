import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  MessageCircle,
  MoreVertical,
  Search,
  Send,
  Users,
  X,
} from "lucide-react";
import clsx from "clsx";
import { chatAPI, groupsAPI } from "@/services/api";
import { chatWebSocket } from "@/services/chatWebSocket";
import type {
  ChatMessage,
  ChatRoom,
  TypingIndicator,
  User,
  WebSocketMessage,
} from "@/types/chat";

interface Group {
  id: string;
  name: string;
  description?: string;
  member_count?: number;
}

interface ChatPanelProps {
  onClose: () => void;
  initialRoomId?: string;
}

const getCurrentUserId = () => localStorage.getItem("user_id") || "";

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function formatTime(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel({ onClose, initialRoomId }: ChatPanelProps) {
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [showUserList, setShowUserList] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const me = getCurrentUserId();

  // ── Load rooms + users + groups on open ────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [roomsRes, usersRes, groupsRes] = await Promise.all([
          chatAPI.rooms.list(),
          chatAPI.users.list(),
          groupsAPI.list(),
        ]);
        if (!alive) return;
        setRooms(roomsRes.data.results || roomsRes.data);
        setUsers(usersRes.data.results || usersRes.data);
        
        // Process groups data
        const groupsData = groupsRes.data.results || groupsRes.data;
        const processedGroups: Group[] = groupsData.map((group: any) => ({
          id: group.id,
          name: group.name,
          description: group.description,
          member_count: group.member_count || 0,
        }));
        setGroups(processedGroups);
      } catch (e) {
        console.error("Chat load failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ── WebSocket: messages + typing for the active room ──────────────────────
  useEffect(() => {
    const onMessage = (data: WebSocketMessage) => {
      if (!data.message || !selectedRoom) return;
      if (data.message.room !== selectedRoom.id) return;

      setMessages((prev) =>
        prev.find((m) => m.id === data.message!.id)
          ? prev
          : [...prev, data.message!],
      );

      if (data.message.sender.id !== me) {
        chatAPI.messages.markRead([data.message.id]).catch(() => undefined);
      }
    };

    const onTyping = (t: TypingIndicator) => {
      if (!selectedRoom || t.user_id === me) return;
      setTypingUsers((prev) => {
        const next = new Set(prev);
        if (t.is_typing) next.add(t.username);
        else next.delete(t.username);
        return next;
      });
    };

    chatWebSocket.onMessage(onMessage);
    chatWebSocket.onTyping(onTyping);
    return () => {
      chatWebSocket.offMessage(onMessage);
      chatWebSocket.offTyping(onTyping);
    };
  }, [selectedRoom, me]);

  // ── Deep-link via initialRoomId ───────────────────────────────────────────
  useEffect(() => {
    if (initialRoomId) loadRoom(initialRoomId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRoomId]);

  // ── Auto-scroll on new message ────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typingUsers]);

  const loadRoom = async (roomId: string) => {
    try {
      const [roomRes, msgRes] = await Promise.all([
        chatAPI.rooms.get(roomId),
        chatAPI.rooms.getMessages(roomId),
      ]);
      setSelectedRoom(roomRes.data);
      setMessages(msgRes.data.results || msgRes.data);
      chatWebSocket.connectToRoom(roomId);
      chatAPI.rooms.markRead(roomId).catch(() => undefined);
      setRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, unread_count: 0 } : r)),
      );
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      console.error("Open room failed", e);
    }
  };

  const startDirectMessage = async (user: User) => {
    try {
      const res = await chatAPI.rooms.getDirectMessage(user.id);
      const room = res.data as ChatRoom;
      setRooms((prev) =>
        prev.find((r) => r.id === room.id) ? prev : [room, ...prev],
      );
      await loadRoom(room.id);
      setShowUserList(false);
    } catch (e) {
      console.error("DM failed", e);
    }
  };

  const startGroupChat = async (group: Group) => {
    try {
      const res = await chatAPI.rooms.create({
        name: group.name,
        room_type: 'group',
        // Note: You might want to get group members and add them as participants
        // This would require an additional API call to get group members
      });
      const room = res.data as ChatRoom;
      setRooms((prev) => [room, ...prev]);
      await loadRoom(room.id);
      setShowUserList(false);
    } catch (e) {
      console.error("Group chat failed", e);
    }
  };

  const sendMessage = async () => {
    const content = newMessage.trim();
    if (!content || !selectedRoom) return;

    // Optimistic append for instant UX — server WS will reconcile by id
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      room: selectedRoom.id,
      sender: {
        id: me,
        email: "",
        first_name: "",
        last_name: "",
        name: "You",
      },
      content,
      message_type: "text",
      reply_to: null,
      is_edited: false,
      created_at: new Date().toISOString(),
      is_read: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setNewMessage("");

    try {
      // Prefer WS for lowest latency; REST as fallback
      if (chatWebSocket.isConnectedToRoom()) {
        chatWebSocket.sendMessage({ content, message_type: "text" });
      } else {
        await chatAPI.messages.create({
          content,
          room_id: selectedRoom.id,
          message_type: "text",
        });
      }
    } catch (e) {
      console.error("Send failed", e);
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setNewMessage(content);
    }
  };

  // Debounced typing pings
  const handleTyping = () => {
    chatWebSocket.sendTyping(true);
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      chatWebSocket.sendTyping(false);
    }, 1500);
  };

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filteredRooms = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return rooms;
    return rooms.filter(
      (r) =>
        r.name?.toLowerCase().includes(q) ||
        r.participants.some((p) => p.name.toLowerCase().includes(q)),
    );
  }, [rooms, searchQuery]);

  const filteredUsers = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [users, searchQuery]);

  const filteredGroups = useMemo(() => {
    const q = searchQuery.toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) || 
        (g.description && g.description.toLowerCase().includes(q)),
    );
  }, [groups, searchQuery]);

  const roomTitle = (room: ChatRoom) =>
    room.room_type === "direct"
      ? room.participants.find((p) => p.id !== me)?.name ?? room.name
      : room.name;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed bottom-24 right-6 z-40 flex h-[640px] max-h-[calc(100vh-7rem)] w-[760px] max-w-[calc(100vw-3rem)] origin-bottom-right overflow-hidden rounded-2xl border border-border bg-card animate-scale-in"
      style={{ boxShadow: "var(--shadow-elegant)" }}
      role="dialog"
      aria-label="Chat"
    >
      {/* ── Sidebar: rooms / users ──────────────────────────────────── */}
      <aside className="flex w-[280px] flex-shrink-0 flex-col border-r border-border bg-muted/30">
        <div
          className="flex items-center justify-between px-4 py-3 text-primary-foreground"
          style={{ background: "var(--gradient-sidebar)" }}
        >
          <div className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold tracking-wide">Messages</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 border-b border-border bg-card p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={showUserList ? "Find a person…" : "Search chats…"}
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-xs outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30"
            />
          </div>
          <button
            onClick={() => setShowUserList((v) => !v)}
            className={clsx(
              "flex w-full items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              showUserList
                ? "border border-border bg-background text-foreground hover:bg-muted"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {showUserList ? (
              <>
                <ArrowLeft className="h-3.5 w-3.5" /> Back to chats
              </>
            ) : (
              <>
                <Users className="h-3.5 w-3.5" /> New conversation
              </>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {showUserList ? (
            <>
              {/* Groups Section */}
              {filteredGroups.length > 0 && (
                <>
                  <div className="px-2.5 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Groups
                    </p>
                  </div>
                  {filteredGroups.map((group) => (
                    <button
                      key={group.id}
                      onClick={() => startGroupChat(group)}
                      className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-white font-semibold text-xs">
                        {initials(group.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground">
                          {group.name}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          Group • {group.member_count || 0} members
                        </p>
                      </div>
                    </button>
                  ))}
                </>
              )}

              {/* Users Section */}
              {filteredGroups.length > 0 && filteredUsers.length > 0 && (
                <div className="px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    People
                  </p>
                </div>
              )}

              {filteredUsers.length === 0 && filteredGroups.length === 0 ? (
                <EmptyState label="No users or groups found" />
              ) : (
                filteredUsers.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => startDirectMessage(u)}
                    className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <Avatar label={initials(u.name)} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {u.name}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {u.email}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </>
          ) : loading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse rounded-md bg-muted"
                />
              ))}
            </div>
          ) : filteredRooms.length === 0 ? (
            <EmptyState label="No conversations yet" hint="Start a new chat" />
          ) : (
            filteredRooms.map((room) => {
              const active = selectedRoom?.id === room.id;
              const title = roomTitle(room);
              return (
                <button
                  key={room.id}
                  onClick={() => loadRoom(room.id)}
                  className={clsx(
                    "group mb-0.5 flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-accent/15 ring-1 ring-accent/40"
                      : "hover:bg-muted",
                  )}
                >
                  <Avatar label={initials(title)} accent={active} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={clsx(
                          "truncate text-xs",
                          active
                            ? "font-semibold text-foreground"
                            : "font-medium text-foreground",
                        )}
                      >
                        {title}
                      </p>
                      {room.last_message && (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {formatTime(room.last_message.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[11px] text-muted-foreground">
                        {room.last_message
                          ? `${room.last_message.sender.name === title ? "" : `${room.last_message.sender.name.split(" ")[0]}: `}${room.last_message.content}`
                          : "No messages yet"}
                      </p>
                      {room.unread_count > 0 && (
                        <span className="ml-auto inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground">
                          {room.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Conversation pane ───────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col bg-background">
        {selectedRoom ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar label={initials(roomTitle(selectedRoom))} accent />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {roomTitle(selectedRoom)}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {selectedRoom.room_type === "direct"
                      ? "Direct message"
                      : `${selectedRoom.participants.length} participants`}
                  </p>
                </div>
              </div>
              <button className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.map((msg, idx) => {
                const mine = msg.sender.id === me;
                const prev = messages[idx - 1];
                const showAvatar =
                  !mine && (!prev || prev.sender.id !== msg.sender.id);
                return (
                  <div
                    key={msg.id}
                    className={clsx(
                      "flex items-end gap-2 animate-fade-in",
                      mine ? "justify-end" : "justify-start",
                    )}
                  >
                    {!mine && (
                      <div className="w-7">
                        {showAvatar && (
                          <Avatar size="sm" label={initials(msg.sender.name)} />
                        )}
                      </div>
                    )}
                    <div
                      className={clsx(
                        "max-w-[70%] rounded-2xl px-3.5 py-2 text-sm",
                        mine
                          ? "rounded-br-sm bg-primary text-primary-foreground"
                          : "rounded-bl-sm bg-card text-foreground border border-border",
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words leading-relaxed">
                        {msg.content}
                      </p>
                      <p
                        className={clsx(
                          "mt-1 text-[10px]",
                          mine
                            ? "text-primary-foreground/60"
                            : "text-muted-foreground",
                        )}
                      >
                        {formatTime(msg.created_at)}
                        {msg.is_edited && " · edited"}
                      </p>
                    </div>
                  </div>
                );
              })}

              {typingUsers.size > 0 && (
                <div className="flex items-center gap-2 pl-9 animate-fade-in">
                  <div className="flex items-center gap-1 rounded-full bg-card border border-border px-3 py-1.5">
                    <Dot delay="0ms" />
                    <Dot delay="120ms" />
                    <Dot delay="240ms" />
                  </div>
                  <span className="text-[11px] italic text-muted-foreground">
                    {Array.from(typingUsers).join(", ")}{" "}
                    {typingUsers.size === 1 ? "is" : "are"} typing
                  </span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div className="border-t border-border bg-card px-4 py-3">
              <div className="flex items-end gap-2 rounded-xl border border-border bg-background px-3 py-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
                <input
                  ref={inputRef}
                  type="text"
                  value={newMessage}
                  onChange={(e) => {
                    setNewMessage(e.target.value);
                    handleTyping();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Write a message…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <button
                  onClick={sendMessage}
                  disabled={!newMessage.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-all hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                  aria-label="Send"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <div
              className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl text-accent-foreground"
              style={{ background: "var(--gradient-accent)" }}
            >
              <MessageCircle className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              Pick a conversation
            </h3>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              Choose a chat from the left, or start a new one with a teammate.
              Messages deliver instantly.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Small atoms ─────────────────────────────────────────────────────────────

function Avatar({
  label,
  size = "md",
  accent = false,
}: {
  label: string;
  size?: "sm" | "md";
  accent?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-full font-semibold",
        size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs",
        accent
          ? "bg-accent text-accent-foreground"
          : "bg-primary/10 text-primary",
      )}
    >
      {label}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70"
      style={{ animationDelay: delay, animationDuration: "1s" }}
    />
  );
}

function EmptyState({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <MessageCircle className="mb-2 h-8 w-8 text-muted-foreground/40" />
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}
