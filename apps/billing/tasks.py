from celery import shared_task

from apps.billing.sync import sync_usage_for_day


@shared_task(name="apps.billing.tasks.sync_anthropic_usage")
def sync_anthropic_usage():
    """Daily Beat job: sync yesterday's Anthropic Admin usage/cost."""
    return sync_usage_for_day()
