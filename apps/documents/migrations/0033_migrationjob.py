import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('documents', '0032_signaturerequestsigner_documents_s_signer__51dcd6_idx'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='MigrationJob',
            fields=[
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=200)),
                ('connection', models.JSONField(blank=True, default=dict, help_text='ION API connection settings: api_url, tenant, token_url, client_id, client_secret, saak, sask, scope, etc.')),
                ('source_query', models.TextField(blank=True, help_text='IDM query selecting which documents to migrate. Empty = connector default.')),
                ('include_attributes', models.BooleanField(default=True, help_text="Copy IDM attributes/metadata into each imported document's metadata.")),
                ('max_documents', models.PositiveIntegerField(default=0, help_text='Optional ceiling on documents imported in one run. 0 = no limit.')),
                ('status', models.CharField(choices=[('draft', 'Draft'), ('queued', 'Queued'), ('running', 'Running'), ('completed', 'Completed'), ('partial', 'Completed with errors'), ('failed', 'Failed'), ('cancelled', 'Cancelled')], db_index=True, default='draft', max_length=20)),
                ('total_items', models.PositiveIntegerField(default=0)),
                ('processed_items', models.PositiveIntegerField(default=0)),
                ('succeeded_items', models.PositiveIntegerField(default=0)),
                ('failed_items', models.PositiveIntegerField(default=0)),
                ('skipped_items', models.PositiveIntegerField(default=0)),
                ('log', models.JSONField(blank=True, default=list)),
                ('error', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('started_at', models.DateTimeField(blank=True, null=True)),
                ('finished_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='migration_jobs', to=settings.AUTH_USER_MODEL)),
                ('target_document_type', models.ForeignKey(blank=True, help_text='fseDMS document type imported documents are filed under.', null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='migration_jobs', to='documents.documenttype')),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddIndex(
            model_name='migrationjob',
            index=models.Index(fields=['status', 'created_at'], name='documents_m_status_a6c81b_idx'),
        ),
    ]
