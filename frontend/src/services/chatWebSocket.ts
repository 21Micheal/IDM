import type { WebSocketMessage, TypingIndicator } from '@/types/chat';
import { useAuthStore } from '@/store/authStore';
import { apiBaseUrl } from './api';

export class ChatWebSocketService {
  private chatSocket: WebSocket | null = null;
  private notificationSocket: WebSocket | null = null;
  private messageCallbacks: ((message: WebSocketMessage) => void)[] = [];
  private typingCallbacks: ((typing: TypingIndicator) => void)[] = [];
  private notificationCallbacks: ((notification: WebSocketMessage) => void)[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private currentRoomId: string | null = null;
  private notificationReconnectAttempts = 0;
  private maxNotificationReconnectAttempts = 3;
  private intentionalChatClose = false;
  private intentionalNotificationClose = false;

  constructor() {}

  private getWebSocketBaseUrl(): string {
    if (apiBaseUrl.startsWith('/')) {
      // Relative URL, use current location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}`;
    } else {
      // Absolute URL, convert to WebSocket
      const url = new URL(apiBaseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '';
      return url.href;
    }
  }

  private buildWebSocketUrl(path: string): string {
    const baseUrl = this.getWebSocketBaseUrl();
    const token = useAuthStore.getState().accessToken;
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    // Ensure no double slashes by removing trailing slash from baseUrl and leading slash from path
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${cleanBaseUrl}${cleanPath}${query}`;
  }

  // Message callbacks
  onMessage(callback: (message: WebSocketMessage) => void) {
    if (!this.messageCallbacks.includes(callback)) {
      this.messageCallbacks.push(callback);
    }
  }

  offMessage(callback: (message: WebSocketMessage) => void) {
    this.messageCallbacks = this.messageCallbacks.filter(cb => cb !== callback);
  }

  // Typing callbacks
  onTyping(callback: (typing: TypingIndicator) => void) {
    if (!this.typingCallbacks.includes(callback)) {
      this.typingCallbacks.push(callback);
    }
  }

  offTyping(callback: (typing: TypingIndicator) => void) {
    this.typingCallbacks = this.typingCallbacks.filter(cb => cb !== callback);
  }

  // Notification callbacks
  onNotification(callback: (notification: WebSocketMessage) => void) {
    if (!this.notificationCallbacks.includes(callback)) {
      this.notificationCallbacks.push(callback);
    }
    this.connectNotifications();
  }

  offNotification(callback: (notification: WebSocketMessage) => void) {
    this.notificationCallbacks = this.notificationCallbacks.filter(cb => cb !== callback);
    if (this.notificationCallbacks.length === 0) {
      this.disconnectNotifications();
    }
  }

  // Connect to chat room
  connectToRoom(roomId: string) {
    if (this.chatSocket && this.currentRoomId === roomId) {
      return; // Already connected to this room
    }

    // Disconnect from current room if connected
    this.disconnectChat();
    this.intentionalChatClose = false;

    const wsUrl = this.buildWebSocketUrl(`/ws/chat/${roomId}/`);

    const socket = new WebSocket(wsUrl);
    this.chatSocket = socket;
    this.currentRoomId = roomId;

    socket.onopen = () => {
      if (import.meta.env.DEV) {
        console.warn(`Connected to chat room: ${roomId}`);
      }
      this.reconnectAttempts = 0;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        
        if (data.type === 'new_message' && data.message) {
          this.messageCallbacks.forEach(cb => cb(data));
        } else if (data.type === 'typing') {
          const typing: TypingIndicator = {
            user_id: data.user?.id ?? '',
            username: data.user?.name ?? '',
            is_typing: Boolean(data.is_typing),
          };
          this.typingCallbacks.forEach(cb => cb(typing));
        } else if (data.type === 'error') {
          console.error('Chat WebSocket error:', data.error ?? data.detail);
        }
      } catch (error) {
        console.error('Error parsing chat message:', error);
      }
    };

    socket.onclose = (event) => {
      if (this.chatSocket !== socket) return;
      if (import.meta.env.DEV) {
        console.warn(`Chat room connection closed: ${roomId}`);
      }
      this.currentRoomId = null;
      
      // Attempt to reconnect if not intentionally closed
      if (!this.intentionalChatClose && !event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        const nextAttempt = this.reconnectAttempts + 1;
        this.reconnectAttempts = nextAttempt;
        setTimeout(() => {
          this.connectToRoom(roomId);
        }, this.reconnectDelay * nextAttempt);
      }
    };

    socket.onerror = (error) => {
      console.error('Chat WebSocket error:', error);
    };
  }

  // Connect to notifications
  connectNotifications() {
    if (this.notificationSocket || this.notificationCallbacks.length === 0) {
      return; // Already connected
    }

    const wsUrl = this.buildWebSocketUrl('/ws/notifications/');

    this.intentionalNotificationClose = false;
    const socket = new WebSocket(wsUrl);
    this.notificationSocket = socket;

    socket.onopen = () => {
      if (import.meta.env.DEV) {
        console.warn('Connected to chat notifications');
      }
      this.notificationReconnectAttempts = 0;
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        
        if (data.type === 'chat_notification' && data.notification) {
          this.notificationCallbacks.forEach(cb => cb(data));
        }
      } catch (error) {
        console.error('Error parsing notification message:', error);
      }
    };

    socket.onclose = (event) => {
      if (this.notificationSocket !== socket) return;
      if (import.meta.env.DEV) {
        console.warn('Notification connection closed');
      }
      this.notificationSocket = null;
      
      // Attempt to reconnect only when consumers exist and within cap.
      if (
        !event.wasClean &&
        !this.intentionalNotificationClose &&
        this.notificationCallbacks.length > 0 &&
        this.notificationReconnectAttempts < this.maxNotificationReconnectAttempts
      ) {
        const nextAttempt = this.notificationReconnectAttempts + 1;
        this.notificationReconnectAttempts = nextAttempt;
        setTimeout(() => {
          this.connectNotifications();
        }, this.reconnectDelay * nextAttempt);
      }
    };

    socket.onerror = (error) => {
      console.error('Notification WebSocket error:', error);
    };
  }

  // Send message to chat room
  sendMessage(data: {
    content: string;
    message_type?: string;
    reply_to?: string;
    client_id?: string;
  }): boolean {
    if (this.chatSocket && this.chatSocket.readyState === WebSocket.OPEN) {
      this.chatSocket.send(JSON.stringify(data));
      return true;
    }
    console.error('Chat socket not connected');
    return false;
  }

  // Send typing indicator
  sendTyping(isTyping: boolean) {
    if (this.chatSocket && this.chatSocket.readyState === WebSocket.OPEN) {
      this.chatSocket.send(JSON.stringify({
        type: 'typing',
        is_typing: isTyping
      }));
    }
  }

  // Mark messages as read
  markMessagesRead(messageIds: string[]) {
    if (this.chatSocket && this.chatSocket.readyState === WebSocket.OPEN) {
      this.chatSocket.send(JSON.stringify({
        type: 'mark_read',
        message_ids: messageIds
      }));
    }
  }

  // Disconnect from chat room
  disconnectChat() {
    if (this.chatSocket) {
      this.intentionalChatClose = true;
      this.chatSocket.close();
      this.chatSocket = null;
      this.currentRoomId = null;
    }
  }

  // Disconnect from notifications
  disconnectNotifications() {
    if (this.notificationSocket) {
      this.intentionalNotificationClose = true;
      this.notificationSocket.close();
      this.notificationSocket = null;
    }
  }

  // Disconnect all
  disconnect() {
    this.disconnectChat();
    this.disconnectNotifications();
  }

  // Check if connected to a room
  isConnectedToRoom(): boolean {
    return this.chatSocket !== null && this.chatSocket.readyState === WebSocket.OPEN;
  }

  // Get current room ID
  getCurrentRoomId(): string | null {
    return this.currentRoomId;
  }
}

// Create singleton instance
export const chatWebSocket = new ChatWebSocketService();
