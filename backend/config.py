import os


DEFAULT_DATABASE_URL = "sqlite+aiosqlite:///./core.db"
DEFAULT_ANALYTICS_DATABASE_URL = "sqlite+aiosqlite:///./analytics.db"
DEFAULT_PREFERENCE_BATCH_SIZE = 20


def get_database_url() -> str:
    return os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)


def get_analytics_database_url() -> str:
    return os.getenv("ANALYTICS_DATABASE_URL", DEFAULT_ANALYTICS_DATABASE_URL)


def get_preference_batch_size() -> int:
    raw = os.getenv("PREFERENCE_BATCH_SIZE", str(DEFAULT_PREFERENCE_BATCH_SIZE))
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_PREFERENCE_BATCH_SIZE
    return max(1, value)
