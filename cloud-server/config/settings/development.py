from .base import *  # noqa: F403

DEBUG = os.getenv('DEBUG', 'True') == 'True'  # noqa: F405

CORS_ALLOW_ALL_ORIGINS = True

if DEBUG:
    ALLOWED_HOSTS = ['*']

if os.getenv('USE_SQLITE', 'False') == 'True':  # noqa: F405
    DATABASES = {  # noqa: F405
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',  # noqa: F405
        }
    }
