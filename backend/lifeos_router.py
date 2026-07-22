import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_session
from backend.lifeos_schemas import (
    CaptureCreate,
    ConvertObjectRequest,
    LifeObjectCreate,
    LifeObjectRead,
    LifeObjectUpdate,
    TypeDefinitionCreate,
    TypeDefinitionRead,
    TypeDefinitionUpdate,
)
from backend.models import LifeObjectModel, TypeDefinitionModel


lifeos_router = APIRouter(prefix="/lifeos", tags=["lifeos"])


DEFAULT_TYPES = [
    {
        "name": "Page",
        "metadata": {"kind": "built_in"},
        "fields": [
            {"name": "title", "kind": "Text"},
            {"name": "content", "kind": "Text"},
        ],
    },
    {"name": "Text", "metadata": {"kind": "primitive", "primitive": "Text"}, "fields": []},
    {"name": "Number", "metadata": {"kind": "primitive", "primitive": "Number"}, "fields": []},
    {"name": "Boolean", "metadata": {"kind": "primitive", "primitive": "Boolean"}, "fields": []},
    {"name": "Date", "metadata": {"kind": "primitive", "primitive": "Date"}, "fields": []},
    {
        "name": "List",
        "metadata": {"kind": "primitive", "primitive": "List", "item_type": "Object"},
        "fields": [{"name": "items", "kind": "List<T>", "item_kind": "Object"}],
    },
    {
        "name": "Image",
        "metadata": {"kind": "primitive", "primitive": "Image"},
        "fields": [
            {"name": "title", "kind": "Text"},
            {"name": "image", "kind": "Image"},
        ],
    },
    {
        "name": "Video",
        "metadata": {"kind": "primitive", "primitive": "Video"},
        "fields": [
            {"name": "title", "kind": "Text"},
            {"name": "video", "kind": "Video"},
        ],
    },
    {
        "name": "Blob",
        "metadata": {"kind": "primitive", "primitive": "Blob", "backend": "recurrence"},
        "fields": [
            {"name": "title", "kind": "Text"},
            {"name": "recurrence", "kind": "Blob"},
        ],
    },
    {
        "name": "Goal",
        "metadata": {"kind": "group"},
        "fields": [
            {"name": "title", "kind": "Text", "required": True},
            {"name": "description", "kind": "Text"},
            {"name": "progress", "kind": "Number"},
            {"name": "deadline", "kind": "Date"},
            {"name": "related_objects", "kind": "List<T>", "item_kind": "Reference<Object>"},
        ],
    },
    {
        "name": "Notebook",
        "metadata": {"kind": "group"},
        "fields": [
            {"name": "title", "kind": "Text", "required": True},
            {"name": "pages", "kind": "List<T>", "item_kind": "Reference<Object>"},
        ],
    },
    {
        "name": "Project",
        "metadata": {"kind": "group"},
        "fields": [
            {"name": "title", "kind": "Text", "required": True},
            {"name": "description", "kind": "Text"},
            {"name": "status", "kind": "Text"},
            {"name": "goals", "kind": "List<T>", "item_kind": "Reference<Object>"},
        ],
    },
    {
        "name": "Person",
        "metadata": {"kind": "group"},
        "fields": [
            {"name": "name", "kind": "Text", "required": True},
            {"name": "notes", "kind": "Text"},
        ],
    },
    {
        "name": "Book",
        "metadata": {"kind": "group"},
        "fields": [
            {"name": "title", "kind": "Text", "required": True},
            {"name": "author", "kind": "Text"},
            {"name": "status", "kind": "Text"},
            {"name": "notes", "kind": "List<T>", "item_kind": "Reference<Object>"},
            {"name": "rating", "kind": "Number"},
        ],
    },
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _type_to_schema(model: TypeDefinitionModel) -> TypeDefinitionRead:
    return TypeDefinitionRead(
        name=model.name,
        fields=model.fields or [],
        metadata=model.meta or {},
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


def _object_to_schema(model: LifeObjectModel) -> LifeObjectRead:
    return LifeObjectRead(
        id=model.id,
        type_name=model.type_name,
        fields=model.fields or {},
        metadata=model.meta or {},
        blob_ids=model.blob_ids or [],
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


async def _ensure_default_types(session: AsyncSession) -> None:
    result = await session.execute(select(TypeDefinitionModel.name))
    existing = set(result.scalars().all())
    created = False
    now = _now()
    for type_def in DEFAULT_TYPES:
        if type_def["name"] in existing:
            continue
        session.add(
            TypeDefinitionModel(
                name=type_def["name"],
                fields=type_def["fields"],
                meta=type_def.get("metadata", {}),
                created_at=now,
                updated_at=now,
            )
        )
        created = True
    if created:
        await session.commit()


async def _get_type_or_404(session: AsyncSession, type_name: str) -> TypeDefinitionModel:
    await _ensure_default_types(session)
    result = await session.execute(
        select(TypeDefinitionModel).where(TypeDefinitionModel.name == type_name)
    )
    type_def = result.scalar_one_or_none()
    if not type_def:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Type '{type_name}' not found",
        )
    return type_def


def _validate_fields(type_def: TypeDefinitionModel, fields: dict[str, Any]) -> None:
    known_fields = {field.get("name"): field for field in type_def.fields or []}
    unknown = sorted(set(fields) - set(known_fields))
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown field(s) for {type_def.name}: {', '.join(unknown)}",
        )
    missing = [
        name
        for name, field in known_fields.items()
        if field.get("required") and fields.get(name) in (None, "")
    ]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Missing required field(s) for {type_def.name}: {', '.join(missing)}",
        )


@lifeos_router.get("/types", response_model=list[TypeDefinitionRead], operation_id="list_lifeos_types")
async def list_types(session: AsyncSession = Depends(get_session)) -> list[TypeDefinitionRead]:
    await _ensure_default_types(session)
    result = await session.execute(select(TypeDefinitionModel).order_by(TypeDefinitionModel.name))
    return [_type_to_schema(type_def) for type_def in result.scalars().all()]


@lifeos_router.post(
    "/types",
    response_model=TypeDefinitionRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_lifeos_type",
)
async def create_type(
    payload: TypeDefinitionCreate, session: AsyncSession = Depends(get_session)
) -> TypeDefinitionRead:
    await _ensure_default_types(session)
    result = await session.execute(
        select(TypeDefinitionModel).where(TypeDefinitionModel.name == payload.name)
    )
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Type '{payload.name}' already exists",
        )
    now = _now()
    type_def = TypeDefinitionModel(
        name=payload.name,
        fields=[field.model_dump() for field in payload.fields],
        meta=payload.metadata,
        created_at=now,
        updated_at=now,
    )
    session.add(type_def)
    await session.commit()
    await session.refresh(type_def)
    return _type_to_schema(type_def)


@lifeos_router.put(
    "/types/{type_name}",
    response_model=TypeDefinitionRead,
    operation_id="update_lifeos_type",
)
async def update_type(
    type_name: str,
    payload: TypeDefinitionUpdate,
    session: AsyncSession = Depends(get_session),
) -> TypeDefinitionRead:
    await _ensure_default_types(session)
    result = await session.execute(
        select(TypeDefinitionModel).where(TypeDefinitionModel.name == type_name)
    )
    type_def = result.scalar_one_or_none()
    if not type_def:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Type not found")
    if payload.fields is not None:
        type_def.fields = [field.model_dump() for field in payload.fields]
    if payload.metadata is not None:
        type_def.meta = payload.metadata
    type_def.updated_at = _now()
    await session.commit()
    await session.refresh(type_def)
    return _type_to_schema(type_def)


@lifeos_router.get(
    "/objects",
    response_model=list[LifeObjectRead],
    operation_id="list_lifeos_objects",
)
async def list_objects(
    type_name: str | None = Query(default=None, max_length=80),
    has_blobs: bool | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
) -> list[LifeObjectRead]:
    query = select(LifeObjectModel).order_by(LifeObjectModel.updated_at.desc())
    if type_name:
        query = query.where(LifeObjectModel.type_name == type_name)
    result = await session.execute(query)
    objects = [_object_to_schema(obj) for obj in result.scalars().all()]
    if has_blobs is not None:
        objects = [obj for obj in objects if bool(obj.blob_ids) is has_blobs]
    return objects


@lifeos_router.post(
    "/objects",
    response_model=LifeObjectRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="create_lifeos_object",
)
async def create_object(
    payload: LifeObjectCreate, session: AsyncSession = Depends(get_session)
) -> LifeObjectRead:
    type_def = await _get_type_or_404(session, payload.type_name)
    _validate_fields(type_def, payload.fields)
    now = _now()
    obj = LifeObjectModel(
        id=str(uuid.uuid4()),
        type_name=payload.type_name,
        fields=payload.fields,
        meta=payload.metadata,
        blob_ids=payload.blob_ids,
        created_at=now,
        updated_at=now,
    )
    session.add(obj)
    await session.commit()
    await session.refresh(obj)
    return _object_to_schema(obj)


@lifeos_router.post(
    "/capture",
    response_model=LifeObjectRead,
    status_code=status.HTTP_201_CREATED,
    operation_id="capture_lifeos_text",
)
async def capture_text(
    payload: CaptureCreate, session: AsyncSession = Depends(get_session)
) -> LifeObjectRead:
    text = payload.text.strip()
    title = text.splitlines()[0][:120]
    return await create_object(
        LifeObjectCreate(
            type_name="Page",
            fields={"title": title, "content": text},
            metadata={"captured_from": "home", "review_status": "pending"},
            blob_ids=[],
        ),
        session,
    )


@lifeos_router.get(
    "/objects/{object_id}",
    response_model=LifeObjectRead,
    operation_id="get_lifeos_object",
)
async def get_object(
    object_id: str, session: AsyncSession = Depends(get_session)
) -> LifeObjectRead:
    result = await session.execute(select(LifeObjectModel).where(LifeObjectModel.id == object_id))
    obj = result.scalar_one_or_none()
    if not obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Object not found")
    return _object_to_schema(obj)


@lifeos_router.put(
    "/objects/{object_id}",
    response_model=LifeObjectRead,
    operation_id="update_lifeos_object",
)
async def update_object(
    object_id: str,
    payload: LifeObjectUpdate,
    session: AsyncSession = Depends(get_session),
) -> LifeObjectRead:
    result = await session.execute(select(LifeObjectModel).where(LifeObjectModel.id == object_id))
    obj = result.scalar_one_or_none()
    if not obj:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Object not found")
    type_name = payload.type_name or obj.type_name
    fields = payload.fields if payload.fields is not None else obj.fields or {}
    type_def = await _get_type_or_404(session, type_name)
    _validate_fields(type_def, fields)
    obj.type_name = type_name
    obj.fields = fields
    if payload.metadata is not None:
        obj.meta = payload.metadata
    if payload.blob_ids is not None:
        obj.blob_ids = payload.blob_ids
    obj.updated_at = _now()
    await session.commit()
    await session.refresh(obj)
    return _object_to_schema(obj)


@lifeos_router.post(
    "/objects/{object_id}/convert",
    response_model=LifeObjectRead,
    operation_id="convert_lifeos_object",
)
async def convert_object(
    object_id: str,
    payload: ConvertObjectRequest,
    session: AsyncSession = Depends(get_session),
) -> LifeObjectRead:
    update = LifeObjectUpdate(
        type_name=payload.type_name,
        fields=payload.fields,
        metadata=payload.metadata,
    )
    return await update_object(object_id, update, session)
