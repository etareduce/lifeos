from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.analytics_models import AnalyticsBase
from backend.config import get_analytics_database_url


ANALYTICS_DATABASE_URL = get_analytics_database_url()

analytics_engine = create_async_engine(ANALYTICS_DATABASE_URL, pool_pre_ping=True)
AnalyticsSessionLocal = async_sessionmaker(analytics_engine, expire_on_commit=False)


async def get_analytics_session() -> AsyncGenerator[AsyncSession, None]:
    async with AnalyticsSessionLocal() as session:
        yield session


async def init_analytics_db() -> None:
    import backend.analytics_models as analytics_models  # noqa: F401

    metadata = AnalyticsBase.metadata
    if not metadata.tables:
        metadata = analytics_models.AnalyticsBase.metadata
    async with analytics_engine.begin() as conn:
        await conn.run_sync(metadata.create_all)
