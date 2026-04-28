import { chatAPI } from './api';
import type { WebSocketMessage, TypingIndicator } from '@/types/chat';

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

  constructor() {
    this.connectNotifications();
  }

  // Message callbacks
  onMessage(callback: (message: WebSocketMessage) => void) {
    this.messageCallbacks.push(callback);
  }

  offMessage(callback: (message: WebSocketMessage) => void) {
    this.messageCallbacks = this.messageCallbacks.filter(cb => cb !== callback);
  }

  // Typing callbacks
  onTyping(callback: (typing: TypingIndicator) => void) {
    this.typingCallbacks.push(callback);
  }

  offTyping(callback: (typing: TypingIndicator) => void) {
    this.typingCallbacks = this.typingCallbacks.filter(cb => cb !== callback);
  }

  // Notification callbacks
  onNotification(callback: (notification: WebSocketMessage) => void) {
    this.notificationCallbacks.push(callback);
  }

  offNotification(callback: (notification: WebSocketMessage) => void) {
    this.notificationCallbacks = this.notificationCallbacks.filter(cb => cb !== callback);
  }

  // Connect to chat room
  connectToRoom(roomId: string) {
    if (this.chatSocket && this.currentRoomId === roomId) {
      return; // Already connected to this room
    }

    // Disconnect from current room if connected
    this.disconnectChat();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/chat/${roomId}/`;

    this.chatSocket = new WebSocket(wsUrl);
    this.currentRoomId = roomId;

    this.chatSocket.onopen = () => {
      console.log(`Connected to chat room: ${roomId}`);
      this.reconnectAttempts = 0;
    };

    this.chatSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        
        if (data.type === 'new_message' && data.message) {
          this.messageCallbacks.forEach(cb => cb(data));
        } else if (data.type === 'typing') {
          this.typingCallbacks.forEach(cb => cb(data as unknown as TypingIndicator));
        } else if (data.type === 'error') {
          console.error('Chat WebSocket error:', data.error);
        }
      } catch (error) {
        console.error('Error parsing chat message:', error);
      }
    };

    this.chatSocket.onclose = (event) => {
      console.log(`Chat room connection closed: ${roomId}`);
      this.currentRoomId = null;
      
      // Attempt to reconnect if not intentionally closed
      if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        setTimeout(() => {
          this.reconnectAttempts++;
          this.connectToRoom(roomId);
        }, this.reconnectDelay * this.reconnectAttempts);
      }
    };

    this.chatSocket.onerror = (error) => {
      console.error('Chat WebSocket error:', error);
    };
  }

  // Connect to notifications
  connectNotifications() {
    if (this.notificationSocket) {
      return; // Already connected
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/notifications/`;

    this.notificationSocket = new WebSocket(wsUrl);

    this.notificationSocket.onopen = () => {
      console.log('Connected to chat notifications');
    };

    this.notificationSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        
        if (data.type === 'chat_notification' && data.notification) {
          this.notificationCallbacks.forEach(cb => cb(data));
        }
      } catch (error) {
        console.error('Error parsing notification message:', error);
      }
    };

    this.notificationSocket.onclose = (event) => {
      console.log('Notification connection closed');
      this.notificationSocket = null;
      
      // Attempt to reconnect if not intentionally closed
      if (!event.wasClean) {
        setTimeout(() => {
          this.connectNotifications();
        }, this.reconnectDelay);
      }
    };

    this.notificationSocket.onerror = (error) => {
      console.error('Notification WebSocket error:', error);
    };
  }

  // Send message to chat room
  sendMessage(data: {
    content: string;
    message_type?: string;
    reply_to?: string;
  }) {
    if (this.chatSocket && this.chatSocket.readyState === WebSocket.OPEN) {
      this.chatSocket.send(JSON.stringify(data));
    } else {
      console.error('Chat socket not connected');
    }
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
      this.chatSocket.close();
      this.chatSocket = null;
      this.currentRoomId = null;
    }
  }

  // Disconnect from notifications
  disconnectNotifications() {
    if (this.notificationSocket) {
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
