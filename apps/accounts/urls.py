from django.urls import path
from .views import LoginView, VerifyOTPView, MeView, MFASetupView, MFAConfirmView

urlpatterns = [
    path("login/", LoginView.as_view(), name="login"),
    path("verify-otp/", VerifyOTPView.as_view(), name="verify-otp"),
    path("me/", MeView.as_view(), name="me"),
    path("mfa/setup/", MFASetupView.as_view(), name="mfa-setup"),
    path("mfa/confirm/", MFAConfirmView.as_view(), name="mfa-confirm"),
]
