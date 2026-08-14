"""Set the per-tenant Anthropic workspace API key (operator use only)."""
from django.core.management.base import BaseCommand

from apps.documents.models import DMSSettings


class Command(BaseCommand):
    help = (
        "Store the Anthropic workspace API key for this deployment/tenant. "
        "Falls back to ANTHROPIC_API_KEY env when unset."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "api_key",
            nargs="?",
            default="",
            help="Workspace API key (sk-ant-...). Omit or pass empty string to clear.",
        )

    def handle(self, *args, **options):
        key = str(options.get("api_key") or "").strip()
        row = DMSSettings.load()
        row.idp_anthropic_api_key = key
        row.save(update_fields=["idp_anthropic_api_key", "updated_at"])
        if key:
            self.stdout.write(self.style.SUCCESS("Per-tenant Anthropic API key saved."))
        else:
            self.stdout.write(self.style.WARNING("Per-tenant Anthropic API key cleared — env fallback will apply."))
