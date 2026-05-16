from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils import timezone
from django.db.models import Count

from apps.chat.models import ChatRoom


class Command(BaseCommand):
    help = "Remove stale empty chat rooms created before a message was sent."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Show which empty rooms would be removed without deleting them.",
        )
        parser.add_argument(
            "--older-than-days",
            type=int,
            default=0,
            help="Only remove empty rooms older than this many days.",
        )
        parser.add_argument(
            "--room-type",
            choices=["direct", "group", "all"],
            default="all",
            help="Choose which room types to clean up.",
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        older_than_days = options["older_than_days"]
        room_type = options["room_type"]

        rooms = ChatRoom.objects.annotate(message_count=Count("messages")).filter(message_count=0)

        if room_type != "all":
            rooms = rooms.filter(room_type=room_type)

        if older_than_days > 0:
            cutoff = timezone.now() - timedelta(days=older_than_days)
            rooms = rooms.filter(created_at__lt=cutoff)

        count = rooms.count()
        if count == 0:
            self.stdout.write(self.style.SUCCESS("No empty chat rooms found for cleanup."))
            return

        self.stdout.write(self.style.WARNING(f"Found {count} empty chat room(s) to clean up."))

        if dry_run:
            for room in rooms.order_by("created_at"):
                self.stdout.write(
                    f"{room.id} | type={room.room_type} | name={room.name or '<unnamed>'} | created={room.created_at.isoformat()}"
                )
            return

        with transaction.atomic():
            rooms.delete()

        self.stdout.write(self.style.SUCCESS(f"Deleted {count} empty chat room(s)."))
