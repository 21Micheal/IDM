from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    LoginView, VerifyOTPView, ResendOTPView,
    MeView, ChangePasswordView, EnableMFAView, UserPreferencesView, UserSignatureView, UserSignatureImageView,
    PasswordResetRequestView, PasswordResetConfirmView,
    OIDCExchangeView,
    UserViewSet, DepartmentViewSet, UserGroupViewSet, UserDelegationViewSet,
)
from .internal_idp import (
    InternalIdpUserAuthorizationView,
    InternalIdpUserCreateView,
    InternalIdpUserLookupView,
    InternalIdpUserPasswordView,
    InternalIdpUserProfileView,
    InternalIdpUserSearchView,
    InternalIdpValidatePasswordView,
)

router = DefaultRouter()
router.register(r"users",       UserViewSet,          basename="user")
router.register(r"departments", DepartmentViewSet,    basename="department")
router.register(r"groups",      UserGroupViewSet,     basename="group")
router.register(r"delegations", UserDelegationViewSet, basename="delegation")

urlpatterns = [
    # Auth
    path("auth/login/",           LoginView.as_view(),         name="login"),
    path("auth/verify-otp/",      VerifyOTPView.as_view(),     name="verify-otp"),
    path("auth/resend-otp/",      ResendOTPView.as_view(),     name="resend-otp"),
    path("auth/me/",              MeView.as_view(),            name="me"),
    path("auth/change-password/", ChangePasswordView.as_view(), name="change-password"),
    path("auth/mfa/",             EnableMFAView.as_view(),     name="toggle-mfa"),
    path("auth/preferences/",     UserPreferencesView.as_view(), name="preferences"),
    path("auth/signature/",       UserSignatureView.as_view(), name="signature"),
    path("auth/signature/image/<uuid:signature_id>/", UserSignatureImageView.as_view(), name="signature-image"),
    # Password reset
    path("auth/password-reset/request/",  PasswordResetRequestView.as_view(),  name="password-reset-request"),
    path("auth/password-reset/confirm/", PasswordResetConfirmView.as_view(), name="password-reset-confirm"),
    # OIDC token exchange — receives Keycloak id_token, returns simplejwt pair
    path("auth/oidc/exchange/", OIDCExchangeView.as_view(), name="oidc-exchange"),
    # Internal Keycloak federation API. Protected by DMS_INTERNAL_IDP_API_KEY and
    # intended only for service-to-service traffic from the IdP network.
    path("internal/idp/users/", InternalIdpUserCreateView.as_view(), name="internal-idp-user-create"),
    path("internal/idp/users", InternalIdpUserCreateView.as_view(), name="internal-idp-user-create-noslash"),
    path("internal/idp/users/lookup/", InternalIdpUserLookupView.as_view(), name="internal-idp-user-lookup"),
    path("internal/idp/users/lookup", InternalIdpUserLookupView.as_view(), name="internal-idp-user-lookup-noslash"),
    path("internal/idp/users/search/", InternalIdpUserSearchView.as_view(), name="internal-idp-user-search"),
    path("internal/idp/users/search", InternalIdpUserSearchView.as_view(), name="internal-idp-user-search-noslash"),
    path("internal/idp/users/validate-password/", InternalIdpValidatePasswordView.as_view(), name="internal-idp-validate-password"),
    path("internal/idp/users/validate-password", InternalIdpValidatePasswordView.as_view(), name="internal-idp-validate-password-noslash"),
    path("internal/idp/users/<uuid:user_id>/", InternalIdpUserProfileView.as_view(), name="internal-idp-user-profile"),
    path("internal/idp/users/<uuid:user_id>", InternalIdpUserProfileView.as_view(), name="internal-idp-user-profile-noslash"),
    path("internal/idp/users/<uuid:user_id>/password/", InternalIdpUserPasswordView.as_view(), name="internal-idp-user-password"),
    path("internal/idp/users/<uuid:user_id>/password", InternalIdpUserPasswordView.as_view(), name="internal-idp-user-password-noslash"),
    path("internal/idp/users/<uuid:user_id>/authorization/", InternalIdpUserAuthorizationView.as_view(), name="internal-idp-user-authorization"),
    path("internal/idp/users/<uuid:user_id>/authorization", InternalIdpUserAuthorizationView.as_view(), name="internal-idp-user-authorization-noslash"),
    # User, department & group management
    path("", include(router.urls)),
]
