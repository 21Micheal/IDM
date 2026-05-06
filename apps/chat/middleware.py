from urllib.parse import parse_qs

from channels.auth import AuthMiddlewareStack
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser
from django.db import close_old_connections
from rest_framework_simplejwt.authentication import JWTAuthentication


@database_sync_to_async
def get_user_for_token(raw_token):
    close_old_connections()
    if not raw_token:
        return AnonymousUser()

    jwt_auth = JWTAuthentication()
    try:
        validated_token = jwt_auth.get_validated_token(raw_token)
        return jwt_auth.get_user(validated_token)
    except Exception:
        return AnonymousUser()


class JwtAuthMiddleware:
    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        # Parse query string to get token
        query_params = parse_qs(scope.get("query_string", b"").decode())
        token = (query_params.get("token") or [None])[0]

        if token and (
            not scope.get("user") or not scope["user"].is_authenticated
        ):
            scope["user"] = await get_user_for_token(token)

        return await self.inner(scope, receive, send)


def JwtAuthMiddlewareStack(inner):
    return JwtAuthMiddleware(AuthMiddlewareStack(inner))
