"""Django settings for RxGuard.

Every secret and deployment-specific value comes from the environment (see .env.example).
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent


def env(name, default=None):
    return os.environ.get(name, default)


def env_bool(name, default=False):
    return str(env(name, str(default))).lower() in ("1", "true", "yes", "on")


DEBUG = env_bool("DJANGO_DEBUG", False)
SECRET_KEY = env("DJANGO_SECRET_KEY") or ("dev-only-insecure-key" if DEBUG else None)
if not SECRET_KEY:
    raise RuntimeError("DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is false")

ALLOWED_HOSTS = [h.strip() for h in env("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()]
CSRF_TRUSTED_ORIGINS = [o.strip() for o in env("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if o.strip()]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",
    "api",
]

MIDDLEWARE = [
    "api.middleware.CorrelationIdMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "rxguard.urls"
WSGI_APPLICATION = "rxguard.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    }
]

# MySQL is the system of record. SQLite is allowed only for local unit tests / quick dev
# (DB_ENGINE=sqlite); the MySQL FULLTEXT retrieval fallback degrades to LIKE there.
if env("DB_ENGINE", "mysql") == "sqlite":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": env("SQLITE_PATH", str(BASE_DIR / "db.sqlite3")),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.mysql",
            "NAME": env("MYSQL_DATABASE", "rxguard"),
            "USER": env("MYSQL_USER", "rxguard"),
            "PASSWORD": env("MYSQL_PASSWORD", ""),
            "HOST": env("MYSQL_HOST", "127.0.0.1"),
            "PORT": env("MYSQL_PORT", "3306"),
            "OPTIONS": {"charset": "utf8mb4", "connect_timeout": 2},
            "CONN_MAX_AGE": 60,
        }
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": ["api.permissions.IsPharmacist"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": [
        "rest_framework.parsers.JSONParser",
        "rest_framework.parsers.MultiPartParser",
    ],
    "EXCEPTION_HANDLER": "api.errors.exception_handler",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "check": env("THROTTLE_CHECK", "60/min"),
        "explain": env("THROTTLE_EXPLAIN", "20/min"),
        "ask": env("THROTTLE_ASK", "20/min"),
    },
    "UNAUTHENTICATED_USER": None,
}

CORS_ALLOWED_ORIGINS = [o.strip() for o in env("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]

if not DEBUG:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "same-origin"
    X_FRAME_OPTIONS = "DENY"
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024

# ---- RxGuard-specific configuration -------------------------------------------------
RXGUARD = {
    "MAX_INPUT_CHARS": 20_000,
    "MAX_MED_LINES": 25,
    "FUZZY_AUTO": float(env("FUZZY_AUTO", "92")),
    "FUZZY_CANDIDATE": float(env("FUZZY_CANDIDATE", "80")),
    "SUPPORT_THRESHOLD": float(env("SUPPORT_THRESHOLD", "0.6")),
    "RETRIEVAL_MIN_SCORE": float(env("RETRIEVAL_MIN_SCORE", "0.81")),  # calibrated: scripts/calibrate_retrieval.py
    "CHUNKS_PER_FINDING": 3,
    "EXPLAIN_MAX_FINDINGS": int(env("EXPLAIN_MAX_FINDINGS", "10")),
    "RETRIEVAL_BUDGET_S": float(env("RETRIEVAL_BUDGET_S", "6")),  # per /explain request, all findings
    # spec 8.3: Tool 1 / Tool 3 2 s, Tool 2 retrieval 1 s (the embedding model is warmed at process start)
    "TOOL_TIMEOUTS_S": {"interaction_lookup": float(env("TOOL1_TIMEOUT_S", "2")),
                        "guideline_search": float(env("TOOL2_TIMEOUT_S", "1")),
                        "escalate": float(env("TOOL3_TIMEOUT_S", "2"))},
    # LLM gateway. Model IDs and prices are configuration, never hardcoded in logic.
    "LLM_PRIMARY_MODEL": env("LLM_PRIMARY_MODEL", "claude-opus-5-5"),
    "LLM_FALLBACK_MODEL": env("LLM_FALLBACK_MODEL", "claude-haiku-4-5"),
    "LLM_TIMEOUT_S": float(env("LLM_TIMEOUT_S", "10")),
    "LLM_MAX_CALLS_PER_QUERY": int(env("LLM_MAX_CALLS_PER_QUERY", "3")),
    "LLM_MAX_INPUT_TOKENS_PER_QUERY": int(env("LLM_MAX_INPUT_TOKENS_PER_QUERY", "6000")),
    # Thinking tokens count toward max_tokens on the primary model, so this is above the spec's 800 example.
    "LLM_MAX_OUTPUT_TOKENS_PER_CALL": int(env("LLM_MAX_OUTPUT_TOKENS_PER_CALL", "1500")),
    # USD per 1M tokens, "model=input:output;model=input:output". Copy from the provider's pricing page.
    "LLM_PRICES": env("LLM_PRICES", "claude-opus-5-5=4.00:20.00;claude-haiku-4-5=1.00:5.00"),
    "INDEX_DIR": Path(env("INDEX_DIR", str(REPO_ROOT / "data" / "index"))),
    "EMBEDDING_MODEL": env("EMBEDDING_MODEL", "intfloat/multilingual-e5-base"),
    # Failure-injection toggles for the Judge Attack panel: admin-only, off unless enabled here.
    "DEMO_TOGGLES_ENABLED": env_bool("DEMO_TOGGLES_ENABLED", False),
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"correlation": {"()": "api.logging_utils.CorrelationFilter"}},
    "formatters": {
        "json": {
            "()": "pythonjsonlogger.json.JsonFormatter",
            "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s",
            "rename_fields": {"asctime": "timestamp", "levelname": "level"},
            "static_fields": {"service": "rxguard-web"},
        }
    },
    "handlers": {"stdout": {"class": "logging.StreamHandler", "formatter": "json", "filters": ["correlation"]}},
    "root": {"handlers": ["stdout"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {"django.request": {"level": "ERROR"}},
}
