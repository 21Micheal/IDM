from rest_framework import generics, status, permissions
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework_simplejwt.tokens import RefreshToken
from django_otp.plugins.otp_totp.models import TOTPDevice
from django.contrib.auth import authenticate
import qrcode, io, base64
from .models import User
from .serializers import UserSerializer

class LoginView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        email = request.data.get("email", "")
        password = request.data.get("password", "")
        user = authenticate(request, username=email, password=password)
        if not user:
            return Response({"detail": "Invalid credentials."}, status=401)
        if user.mfa_enabled:
            return Response({"mfa_required": True, "user_id": str(user.id)}, status=200)
        refresh = RefreshToken.for_user(user)
        return Response({"access": str(refresh.access_token), "refresh": str(refresh)})

class VerifyOTPView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        user_id = request.data.get("user_id")
        otp = request.data.get("otp")
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return Response({"detail": "Invalid."}, status=400)
        device = TOTPDevice.objects.filter(user=user, confirmed=True).first()
        if not device or not device.verify_token(otp):
            return Response({"detail": "Invalid OTP."}, status=400)
        refresh = RefreshToken.for_user(user)
        return Response({"access": str(refresh.access_token), "refresh": str(refresh)})

class MeView(generics.RetrieveUpdateAPIView):
    serializer_class = UserSerializer
    def get_object(self):
        return self.request.user

class MFASetupView(APIView):
    def post(self, request):
        user = request.user
        device, _ = TOTPDevice.objects.get_or_create(user=user, name="default")
        config_url = device.config_url
        qr = qrcode.make(config_url)
        buf = io.BytesIO()
        qr.save(buf, format="PNG")
        qr_b64 = base64.b64encode(buf.getvalue()).decode()
        return Response({"qr_code": f"data:image/png;base64,{qr_b64}", "config_url": config_url})

class MFAConfirmView(APIView):
    def post(self, request):
        token = request.data.get("token")
        device = TOTPDevice.objects.filter(user=request.user, name="default").first()
        if not device or not device.verify_token(token):
            return Response({"detail": "Invalid token."}, status=400)
        device.confirmed = True
        device.save()
        request.user.mfa_enabled = True
        request.user.save(update_fields=["mfa_enabled"])
        return Response({"detail": "MFA enabled."})
