"""
apps/accounts/migrations/0002_email_otp_groups.py

Run after the initial migration:
  docker compose exec backend python manage.py migrate
"""
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
        ("documents", "0001_initial"),
    ]

    operations = [
        # ── Add must_change_password to User ────────────────────────────────
        migrations.AddField(
            model_name="user",
            name="must_change_password",
            field=models.BooleanField(default=False),
        ),

        # ── EmailOTP ─────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="EmailOTP",
            fields=[
                ("id",         models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("code",       models.CharField(max_length=6)),
                ("purpose",    models.CharField(
                    choices=[("login", "Login"), ("mfa_setup", "MFA Setup")],
                    default="login", max_length=20,
                )),
                ("is_used",    models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("expires_at", models.DateTimeField()),
                ("user",       models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="email_otps",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["-created_at"]},
        ),

        # ── UserGroup ─────────────────────────────────────────────────────────
        migrations.CreateModel(
            name="UserGroup",
            fields=[
                ("id",          models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name",        models.CharField(max_length=120, unique=True)),
                ("description", models.TextField(blank=True)),
                ("is_active",   models.BooleanField(default=True)),
                ("created_at",  models.DateTimeField(auto_now_add=True)),
                ("updated_at",  models.DateTimeField(auto_now=True)),
                ("created_by",  models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="created_groups",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["name"]},
        ),

        # ── GroupPermission ───────────────────────────────────────────────────
        migrations.CreateModel(
            name="GroupPermission",
            fields=[
                ("id",     models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("action", models.CharField(
                    choices=[
                        ("view",     "View documents"),
                        ("upload",   "Upload documents"),
                        ("edit",     "Edit metadata"),
                        ("delete",   "Delete / void documents"),
                        ("approve",  "Approve in workflow"),
                        ("download", "Download files"),
                        ("comment",  "Add comments"),
                        ("archive",  "Archive documents"),
                    ],
                    max_length=20,
                )),
                ("document_type", models.ForeignKey(
                    blank=True, null=True,
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="group_permissions",
                    to="documents.documenttype",
                )),
                ("group", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="permissions",
                    to="accounts.usergroup",
                )),
            ],
            options={"ordering": ["group", "document_type", "action"]},
        ),
        migrations.AddConstraint(
            model_name="grouppermission",
            constraint=models.UniqueConstraint(
                fields=["group", "document_type", "action"],
                name="unique_group_doctype_action",
            ),
        ),

        # ── UserGroupMembership ───────────────────────────────────────────────
        migrations.CreateModel(
            name="UserGroupMembership",
            fields=[
                ("id",         models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("expires_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("added_by",   models.ForeignKey(
                    null=True,
                    on_delete=django.db.models.deletion.SET_NULL,
                    related_name="added_memberships",
                    to=settings.AUTH_USER_MODEL,
                )),
                ("group", models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="memberships",
                    to="accounts.usergroup",
                )),
                ("user",  models.ForeignKey(
                    on_delete=django.db.models.deletion.CASCADE,
                    related_name="group_memberships",
                    to=settings.AUTH_USER_MODEL,
                )),
            ],
            options={"ordering": ["group__name"]},
        ),
        migrations.AddConstraint(
            model_name="usergroupmembership",
            constraint=models.UniqueConstraint(
                fields=["user", "group"],
                name="unique_user_group",
            ),
        ),
    ]
