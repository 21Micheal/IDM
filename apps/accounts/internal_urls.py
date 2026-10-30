from django.urls import path

from .internal_idp import (
    InternalIdpUserAuthorizationView,
    InternalIdpUserLookupView,
    InternalIdpUserSearchView,
    InternalIdpBackchannelLogoutView,
)

urlpatterns = [
    path("users/lookup/", InternalIdpUserLookupView.as_view(), name="internal-idp-user-lookup"),
    path("users/search/", InternalIdpUserSearchView.as_view(), name="internal-idp-user-search"),
    path("users/authorization/", InternalIdpUserAuthorizationView.as_view(), name="internal-idp-user-authorization-email"),
    path("users/<uuid:user_id>/authorization/", InternalIdpUserAuthorizationView.as_view(), name="internal-idp-user-authorization"),
    path("oidc/backchannel-logout/", InternalIdpBackchannelLogoutView.as_view(), name="internal-idp-backchannel-logout"),
]
