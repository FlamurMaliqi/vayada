from pydantic import BaseModel, ConfigDict, Field

from app.models.room import to_camel


class LinkedInventoryGroupWrite(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    name: str = Field(min_length=1, max_length=120)
    member_room_type_ids: list[str] = Field(min_length=2)


class LinkedInventoryGroupResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    group_id: str
    name: str
    member_room_type_ids: list[str]
