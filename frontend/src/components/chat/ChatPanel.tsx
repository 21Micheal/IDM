import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  MessageCircle,
  MoreVertical,
  Plus,
  Search,
  Send,
  X,
} from "lucide-react";
import clsx from "clsx";
import { chatAPI, groupsAPI } from "@/services/api";
import { chatWebSocket } from "@/services/chatWebSocket";
import { useAuthStore } from "@/store/authStore";
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
  onActiveRoomChange?: (roomId?: string) => void;
}

interface GroupMembership {
  user?: User;
}

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function userLabel(user?: Partial<User> | null) {
  if (!user) return "Unknown";
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return user.name || fullName || user.email || "Unknown";
}

function firstName(user?: Partial<User> | null) {
  return userLabel(user).split(/\s+/)[0] || "Someone";
}

function otherParticipants(room: ChatRoom, currentUserId: string) {
  return room.participants.filter((participant) => participant.id !== currentUserId);
}

const PENDING_DIRECT_PREFIX = "pending-direct-";
const PENDING_GROUP_PREFIX = "pending-group-";

function isPendingRoom(room?: ChatRoom | null) {
  return !!room && (room.id.startsWith(PENDING_DIRECT_PREFIX) || room.id.startsWith(PENDING_GROUP_PREFIX));
}

function messageRoomId(message: ChatMessage) {
  return message.room || (message as ChatMessage & { room_id?: string }).room_id;
}

function formatTime(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatPanel({ onClose, initialRoomId, onActiveRoomChange }: ChatPanelProps) {
  const currentUser = useAuthStore((state) => state.user);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [chatSearchQuery, setChatSearchQuery] = useState("");
  const [recipientSearchQuery, setRecipientSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [showComposer, setShowComposer] = useState(false);
  const [composerLoading, setComposerLoading] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const seenNotificationIdsRef = useRef<Set<string>>(new Set());

  const me = currentUser?.id ?? "";
  const currentUserName = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(" ").trim() || "You";
  const chatCurrentUser = currentUser
    ? {
        id: currentUser.id,
        email: currentUser.email,
        first_name: currentUser.first_name,
        last_name: currentUser.last_name,
        name: [currentUser.first_name, currentUser.last_name].filter(Boolean).join(" ").trim() || currentUser.email || "You",
      }
    : null;

  // ── Load rooms on open ────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const roomsRes = await chatAPI.rooms.list();
        if (!alive) return;
        setRooms(roomsRes.data.results || roomsRes.data);
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

  // ── Load possible recipients only when someone starts composing ───────────────
  useEffect(() => {
    if (!showComposer || users.length > 0 || groups.length > 0) return;

    let alive = true;
    setComposerLoading(true);
    (async () => {
      try {
        const [usersRes, groupsRes] = await Promise.all([
          chatAPI.users.list(),
          groupsAPI.list(),
        ]);
        if (!alive) return;

        setUsers((usersRes.data.results || usersRes.data).filter((user: User) => user.id !== me));

        const groupsData = groupsRes.data.results || groupsRes.data;
        const processedGroups: Group[] = groupsData.map((group: any) => ({
          id: group.id,
          name: group.name,
          description: group.description,
          member_count: group.member_count || 0,
        }));
        setGroups(processedGroups);
      } catch (e) {
        console.error("Chat recipients load failed", e);
      } finally {
        if (alive) setComposerLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [showComposer, users.length, groups.length, me]);

  // ── WebSocket: messages + typing for the active room ──────────────────────
  useEffect(() => {
    const onMessage = (data: WebSocketMessage) => {
      if (!data.message || !selectedRoom) return;
      if (messageRoomId(data.message) !== selectedRoom.id) return;

      setMessages((prev) => {
        if (prev.find((m) => m.id === data.message!.id)) return prev;
        if (data.message!.client_id) {
          const optimisticIndex = prev.findIndex((m) => m.id === data.message!.client_id);
          if (optimisticIndex !== -1) {
            return prev.map((m, index) => (index === optimisticIndex ? data.message! : m));
          }
        }
        return [...prev, data.message!];
      });
      setRooms((prev) =>
        prev.map((room) =>
          room.id === selectedRoom.id
            ? { ...room, last_message: data.message!, unread_count: 0 }
            : room,
        ),
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

  useEffect(() => {
    return () => {
      chatWebSocket.disconnectChat();
      onActiveRoomChange?.(undefined);
    };
  }, [onActiveRoomChange]);

  // ── Keep the room list live for messages arriving outside the active room ──
  useEffect(() => {
    const onNotification = (data: WebSocketMessage) => {
      if (data.type !== "chat_notification" || !data.notification) return;
      const notification = data.notification;
      if (seenNotificationIdsRef.current.has(notification.id)) return;
      seenNotificationIdsRef.current.add(notification.id);
      if (seenNotificationIdsRef.current.size > 100) {
        const [oldest] = seenNotificationIdsRef.current;
        seenNotificationIdsRef.current.delete(oldest);
      }
      if (selectedRoom?.id === notification.room_id) return;

      const lastMessage = {
        id: notification.id,
        content: notification.message,
        sender: notification.sender,
        created_at: notification.created_at,
        message_type: "text",
      };

      setRooms((prev) => {
        const existingRoom = prev.find((room) => room.id === notification.room_id);
        if (!existingRoom) return prev;
        return prev
          .map((room) =>
            room.id === notification.room_id
              ? {
                  ...room,
                  last_message: lastMessage,
                  unread_count: room.unread_count + 1,
                  updated_at: notification.created_at,
                }
              : room,
          )
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
      });
    };

    chatWebSocket.onNotification(onNotification);
    return () => chatWebSocket.offNotification(onNotification);
  }, [selectedRoom?.id]);

  // ── Deep-link via initialRoomId ───────────────────────────────────────────
  useEffect(() => {
    if (initialRoomId) loadRoom(initialRoomId);
     
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
      onActiveRoomChange?.(roomId);
      chatWebSocket.connectToRoom(roomId);
      chatAPI.rooms.markRead(roomId).catch(() => undefined);
      setRooms((prev) =>
        prev.map((r) => (r.id === roomId ? { ...r, unread_count: 0 } : r)),
      );
      setShowComposer(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (e) {
      console.error("Open room failed", e);
    }
  };

  const startDirectMessage = async (user: User) => {
    try {
      const existingRoom = rooms.find(
        (room) =>
          room.room_type === "direct" &&
          otherParticipants(room, me)[0]?.id === user.id,
      );

      if (existingRoom) {
        await loadRoom(existingRoom.id);
      } else {
        setSelectedRoom({
          id: `${PENDING_DIRECT_PREFIX}${user.id}`,
          room_type: "direct",
          name: userLabel(user),
          participants: [
            chatCurrentUser ?? {
              id: me,
              email: currentUser?.email ?? "",
              first_name: currentUser?.first_name ?? "",
              last_name: currentUser?.last_name ?? "",
              name: currentUserName,
            },
            user,
          ],
          created_by: chatCurrentUser ?? {
            id: me,
            email: currentUser?.email ?? "",
            first_name: currentUser?.first_name ?? "",
            last_name: currentUser?.last_name ?? "",
            name: currentUserName,
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          is_active: true,
          last_message: null,
          unread_count: 0,
        } as ChatRoom);
        setMessages([]);
      }

      setShowComposer(false);
      setRecipientSearchQuery("");
    } catch (e) {
      console.error("DM failed", e);
    }
  };

  const startGroupChat = async (group: Group) => {
    try {
      const existingRoom = rooms.find(
        (room) => room.room_type === "group" && room.name === group.name,
      );
      if (existingRoom) {
        await loadRoom(existingRoom.id);
        setShowComposer(false);
        setRecipientSearchQuery("");
        return;
      }

      const membersRes = await groupsAPI.members(group.id);
      const memberships = (membersRes.data.results || membersRes.data) as GroupMembership[];
      const participantIds = memberships
        .map((membership) => membership.user?.id)
        .filter((id): id is string => Boolean(id && id !== me));

      if (participantIds.length === 0) {
        console.warn("Group chat requires at least one other active member");
        return;
      }

      const participants = memberships
        .map((membership) => membership.user)
        .filter((user): user is User => Boolean(user && user.id !== me));

      setSelectedRoom({
        id: `${PENDING_GROUP_PREFIX}${group.id}`,
        room_type: "group",
        name: group.name,
        participants: [
          chatCurrentUser ?? {
            id: me,
            email: currentUser?.email ?? "",
            first_name: currentUser?.first_name ?? "",
            last_name: currentUser?.last_name ?? "",
            name: currentUserName,
          },
          ...participants,
        ],
        created_by: chatCurrentUser ?? {
          id: me,
          email: currentUser?.email ?? "",
          first_name: currentUser?.first_name ?? "",
          last_name: currentUser?.last_name ?? "",
          name: currentUserName,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_active: true,
        last_message: null,
        unread_count: 0,
      } as ChatRoom);
      setMessages([]);
      setShowComposer(false);
      setRecipientSearchQuery("");
    } catch (e) {
      console.error("Group chat failed", e);
    }
  };

  const createActualRoomForPending = async (pendingRoom: ChatRoom) => {
    if (pendingRoom.room_type === "direct") {
      const recipient = otherParticipants(pendingRoom, me)[0];
      if (!recipient) throw new Error("Missing direct recipient");

      const res = await chatAPI.rooms.create({
        room_type: "direct",
        participant_ids: [recipient.id],
      });
      const room = res.data as ChatRoom;
      setRooms((prev) => (prev.find((r) => r.id === room.id) ? prev : [room, ...prev]));
      await loadRoom(room.id);
      return room;
    }

    const participantIds = otherParticipants(pendingRoom, me).map((user) => user.id);
    if (participantIds.length === 0) {
      throw new Error("Group chat requires at least one other active member");
    }

    const res = await chatAPI.rooms.create({
      name: pendingRoom.name || "Group chat",
      room_type: "group",
      participant_ids: participantIds,
    });
    const room = res.data as ChatRoom;
    setRooms((prev) => (prev.find((r) => r.id === room.id) ? prev : [room, ...prev]));
    await loadRoom(room.id);
    return room;
  };

  const sendMessage = async () => {
    const content = newMessage.trim();
    if (!content || !selectedRoom) return;

    let room = selectedRoom;
    if (isPendingRoom(selectedRoom)) {
      try {
        room = await createActualRoomForPending(selectedRoom);
      } catch (e) {
        console.error("Send failed due to room creation", e);
        setNewMessage(content);
        return;
      }
    }

    // Optimistic append for instant UX — server WS will reconcile by id
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`,
      room: room.id,
      sender: {
        id: me,
        email: currentUser?.email ?? "",
        first_name: currentUser?.first_name ?? "",
        last_name: currentUser?.last_name ?? "",
        name: currentUserName,
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
      setRooms((prev) =>
        prev.map((roomItem) =>
          roomItem.id === room.id
            ? {
                ...roomItem,
                last_message: {
                  id: optimistic.id,
                  content,
                  sender: optimistic.sender,
                  created_at: optimistic.created_at,
                  message_type: optimistic.message_type,
                },
                updated_at: optimistic.created_at,
              }
            : roomItem,
        ),
      );

      // Prefer WS for lowest latency; REST as fallback
      if (chatWebSocket.isConnectedToRoom()) {
        const sent = chatWebSocket.sendMessage({
          content,
          message_type: "text",
          client_id: optimistic.id,
        });
        if (!sent) throw new Error("Chat socket not connected");
      } else {
        const res = await chatAPI.messages.create({
          content,
          room_id: room.id,
          message_type: "text",
          client_id: optimistic.id,
        });
        const saved = res.data as ChatMessage;
        setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? saved : m)));
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
    const q = chatSearchQuery.toLowerCase();
    if (!q) return rooms;
    return rooms.filter(
      (r) =>
        roomTitle(r).toLowerCase().includes(q) ||
        roomSubtitle(r).toLowerCase().includes(q) ||
        lastMessagePreview(r).toLowerCase().includes(q) ||
        r.participants.some((p) => userLabel(p).toLowerCase().includes(q)),
    );
  }, [rooms, chatSearchQuery, me]);

  const filteredUsers = useMemo(() => {
    const q = recipientSearchQuery.trim().toLowerCase();
    if (!showComposer || !q) return [];
    return users
      .filter(
        (u) =>
          userLabel(u).toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [users, recipientSearchQuery, showComposer]);

  const filteredGroups = useMemo(() => {
    const q = recipientSearchQuery.trim().toLowerCase();
    if (!showComposer || !q) return [];
    return groups
      .filter(
        (g) =>
          g.name.toLowerCase().includes(q) ||
          (g.description && g.description.toLowerCase().includes(q)),
      )
      .slice(0, 6);
  }, [groups, recipientSearchQuery, showComposer]);

  function roomTitle(room: ChatRoom) {
    const others = otherParticipants(room, me);
    if (room.room_type === "direct") {
      return userLabel(others[0]) || room.name || "Direct message";
    }

    return room.name || others.map(userLabel).join(", ") || "Group chat";
  }

  function roomSubtitle(room: ChatRoom) {
    const others = otherParticipants(room, me);
    if (room.room_type === "direct") {
      return others[0]?.email || "Direct message";
    }

    const count = room.participants.length;
    return `${count} participant${count === 1 ? "" : "s"}`;
  }

  function lastMessagePreview(room: ChatRoom) {
    if (!room.last_message) return "No messages yet";

    const senderIsMe = room.last_message.sender.id === me;
    const prefix = senderIsMe
      ? "You: "
      : room.room_type === "group"
        ? `${firstName(room.last_message.sender)}: `
        : "";

    return `${prefix}${room.last_message.content}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed right-3 top-16 z-40 flex h-[calc(100vh-5rem)] max-h-[640px] w-[calc(100vw-1.5rem)] max-w-[760px] origin-top-right overflow-hidden  border border-[#C8CDD2] bg-white backdrop-blur-sm animate-scale-in md:right-6"
      style={{ boxShadow: "0 24px 70px rgba(15, 23, 42, 0.22)" }}
      role="dialog"
      aria-label="Chat"
    >
      {/* ── Sidebar: rooms / compose ──────────────────────────────────── */}
      <aside className="flex w-[270px] flex-shrink-0 flex-col border-r border-[#C8CDD2] bg-[#F5F7F8]">
        <div className="flex items-center justify-between border-b border-sidebar-border px-4 py-3 text-white" style={{ background: "var(--gradient-sidebar)" }}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center  bg-white/15 text-white ring-1 ring-white/20">
              <MessageCircle className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-white">Chat</h2>
              <p className="text-[10px] text-white/70">
                {showComposer ? "Start conversation" : "Conversations"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className=" p-1 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-2 border-b border-[#C8CDD2] bg-[#F5F7F8] p-3">
          <button
            onClick={() => {
              setShowComposer((value) => !value);
              setRecipientSearchQuery("");
            }}
            className={clsx(
              "flex w-full items-center justify-center gap-2  px-3 py-2 text-xs font-semibold transition-colors",
              showComposer
                ? "border border-[#C8CDD2] bg-white text-[#1F2933] hover:bg-[#EEF6FB]"
                : "bg-[#287EAD] text-white hover:bg-[#287EAD]/90",
            )}
          >
            {showComposer ? (
              <>
                <ArrowLeft className="h-3.5 w-3.5" /> Back to chats
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" /> Start conversation
              </>
            )}
          </button>
          {!showComposer && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
              <input
                type="text"
                value={chatSearchQuery}
                onChange={(e) => setChatSearchQuery(e.target.value)}
                placeholder="Search chats"
                className="h-9 w-full  border border-[#AEB5BB] bg-white pl-9 pr-3 text-xs outline-none transition focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
              />
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-12 animate-pulse  bg-[#F5F7F8]"
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
                    "group mb-0.5 flex w-full items-center gap-3  px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-[#287EAD]/10 ring-1 ring-[#287EAD]/30"
                      : "hover:bg-[#EEF6FB]",
                  )}
                >
                  <Avatar label={initials(title)} accent={active} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={clsx(
                          "truncate text-xs",
                          active
                            ? "font-semibold text-[#1F2933]"
                            : "font-medium text-[#1F2933]",
                        )}
                      >
                        {title}
                      </p>
                      {room.last_message && (
                        <span className="shrink-0 text-[10px] text-[#5E6870]">
                          {formatTime(room.last_message.created_at)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-[11px] text-[#5E6870]">
                        {lastMessagePreview(room)}
                      </p>
                      {room.unread_count > 0 && (
                        <span className="ml-auto inline-flex h-4 min-w-[16px] animate-pulse items-center justify-center  bg-[#287EAD] px-1 text-[10px] font-bold text-white">
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
      <section className="flex min-w-0 flex-1 flex-col bg-[#EDEDED]">
        {showComposer ? (
          <RecipientSearchPane
            composerLoading={composerLoading}
            filteredGroups={filteredGroups}
            filteredUsers={filteredUsers}
            recipientSearchQuery={recipientSearchQuery}
            setRecipientSearchQuery={setRecipientSearchQuery}
            startDirectMessage={startDirectMessage}
            startGroupChat={startGroupChat}
          />
        ) : selectedRoom ? (
          <>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar label={initials(roomTitle(selectedRoom))} accent />
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-[#1F2933]">
                    {roomTitle(selectedRoom)}
                  </h3>
                  <p className="text-[11px] text-[#5E6870]">
                    {roomSubtitle(selectedRoom)}
                  </p>
                </div>
              </div>
              <button className=" p-1.5 text-[#5E6870] hover:bg-[#EEF6FB] hover:text-[#1F2933]">
                <MoreVertical className="h-4 w-4" />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
              {messages.length === 0 && (
                <div className="flex min-h-[180px] flex-col items-center justify-center border border-dashed border-[#C8CDD2] bg-white/80 p-8 text-center text-sm text-[#5E6870]">
                  <p className="mb-2 text-sm font-semibold text-[#1F2933]">
                    No messages yet
                  </p>
                  <p>Send the first message to start this conversation.</p>
                </div>
              )}

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
                          <Avatar size="sm" label={initials(userLabel(msg.sender))} />
                        )}
                      </div>
                    )}
                    <div
                      className={clsx(
                        "max-w-[70%]  px-3.5 py-2 text-sm",
                        mine
                          ? "bg-[#287EAD] text-white"
                          : "border border-[#C8CDD2] bg-white text-[#1F2933]",
                      )}
                    >
                      {!mine && selectedRoom.room_type === "group" && showAvatar && (
                        <p className="mb-1 text-[10px] font-semibold text-[#5E6870]">
                          {userLabel(msg.sender)}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap break-words leading-relaxed">
                        {msg.content}
                      </p>
                      <p
                        className={clsx(
                          "mt-1 text-[10px]",
                          mine
                            ? "text-white/60"
                            : "text-[#5E6870]",
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
                  <div className="flex items-center gap-1  bg-white border border-[#C8CDD2] px-3 py-1.5">
                    <Dot delay="0ms" />
                    <Dot delay="120ms" />
                    <Dot delay="240ms" />
                  </div>
                  <span className="text-[11px] italic text-[#5E6870]">
                    {Array.from(typingUsers).join(", ")}{" "}
                    {typingUsers.size === 1 ? "is" : "are"} typing
                  </span>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div className="border-t border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
              <div className="flex items-end gap-2  border border-[#AEB5BB] bg-white px-3 py-2 transition-colors focus-within:border-[#287EAD] focus-within:ring-1 focus-within:ring-[#287EAD]">
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
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-[#5E6870]"
                />
                <button
                  onClick={sendMessage}
                  disabled={!newMessage.trim()}
                  className="flex h-8 w-8 items-center justify-center  bg-[#287EAD] text-white transition-all hover:bg-[#287EAD]/90 disabled:cursor-not-allowed disabled:opacity-40"
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
              className="mb-4 flex h-16 w-16 items-center justify-center  bg-[#287EAD] text-white "
            >
              <MessageCircle className="h-7 w-7" />
            </div>
            <h3 className="text-base font-semibold text-[#1F2933]">
              Pick a conversation
            </h3>
            <p className="mt-1 max-w-xs text-xs text-[#5E6870]">
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

function RecipientSearchPane({
  composerLoading,
  filteredGroups,
  filteredUsers,
  recipientSearchQuery,
  setRecipientSearchQuery,
  startDirectMessage,
  startGroupChat,
}: {
  composerLoading: boolean;
  filteredGroups: Group[];
  filteredUsers: User[];
  recipientSearchQuery: string;
  setRecipientSearchQuery: (value: string) => void;
  startDirectMessage: (user: User) => void;
  startGroupChat: (group: Group) => void;
}) {
  const hasQuery = recipientSearchQuery.trim().length > 0;

  return (
    <>
      <div className="border-b border-[#C8CDD2] bg-[#EDEDED]/60 px-5 py-4">
        <h3 className="text-sm font-semibold text-[#1F2933]">Start conversation</h3>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#5E6870]" />
          <input
            type="text"
            value={recipientSearchQuery}
            onChange={(e) => setRecipientSearchQuery(e.target.value)}
            placeholder="Search people or groups"
            className="h-10 w-full  border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm outline-none transition focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
            autoFocus
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {!hasQuery ? (
          <EmptyState
            icon="search"
            label="Search to start a chat"
            hint="Type a name, email, or group"
          />
        ) : composerLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-14 animate-pulse  bg-[#F5F7F8]" />
            ))}
          </div>
        ) : filteredGroups.length === 0 && filteredUsers.length === 0 ? (
          <EmptyState label="No matching recipients" />
        ) : (
          <>
            {filteredGroups.length > 0 && (
              <RecipientSection title="Groups">
                {filteredGroups.map((group) => (
                  <button
                    key={group.id}
                    onClick={() => startGroupChat(group)}
                    className="flex w-full items-center gap-3  px-3 py-2.5 text-left transition-colors hover:bg-[#EEF6FB]"
                  >
                    <Avatar label={initials(group.name)} accent />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[#1F2933]">
                        {group.name}
                      </p>
                      <p className="truncate text-[11px] text-[#5E6870]">
                        Group - {group.member_count || 0} members
                      </p>
                    </div>
                  </button>
                ))}
              </RecipientSection>
            )}

            {filteredUsers.length > 0 && (
              <RecipientSection title="People">
                {filteredUsers.map((user) => (
                  <button
                    key={user.id}
                    onClick={() => startDirectMessage(user)}
                    className="flex w-full items-center gap-3  px-3 py-2.5 text-left transition-colors hover:bg-[#EEF6FB]"
                  >
                    <Avatar label={initials(userLabel(user))} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-[#1F2933]">
                        {userLabel(user)}
                      </p>
                      <p className="truncate text-[11px] text-[#5E6870]">
                        {user.email}
                      </p>
                    </div>
                  </button>
                ))}
              </RecipientSection>
            )}
          </>
        )}
      </div>
    </>
  );
}

function RecipientSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">
          {title}
        </p>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

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
        "flex shrink-0 items-center justify-center  font-semibold",
        size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs",
        accent
          ? "bg-[#287EAD] text-white"
          : "bg-[#287EAD]/10 text-[#287EAD]",
      )}
    >
      {label}
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce  bg-[#5E6870]"
      style={{ animationDelay: delay, animationDuration: "1s" }}
    />
  );
}

function EmptyState({
  label,
  hint,
  icon = "message",
}: {
  label: string;
  hint?: string;
  icon?: "message" | "search";
}) {
  const Icon = icon === "search" ? Search : MessageCircle;

  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <Icon className="mb-2 h-8 w-8 text-[#5E6870]/40" />
      <p className="text-xs font-medium text-[#5E6870]">{label}</p>
      {hint && (
        <p className="mt-0.5 text-[11px] text-[#5E6870]/70">{hint}</p>
      )}
    </div>
  );
}
