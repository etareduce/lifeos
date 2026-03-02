import os


DEFAULT_DATABASE_URL = "sqlite+aiosqlite:///./core.db"
DEFAULT_ANALYTICS_DATABASE_URL = "sqlite+aiosqlite:///./analytics.db"
DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview"
DEFAULT_MAX_BLOB_CREATION_RETRIES = 2
DEFAULT_PREFERENCE_BATCH_SIZE = 20
DEFAULT_GOOGLE_OAUTH_SCOPES = (
    "openid email profile https://www.googleapis.com/auth/calendar.readonly"
)


def get_database_url() -> str:
    return os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)


def get_analytics_database_url() -> str:
    return os.getenv("ANALYTICS_DATABASE_URL", DEFAULT_ANALYTICS_DATABASE_URL)


def get_gemini_api_key() -> str:
    return os.getenv("GEMINI_API_KEY", "")


def get_gemini_model() -> str:
    return os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL)


def get_max_blob_creation_retries() -> int:
    raw = os.getenv("MAX_BLOB_CREATION_RETRIES", str(DEFAULT_MAX_BLOB_CREATION_RETRIES))
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_BLOB_CREATION_RETRIES
    return max(0, value)


def get_preference_batch_size() -> int:
    raw = os.getenv("PREFERENCE_BATCH_SIZE", str(DEFAULT_PREFERENCE_BATCH_SIZE))
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_PREFERENCE_BATCH_SIZE
    return max(1, value)


def get_google_oauth_client_id() -> str:
    return os.getenv("GOOGLE_OAUTH_CLIENT_ID", "")


def get_google_oauth_client_secret() -> str:
    return os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "")


def get_google_oauth_redirect_uri() -> str:
    return os.getenv("GOOGLE_OAUTH_REDIRECT_URI", "")


def get_google_oauth_scopes() -> str:
    raw = os.getenv("GOOGLE_OAUTH_SCOPES", DEFAULT_GOOGLE_OAUTH_SCOPES).strip()
    return raw or DEFAULT_GOOGLE_OAUTH_SCOPES
