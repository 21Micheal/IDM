# apps/documents/apps.py
from django.apps import AppConfig

class DocumentsConfig(AppConfig):
    name = "apps.documents"

    def ready(self):
        import apps.documents.models  # registers signals