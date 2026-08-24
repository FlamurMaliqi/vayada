import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import require_current_hotel
from app.models.promo_code import (
    CreatePromoCodeRequest,
    PromoCodeResponse,
    UpdatePromoCodeRequest,
)
from app.repositories.promo_code_repo import PromoCodeRepository

router = APIRouter()


def _promo_to_response(row: dict) -> PromoCodeResponse:
    return PromoCodeResponse(
        id=str(row["id"]),
        code=row["code"],
        discount_type=row["discount_type"],
        discount_value=float(row["discount_value"]),
        min_booking_value=(
            float(row["min_booking_value"]) if row.get("min_booking_value") is not None else None
        ),
        applicable_room_ids=[str(room_id) for room_id in row.get("applicable_room_ids") or []]
        or None,
        valid_from=row.get("valid_from"),
        valid_until=row.get("valid_until"),
        stay_date_from=row.get("stay_date_from"),
        stay_date_until=row.get("stay_date_until"),
        is_active=row["is_active"],
        max_uses=row["max_uses"],
        current_uses=row["current_uses"],
        created_at=row.get("created_at"),
    )


@router.get("/promo-codes", response_model=list[PromoCodeResponse])
async def list_promo_codes(hotel: dict = Depends(require_current_hotel)):
    rows = await PromoCodeRepository.list_by_hotel_id(str(hotel["id"]))
    return [_promo_to_response(row) for row in rows]


@router.post("/promo-codes", response_model=PromoCodeResponse, status_code=status.HTTP_201_CREATED)
async def create_promo_code(
    data: CreatePromoCodeRequest,
    hotel: dict = Depends(require_current_hotel),
):
    try:
        row = await PromoCodeRepository.create(
            hotel_id=str(hotel["id"]),
            code=data.code,
            discount_type=data.discount_type,
            discount_value=data.discount_value,
            min_booking_value=data.min_booking_value,
            applicable_room_ids=[str(room_id) for room_id in data.applicable_room_ids or []]
            or None,
            valid_from=data.valid_from,
            valid_until=data.valid_until,
            stay_date_from=data.stay_date_from,
            stay_date_until=data.stay_date_until,
            is_active=data.is_active,
            max_uses=data.max_uses,
        )
    except asyncpg.UniqueViolationError as error:
        raise HTTPException(status_code=409, detail="Promo code already exists") from error
    return _promo_to_response(row)


@router.patch("/promo-codes/{promo_id}", response_model=PromoCodeResponse)
async def update_promo_code(
    promo_id: str,
    data: UpdatePromoCodeRequest,
    hotel: dict = Depends(require_current_hotel),
):
    hotel_id = str(hotel["id"])
    existing = await PromoCodeRepository.get_by_id(promo_id, hotel_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Promo code not found")

    updates = data.model_dump(exclude_unset=True)
    for required_field in ("code", "discount_type", "discount_value", "is_active", "max_uses"):
        if required_field in updates and updates[required_field] is None:
            raise HTTPException(status_code=422, detail=f"{required_field} cannot be null")
    if "code" in updates:
        updates["code"] = updates["code"].upper()
    if "applicable_room_ids" in updates and updates["applicable_room_ids"] is not None:
        updates["applicable_room_ids"] = [
            str(room_id) for room_id in updates["applicable_room_ids"]
        ]

    effective = {**existing, **updates}
    if effective["discount_type"] == "percentage" and effective["discount_value"] > 100:
        raise HTTPException(status_code=422, detail="Percentage discount cannot exceed 100")
    if effective.get("valid_from") and effective.get("valid_until"):
        if effective["valid_until"] < effective["valid_from"]:
            raise HTTPException(
                status_code=422, detail="Valid until must be on or after valid from"
            )
    if effective.get("stay_date_from") and effective.get("stay_date_until"):
        if effective["stay_date_until"] < effective["stay_date_from"]:
            raise HTTPException(
                status_code=422, detail="Stays until must be on or after stays from"
            )

    if updates:
        try:
            row = await PromoCodeRepository.update(promo_id, hotel_id, updates)
        except asyncpg.UniqueViolationError as error:
            raise HTTPException(status_code=409, detail="Promo code already exists") from error
    else:
        row = existing

    return _promo_to_response(row)


@router.delete("/promo-codes/{promo_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_promo_code(
    promo_id: str,
    hotel: dict = Depends(require_current_hotel),
):
    deleted = await PromoCodeRepository.delete(promo_id, str(hotel["id"]))
    if not deleted:
        raise HTTPException(status_code=404, detail="Promo code not found")
