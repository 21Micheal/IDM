from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import (
    LoginView, VerifyOTPView, ResendOTPView,
    MeView, ChangePasswordView, EnableMFAView, UserPreferencesView, UserSignatureView, UserSignatureImageView,
    UserViewSet, DepartmentViewSet, UserGroupViewSet, UserDelegationViewSet,
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
    # User, department & group management
    path("", include(router.urls)),
]
