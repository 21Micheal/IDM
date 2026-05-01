from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    ChatRoomViewSet, ChatMessageViewSet, UserViewSet,
    UnreadMessageViewSet, ChatNotificationViewSet
)

router = DefaultRouter()
router.register(r'rooms', ChatRoomViewSet, basename='chat-rooms')
router.register(r'messages', ChatMessageViewSet, basename='chat-messages')
router.register(r'users', UserViewSet, basename='chat-users')
router.register(r'unread', UnreadMessageViewSet, basename='unread-messages')
router.register(r'notifications', ChatNotificationViewSet, basename='chat-notifications')

app_name = 'chat'

urlpatterns = [
    path('', include(router.urls)),
]
