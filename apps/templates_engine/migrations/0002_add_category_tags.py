# Generated migration: add category and tags fields to DocumentTemplate
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        # Replace with your actual last migration:
        ('templates_engine', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='documenttemplate',
            name='category',
            field=models.CharField(
                choices=[
                    ('finance', 'Finance & Accounting'),
                    ('hr', 'Human Resources'),
                    ('procurement', 'Procurement'),
                    ('legal', 'Legal & Compliance'),
                    ('operations', 'Operations'),
                    ('admin', 'Administration'),
                    ('other', 'Other'),
                ],
                default='other',
                max_length=30,
                db_index=True,
            ),
        ),
        migrations.AddField(
            model_name='documenttemplate',
            name='tags',
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddIndex(
            model_name='documenttemplate',
            index=models.Index(fields=['type', 'is_active'], name='tmpl_type_active_idx'),
        ),
        migrations.AddIndex(
            model_name='documenttemplate',
            index=models.Index(fields=['category', 'is_active'], name='tmpl_cat_active_idx'),
        ),
    ]