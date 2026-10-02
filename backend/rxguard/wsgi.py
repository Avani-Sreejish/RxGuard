import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "rxguard.settings")
application = get_wsgi_application()

if os.environ.get("WARM_RETRIEVAL", "1") == "1":
    from engine.retrieval import warm_up
    from kbload import ddinter_files

    warm_up()
    ddinter_files.warm()
