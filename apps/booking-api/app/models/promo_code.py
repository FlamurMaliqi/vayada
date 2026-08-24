from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models.utils import to_camel


class PromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    id: str
    code: str
    discount_type: str
    discount_value: float
    min_booking_value: float | None = None
    applicable_room_ids: list[str] | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    stay_date_from: date | None = None
    stay_date_until: date | None = None
    is_active: bool
    max_uses: int
    current_uses: int
    created_at: datetime | None = None


class CreatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: str = Field(pattern=r"^[A-Za-z0-9_-]{2,40}$")
    discount_type: Literal["percentage", "fixed"] = "percentage"
    discount_value: Decimal = Field(gt=0, max_digits=15, decimal_places=2)
    min_booking_value: Decimal | None = Field(default=None, gt=0, max_digits=15, decimal_places=2)
    applicable_room_ids: list[UUID] | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    stay_date_from: date | None = None
    stay_date_until: date | None = None
    is_active: bool = True
    max_uses: int = Field(default=1, gt=0)

    @field_validator("applicable_room_ids")
    @classmethod
    def validate_room_ids(cls, value: list[UUID] | None) -> list[UUID] | None:
        if value is not None and (not value or len(set(value)) != len(value)):
            raise ValueError("applicableRoomIds must contain unique room type IDs")
        return value

    @model_validator(mode="after")
    def validate_ranges(self):
        if self.discount_type == "percentage" and self.discount_value > 100:
            raise ValueError("percentage discountValue must not exceed 100")
        if self.valid_from and self.valid_until and self.valid_until < self.valid_from:
            raise ValueError("validUntil must be on or after validFrom")
        if (
            self.stay_date_from
            and self.stay_date_until
            and self.stay_date_until < self.stay_date_from
        ):
            raise ValueError("stayDateUntil must be on or after stayDateFrom")
        return self


class UpdatePromoCodeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{2,40}$")
    discount_type: Literal["percentage", "fixed"] | None = None
    discount_value: Decimal | None = Field(default=None, gt=0, max_digits=15, decimal_places=2)
    min_booking_value: Decimal | None = Field(default=None, gt=0, max_digits=15, decimal_places=2)
    applicable_room_ids: list[UUID] | None = None
    valid_from: date | None = None
    valid_until: date | None = None
    stay_date_from: date | None = None
    stay_date_until: date | None = None
    is_active: bool | None = None
    max_uses: int | None = Field(default=None, gt=0)

    @field_validator("applicable_room_ids")
    @classmethod
    def validate_room_ids(cls, value: list[UUID] | None) -> list[UUID] | None:
        if value is not None and (not value or len(set(value)) != len(value)):
            raise ValueError("applicableRoomIds must contain unique room type IDs")
        return value


class ValidatePromoCodeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    valid: bool
    code: str
    discount_type: str | None = None
    discount_value: float | None = None
    currency: str | None = None
    message: str
