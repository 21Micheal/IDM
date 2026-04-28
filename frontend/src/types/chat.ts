export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  name: string;
}

export interface ChatRoom {
  id: string;
  name: string;
  room_type: 'direct' | 'group';
  participants: User[];
  created_by: User | null;
  created_at: string;
  updated_at: string;
  is_active: boolean;
  last_message: {
    id: string;
    content: string;
    sender: User;
    created_at: string;
    message_type: string;
  } | null;
  unread_count: number;
}

export interface ChatMessage {
  id: string;
  room: string;
  sender: User;
  content: string;
  message_type: 'text' | 'file' | 'system';
  file_attachment?: string;
  reply_to: {
    id: string;
    content: string;
    sender: User;
  } | null;
  is_edited: boolean;
  edited_at?: string;
  created_at: string;
  is_read: boolean;
}

export interface UnreadMessage {
  id: string;
  user: string;
  message: ChatMessage;
  room: string;
  created_at: string;
}

export interface ChatNotification {
  id: string;
  recipient: string;
  message: ChatMessage;
  is_read: boolean;
  created_at: string;
}

export interface WebSocketMessage {
  type: 'new_message' | 'typing' | 'chat_notification' | 'error';
  message?: ChatMessage;
  user?: {
    id: string;
    name: string;
  };
  is_typing?: boolean;
  notification?: {
    id: string;
    message: string;
    sender: User;
    room_id: string;
    room_name: string;
    created_at: string;
  };
  error?: string;
}

export interface TypingIndicator {
  user_id: string;
  username: string;
  is_typing: boolean;
}
