from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('templates_engine', '0004_rename_tmpl_type_active_idx_templates_e_type_0db665_idx_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='documenttemplate',
            name='kind',
            field=models.CharField(
                choices=[
                    ('form', 'Interactive form (data entry)'),
                    ('document', 'WYSIWYG document layout'),
                ],
                db_index=True,
                default='form',
                max_length=20,
            ),
        ),
        migrations.AddField(
            model_name='documenttemplate',
            name='design',
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
