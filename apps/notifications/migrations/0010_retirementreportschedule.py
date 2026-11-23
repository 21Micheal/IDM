import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('notifications', '0009_alter_notification_type'),
    ]

    operations = [
        migrations.CreateModel(
            name='RetirementReportSchedule',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('frequency', models.CharField(choices=[('daily', 'Daily'), ('weekly', 'Weekly'), ('monthly', 'Monthly')], default='weekly', max_length=12)),
                ('audience', models.CharField(choices=[('hods_finance', 'Department Heads and Finance Approvers'), ('all_mgmt', 'Executive Leadership and Audit Committee')], default='hods_finance', max_length=20)),
                ('enabled', models.BooleanField(default=False)),
                ('last_sent_on', models.DateField(blank=True, null=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('key', models.CharField(default='outstanding_retirements', max_length=40, unique=True)),
                ('updated_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='updated_retirement_report_schedules', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'indexes': [models.Index(fields=['enabled', 'frequency'], name='notif_ret_rpt_en_freq_idx')],
            },
        ),
    ]
