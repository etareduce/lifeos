from typing import AsyncGenerator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from backend.config import get_database_url


DATABASE_URL = get_database_url()

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db() -> None:
    # Ensure model metadata is registered on the current Base.
    import backend.models as models  # noqa: F401
    metadata = Base.metadata
    if not metadata.tables:
        metadata = models.BlobModel.metadata
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
        if conn.dialect.name == "sqlite":
            await _ensure_sqlite_blob_columns(conn)
            await _ensure_sqlite_scheduled_occurrence_columns(conn)
            await _ensure_sqlite_recurrence_columns(conn)
            await _ensure_sqlite_lifeos_columns(conn)


async def _ensure_sqlite_blob_columns(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(blobs)"))
    columns = {row[1] for row in result.fetchall()}
    missing = []
    if "location" not in columns:
        missing.append(("location", "VARCHAR(500)"))
    if "realized_start" not in columns:
        missing.append(("realized_start", "DATETIME"))
    if "realized_end" not in columns:
        missing.append(("realized_end", "DATETIME"))
    for name, col_type in missing:
        await conn.execute(text(f"ALTER TABLE blobs ADD COLUMN {name} {col_type}"))


async def _ensure_sqlite_scheduled_occurrence_columns(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(scheduled_occurrences)"))
    columns = {row[1] for row in result.fetchall()}
    missing = []
    if "segment_index" not in columns:
        missing.append(("segment_index", "INTEGER DEFAULT 0"))
    for name, col_type in missing:
        await conn.execute(
            text(f"ALTER TABLE scheduled_occurrences ADD COLUMN {name} {col_type}")
        )


async def _ensure_sqlite_recurrence_columns(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(recurrences)"))
    columns = {row[1] for row in result.fetchall()}
    missing = []
    if "created_at" not in columns:
        missing.append(("created_at", "DATETIME"))
    if "updated_at" not in columns:
        missing.append(("updated_at", "DATETIME"))
    for name, col_type in missing:
        await conn.execute(text(f"ALTER TABLE recurrences ADD COLUMN {name} {col_type}"))
    if missing:
        await conn.execute(
            text(
                "UPDATE recurrences "
                "SET created_at = COALESCE(created_at, CURRENT_TIMESTAMP), "
                "updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)"
            )
        )


async def _ensure_sqlite_lifeos_columns(conn) -> None:
    await _ensure_sqlite_type_definition_columns(conn)
    await _ensure_sqlite_life_object_columns(conn)


async def _ensure_sqlite_type_definition_columns(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(type_definitions)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return
    missing = []
    if "fields" not in columns:
        missing.append(("fields", "JSON DEFAULT '[]'"))
    if "metadata" not in columns:
        missing.append(("metadata", "JSON DEFAULT '{}'"))
    if "created_at" not in columns:
        missing.append(("created_at", "DATETIME"))
    if "updated_at" not in columns:
        missing.append(("updated_at", "DATETIME"))
    for name, col_type in missing:
        await conn.execute(text(f"ALTER TABLE type_definitions ADD COLUMN {name} {col_type}"))
    if missing:
        await conn.execute(
            text(
                "UPDATE type_definitions "
                "SET fields = COALESCE(fields, '[]'), "
                "metadata = COALESCE(metadata, '{}'), "
                "created_at = COALESCE(created_at, CURRENT_TIMESTAMP), "
                "updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)"
            )
        )


async def _ensure_sqlite_life_object_columns(conn) -> None:
    result = await conn.execute(text("PRAGMA table_info(life_objects)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return
    if "type_id" in columns:
        await _rebuild_legacy_sqlite_life_objects_table(conn, columns)
        result = await conn.execute(text("PRAGMA table_info(life_objects)"))
        columns = {row[1] for row in result.fetchall()}
    missing = []
    if "type_name" not in columns:
        missing.append(("type_name", "VARCHAR(80) DEFAULT 'Page'"))
    if "fields" not in columns:
        missing.append(("fields", "JSON DEFAULT '{}'"))
    if "metadata" not in columns:
        missing.append(("metadata", "JSON DEFAULT '{}'"))
    if "blob_ids" not in columns:
        missing.append(("blob_ids", "JSON DEFAULT '[]'"))
    if "created_at" not in columns:
        missing.append(("created_at", "DATETIME"))
    if "updated_at" not in columns:
        missing.append(("updated_at", "DATETIME"))
    for name, col_type in missing:
        await conn.execute(text(f"ALTER TABLE life_objects ADD COLUMN {name} {col_type}"))
    if missing:
        await conn.execute(
            text(
                "UPDATE life_objects "
                "SET type_name = COALESCE(type_name, 'Page'), "
                "fields = COALESCE(fields, '{}'), "
                "metadata = COALESCE(metadata, '{}'), "
                "blob_ids = COALESCE(blob_ids, '[]'), "
                "created_at = COALESCE(created_at, CURRENT_TIMESTAMP), "
                "updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)"
            )
        )


async def _rebuild_legacy_sqlite_life_objects_table(conn, columns: set[str]) -> None:
    await conn.execute(text("DROP TABLE IF EXISTS life_objects_legacy"))
    await conn.execute(text("ALTER TABLE life_objects RENAME TO life_objects_legacy"))
    await conn.execute(
        text(
            "CREATE TABLE life_objects ("
            "id VARCHAR(36) NOT NULL PRIMARY KEY, "
            "type_name VARCHAR(80) NOT NULL, "
            "fields JSON NOT NULL, "
            "metadata JSON NOT NULL, "
            "blob_ids JSON NOT NULL, "
            "created_at DATETIME NOT NULL, "
            "updated_at DATETIME NOT NULL"
            ")"
        )
    )
    fields_expr = "fields" if "fields" in columns else "NULL"
    value_expr = "value_json" if "value_json" in columns else "NULL"
    metadata_expr = "metadata" if "metadata" in columns else "NULL"
    metadata_json_expr = "metadata_json" if "metadata_json" in columns else "NULL"
    blob_ids_expr = "blob_ids" if "blob_ids" in columns else "NULL"
    type_name_expr = "type_name" if "type_name" in columns else "NULL"
    await conn.execute(
        text(
            "INSERT INTO life_objects "
            "(id, type_name, fields, metadata, blob_ids, created_at, updated_at) "
            "SELECT "
            "id, "
            f"COALESCE({type_name_expr}, 'Page'), "
            f"COALESCE({fields_expr}, {value_expr}, '{{}}'), "
            f"COALESCE({metadata_expr}, {metadata_json_expr}, '{{}}'), "
            f"COALESCE({blob_ids_expr}, '[]'), "
            "COALESCE(created_at, CURRENT_TIMESTAMP), "
            "COALESCE(updated_at, CURRENT_TIMESTAMP) "
            "FROM life_objects_legacy"
        )
    )
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_life_objects_type_name ON life_objects (type_name)"))
    await conn.execute(text("DROP TABLE life_objects_legacy"))
