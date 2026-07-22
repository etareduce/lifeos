from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


PrimitiveKind = Literal[
    "Text",
    "Number",
    "Boolean",
    "Date",
    "Blob",
    "Image",
    "Video",
    "Reference<Object>",
    "List<T>",
]


class TypeField(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: PrimitiveKind
    required: bool = False
    item_kind: str | None = Field(default=None, max_length=80)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("field name cannot be blank")
        return normalized


class TypeDefinitionBase(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    fields: list[TypeField] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def normalize_type_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("type name cannot be blank")
        return normalized


class TypeDefinitionCreate(TypeDefinitionBase):
    pass


class TypeDefinitionUpdate(BaseModel):
    fields: list[TypeField] | None = None
    metadata: dict[str, Any] | None = None


class TypeDefinitionRead(TypeDefinitionBase):
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class LifeObjectBase(BaseModel):
    type_name: str = Field(min_length=1, max_length=80)
    fields: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    blob_ids: list[str] = Field(default_factory=list)

    @field_validator("type_name")
    @classmethod
    def normalize_object_type_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("type_name cannot be blank")
        return normalized


class LifeObjectCreate(LifeObjectBase):
    pass


class LifeObjectUpdate(BaseModel):
    type_name: str | None = Field(default=None, min_length=1, max_length=80)
    fields: dict[str, Any] | None = None
    metadata: dict[str, Any] | None = None
    blob_ids: list[str] | None = None


class LifeObjectRead(LifeObjectBase):
    id: str
    created_at: datetime
    updated_at: datetime


class CaptureCreate(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


class ConvertObjectRequest(BaseModel):
    type_name: str = Field(min_length=1, max_length=80)
    fields: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
