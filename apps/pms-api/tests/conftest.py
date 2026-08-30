"""
Pytest fixtures and configuration for PMS backend tests.
"""

import os

# Set environment variables BEFORE importing any app modules
os.environ.setdefault(
    "DATABASE_URL", "postgresql://vayada_pms_user:vayada_pms_password@localhost:5436/vayada_pms_db"
)
os.environ.setdefault(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)
os.environ.setdefault(
    "CORS_ORIGINS", "http://localhost:3002,http://localhost:3003,http://localhost:3004"
)
os.environ.setdefault("JWT_SECRET_KEY", "test-secret-key-for-testing-only")
os.environ.setdefault("DEBUG", "true")
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("SMTP_HOST", "")
# S3 config for tests that still exercise legacy S3-backed helpers.
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_fake")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_fake")
os.environ.setdefault("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_connect_test_fake")
os.environ.setdefault("STRIPE_PLATFORM_ACCOUNT_ID", "")
os.environ.setdefault("XENDIT_SECRET_KEY", "xnd_test_fake")
os.environ.setdefault("XENDIT_WEBHOOK_SECRET", "xendit_webhook_test_secret")
os.environ.setdefault("S3_BUCKET_NAME", "test-bucket")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test-access-key")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test-secret-key")

import uuid
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from unittest.mock import patch

import bcrypt
import jwt
import pytest
from app.config import settings
from app.database import AuthDatabase, Database
from app.main import app
from httpx import ASGITransport, AsyncClient

# Test data patterns for cleanup
TEST_EMAIL_PATTERN = "pmstest%@example.com"
TEST_SLUG_PATTERN = "pmstest-%"


@pytest.fixture(scope="session")
async def init_database():
    """Initialize database pools for tests."""
    await Database.get_pool()
    await AuthDatabase.get_pool()
    yield
    await AuthDatabase.close_pool()
    await Database.close_pool()


@pytest.fixture
async def client(init_database) -> AsyncGenerator[AsyncClient, None]:
    """Create an async HTTP client for testing."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def cleanup_database(init_database):
    """
    Cleanup test data after each test.
    Deletes in FK-safe order: bookings -> room_types -> hotels (PMS DB),
    then users (Auth DB).
    """
    yield

    # Delete PMS data for test hotels
    test_hotels = await Database.fetch(
        "SELECT id FROM hotels WHERE slug LIKE $1", TEST_SLUG_PATTERN
    )
    test_hotel_ids = [row["id"] for row in test_hotels]

    if test_hotel_ids:
        # Get booking IDs for FK-safe deletion of payments/payouts
        test_bookings = await Database.fetch(
            "SELECT id FROM bookings WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        test_booking_ids = [row["id"] for row in test_bookings]
        if test_booking_ids:
            await Database.execute(
                "DELETE FROM payouts WHERE booking_id = ANY($1::uuid[])",
                test_booking_ids,
            )
            await Database.execute(
                "DELETE FROM payments WHERE booking_id = ANY($1::uuid[])",
                test_booking_ids,
            )
            await Database.execute(
                "DELETE FROM booking_change_requests WHERE booking_id = ANY($1::uuid[])",
                test_booking_ids,
            )
        await Database.execute(
            "DELETE FROM booking_drafts WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM bookings WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM cancellation_policies WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM hotel_payment_settings WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM property_module_activations WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM affiliate_clicks WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM affiliates WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM room_blocks WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM linked_inventory_groups WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM room_types WHERE hotel_id = ANY($1::uuid[])",
            test_hotel_ids,
        )
        await Database.execute(
            "DELETE FROM hotels WHERE id = ANY($1::uuid[])",
            test_hotel_ids,
        )

    # Also clean up any hotels created by test users (use auth pool directly)
    auth_pool = await AuthDatabase.get_pool()
    async with auth_pool.acquire() as conn:
        test_users = await conn.fetch(
            "SELECT id FROM users WHERE email LIKE $1", TEST_EMAIL_PATTERN
        )
    test_user_ids = [row["id"] for row in test_users]

    if test_user_ids:
        user_hotels = await Database.fetch(
            "SELECT id FROM hotels WHERE user_id = ANY($1::uuid[])",
            test_user_ids,
        )
        user_hotel_ids = [row["id"] for row in user_hotels]
        if user_hotel_ids:
            user_bookings = await Database.fetch(
                "SELECT id FROM bookings WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            user_booking_ids = [row["id"] for row in user_bookings]
            if user_booking_ids:
                await Database.execute(
                    "DELETE FROM payouts WHERE booking_id = ANY($1::uuid[])",
                    user_booking_ids,
                )
                await Database.execute(
                    "DELETE FROM payments WHERE booking_id = ANY($1::uuid[])",
                    user_booking_ids,
                )
                await Database.execute(
                    "DELETE FROM booking_change_requests WHERE booking_id = ANY($1::uuid[])",
                    user_booking_ids,
                )
            await Database.execute(
                "DELETE FROM booking_drafts WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM bookings WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM cancellation_policies WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM hotel_payment_settings WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM property_module_activations WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM affiliate_clicks WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM affiliates WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM room_blocks WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM room_types WHERE hotel_id = ANY($1::uuid[])",
                user_hotel_ids,
            )
            await Database.execute(
                "DELETE FROM hotels WHERE id = ANY($1::uuid[])",
                user_hotel_ids,
            )

    # Clean auth users
    async with auth_pool.acquire() as conn:
        await conn.execute("DELETE FROM users WHERE email LIKE $1", TEST_EMAIL_PATTERN)


@pytest.fixture(autouse=True)
def mock_s3_operations():
    """Mock all S3 operations. Applied to all tests automatically."""
    uploaded_files = []
    deleted_files = []

    async def mock_upload(
        file_content: bytes,
        file_key: str,
        content_type: str = "image/jpeg",
        make_public: bool = True,
    ):
        uploaded_files.append(
            {"content_length": len(file_content), "key": file_key, "content_type": content_type}
        )
        return f"https://test-bucket.s3.amazonaws.com/{file_key}"

    async def mock_delete(file_key: str):
        deleted_files.append(file_key)
        return True

    with (
        patch("app.s3_service.upload_file_to_s3", side_effect=mock_upload),
        patch("app.s3_service.delete_file_from_s3", side_effect=mock_delete),
    ):
        yield {"uploaded": uploaded_files, "deleted": deleted_files}


# ── Helper functions ──────────────────────────────────────────────


def generate_test_email(prefix: str = "pmstest") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


def generate_test_slug(prefix: str = "pmstest") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def create_jwt_token(
    user_id: str, email: str = "test@example.com", user_type: str = "hotel"
) -> str:
    """Create a JWT token matching what the booking engine issues."""
    payload = {
        "sub": user_id,
        "email": email,
        "type": user_type,
        "exp": datetime.now(UTC) + timedelta(hours=24),
        "iat": datetime.now(UTC),
    }
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def get_auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_test_user(
    email: str | None = None,
    password: str = "TestPassword123!",
    name: str = "Test Hotel User",
    user_type: str = "hotel",
    user_status: str = "verified",
) -> dict:
    """Create a test user in the auth database."""
    email = email or generate_test_email()
    password_hash = hash_password(password)

    user = await AuthDatabase.fetchrow(
        """
        INSERT INTO users (email, password_hash, name, type, status, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, email, name, type, status
        """,
        email,
        password_hash,
        name,
        user_type,
        user_status,
        user_status == "verified",
    )
    user = dict(user)
    user["token"] = create_jwt_token(str(user["id"]), user["email"], user["type"])
    return user


async def create_test_hotel(
    user_id: str,
    name: str = "Test Hotel",
    slug: str | None = None,
    contact_email: str = "contact@testhotel.com",
) -> dict:
    """Create a hotel in the PMS database."""
    slug = slug or generate_test_slug()
    row = await Database.fetchrow(
        """
        INSERT INTO hotels (slug, name, contact_email, user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id, slug, name, contact_email, user_id, created_at
        """,
        slug,
        name,
        contact_email,
        user_id,
    )
    return dict(row)


async def create_test_room_type(
    hotel_id: str,
    name: str = "Deluxe Suite",
    base_rate: float = 150.0,
    total_rooms: int = 5,
    max_occupancy: int = 2,
    max_adults: int | None = None,
    max_children: int | None = None,
    is_active: bool = True,
    non_refundable_rate: float | None = None,
    non_refundable_enabled: bool = False,
    images: list[Any] | None = None,
) -> dict:
    """Create a room type in the PMS database."""
    import json

    row = await Database.fetchrow(
        """
        INSERT INTO room_types (
            hotel_id, name, description, short_description,
            max_occupancy, max_adults, max_children, size, base_rate, non_refundable_rate, currency,
            amenities, images, bed_type, features,
            total_rooms, is_active, sort_order, non_refundable_enabled
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12::jsonb, $13::jsonb, $14, $15::jsonb,
            $16, $17, $18, $19
        ) RETURNING *
        """,
        hotel_id,
        name,
        "A spacious suite",
        "Spacious and comfortable",
        max_occupancy,
        max_adults,
        max_children,
        45,
        base_rate,
        non_refundable_rate,
        "EUR",
        json.dumps(["WiFi", "Minibar"]),
        json.dumps(images or []),
        "King",
        json.dumps(["Mountain View"]),
        total_rooms,
        is_active,
        0,
        non_refundable_enabled,
    )
    return dict(row)


async def create_test_booking(
    hotel_id: str,
    room_type_id: str,
    check_in: str = "2026-06-01",
    check_out: str = "2026-06-05",
    guest_email: str = "guest@example.com",
    nightly_rate: float = 150.0,
    status: str = "pending",
    channel: str = "direct",
    payment_status: str = "unpaid",
) -> dict:
    """Create a booking in the PMS database."""
    from datetime import date as date_type

    ci = date_type.fromisoformat(check_in)
    co = date_type.fromisoformat(check_out)
    nights = (co - ci).days
    total = nightly_rate * nights

    row = await Database.fetchrow(
        """
        INSERT INTO bookings (
            hotel_id, room_type_id, booking_reference,
            guest_first_name, guest_last_name, guest_email, guest_phone,
            special_requests, check_in, check_out,
            adults, children, nightly_rate, total_amount, balance_amount, currency, status,
            channel, payment_status
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19
        ) RETURNING *
        """,
        hotel_id,
        room_type_id,
        f"VAY-T{uuid.uuid4().hex[:5].upper()}",
        "John",
        "Doe",
        guest_email,
        "+1234567890",
        "",
        ci,
        co,
        2,
        0,
        nightly_rate,
        total,
        total,
        "EUR",
        status,
        channel,
        payment_status,
    )
    return dict(row)


async def create_test_affiliate(
    hotel_id: str,
    full_name: str = "Test Affiliate",
    email: str | None = None,
    user_id: str | None = None,
) -> dict:
    """Create an affiliate in the PMS database. Optionally link to a user."""
    import secrets
    import string

    email = email or generate_test_email("pmstest-aff")
    code = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(8))
    row = await Database.fetchrow(
        """
        INSERT INTO affiliates (
            hotel_id, referral_code, full_name, email,
            social_media, user_type, user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        """,
        hotel_id,
        code,
        full_name,
        email,
        "https://instagram.com/test",
        "guest",
        user_id,
    )
    return dict(row)


async def set_test_payout_settings(user_id: str, **fields) -> None:
    """Insert/update an affiliate_payout_settings row for a user.

    Pass any subset of payment_method / paypal_email / bank_* / xendit_*
    columns; missing ones keep DB defaults.
    """
    if not fields:
        return
    cols = list(fields.keys())
    placeholders = ", ".join(f"${i + 2}" for i in range(len(cols)))
    set_clause = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols)
    await Database.execute(
        f"""
        INSERT INTO affiliate_payout_settings (user_id, {", ".join(cols)})
        VALUES ($1, {placeholders})
        ON CONFLICT (user_id) DO UPDATE SET {set_clause}, updated_at = now()
        """,
        user_id,
        *(fields[c] for c in cols),
    )


async def create_test_room_block(
    hotel_id: str,
    room_type_id: str,
    start_date: str = "2026-07-01",
    end_date: str = "2026-07-05",
    blocked_count: int = 1,
    reason: str = "Maintenance",
    room_id: str | None = None,
) -> dict:
    """Create a room block in the PMS database."""
    from datetime import date as date_type

    sd = date_type.fromisoformat(start_date)
    ed = date_type.fromisoformat(end_date)
    row = await Database.fetchrow(
        """
        INSERT INTO room_blocks (hotel_id, room_type_id, room_id, start_date, end_date, blocked_count, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        """,
        hotel_id,
        room_type_id,
        room_id,
        sd,
        ed,
        blocked_count,
        reason,
    )
    return dict(row)


async def create_test_room(
    hotel_id: str,
    room_type_id: str,
    room_number: str = "101",
    floor: str = "1",
    status: str = "available",
) -> dict:
    """Create a single individual room in the PMS database."""
    row = await Database.fetchrow(
        """
        INSERT INTO rooms (hotel_id, room_type_id, room_number, floor, status, sort_order)
        VALUES ($1, $2, $3, $4, $5, 0)
        RETURNING *
        """,
        hotel_id,
        room_type_id,
        room_number,
        floor,
        status,
    )
    return dict(row)


async def create_test_payment_settings(
    hotel_id: str,
    platform_fee_type: str = "percentage",
    platform_fee_value: float = 8.0,
    platform_fee_with_affiliate: float = 2.0,
    pay_at_property_enabled: bool = False,
    stripe_connect_account_id: str | None = None,
    stripe_connect_onboarded: bool = False,
) -> dict:
    """Create payment settings for a hotel."""
    row = await Database.fetchrow(
        """
        INSERT INTO hotel_payment_settings (
            hotel_id, platform_fee_type, platform_fee_value,
            platform_fee_with_affiliate, pay_at_property_enabled,
            stripe_connect_account_id, stripe_connect_onboarded
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (hotel_id) DO UPDATE SET
            platform_fee_type = EXCLUDED.platform_fee_type,
            platform_fee_value = EXCLUDED.platform_fee_value,
            platform_fee_with_affiliate = EXCLUDED.platform_fee_with_affiliate,
            pay_at_property_enabled = EXCLUDED.pay_at_property_enabled,
            stripe_connect_account_id = EXCLUDED.stripe_connect_account_id,
            stripe_connect_onboarded = EXCLUDED.stripe_connect_onboarded
        RETURNING *
        """,
        hotel_id,
        platform_fee_type,
        platform_fee_value,
        platform_fee_with_affiliate,
        pay_at_property_enabled,
        stripe_connect_account_id,
        stripe_connect_onboarded,
    )
    return dict(row)


async def create_test_cancellation_policy(
    hotel_id: str,
    free_cancellation_days: int = 7,
    partial_refund_pct: float = 0.0,
) -> dict:
    """Create a cancellation policy for a hotel."""
    row = await Database.fetchrow(
        """
        INSERT INTO cancellation_policies (hotel_id, free_cancellation_days, partial_refund_pct)
        VALUES ($1, $2, $3)
        ON CONFLICT (hotel_id) DO UPDATE SET
            free_cancellation_days = EXCLUDED.free_cancellation_days,
            partial_refund_pct = EXCLUDED.partial_refund_pct
        RETURNING *
        """,
        hotel_id,
        free_cancellation_days,
        partial_refund_pct,
    )
    return dict(row)


async def create_test_booking_with_payment(
    hotel_id: str,
    room_type_id: str,
    check_in: str = "2026-06-01",
    check_out: str = "2026-06-05",
    guest_email: str = "guest@example.com",
    nightly_rate: float = 150.0,
    status: str = "pending",
    payment_method: str = "card",
    payment_status: str = "authorized",
    host_response_deadline: datetime | None = None,
) -> dict:
    """Create a booking with payment fields set."""
    from datetime import date as date_type

    ci = date_type.fromisoformat(check_in)
    co = date_type.fromisoformat(check_out)
    nights = (co - ci).days
    total = nightly_rate * nights

    if host_response_deadline is None:
        host_response_deadline = datetime.now(UTC) + timedelta(hours=24)

    row = await Database.fetchrow(
        """
        INSERT INTO bookings (
            hotel_id, room_type_id, booking_reference,
            guest_first_name, guest_last_name, guest_email, guest_phone,
            special_requests, check_in, check_out,
            adults, children, nightly_rate, total_amount, balance_amount, currency, status,
            payment_method, payment_status, host_response_deadline
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
            $18, $19, $20
        ) RETURNING *
        """,
        hotel_id,
        room_type_id,
        f"VAY-T{uuid.uuid4().hex[:5].upper()}",
        "John",
        "Doe",
        guest_email,
        "+1234567890",
        "",
        ci,
        co,
        2,
        0,
        nightly_rate,
        total,
        total,
        "EUR",
        status,
        payment_method,
        payment_status,
        host_response_deadline,
    )
    return dict(row)


# ── Composite fixtures ────────────────────────────────────────────


@pytest.fixture
async def hotel_user(cleanup_database):
    """Create a hotel-type user in auth DB."""
    return await create_test_user()


@pytest.fixture
async def hotel_with_rooms(cleanup_database):
    """Create a user + hotel + room type + individual rooms (one per total_rooms)."""
    user = await create_test_user()
    hotel = await create_test_hotel(str(user["id"]))
    room = await create_test_room_type(str(hotel["id"]))
    individual_rooms = []
    for i in range(room["total_rooms"]):
        r = await create_test_room(
            str(hotel["id"]),
            str(room["id"]),
            room_number=str(100 + i),
        )
        individual_rooms.append(r)
    return {
        "user": user,
        "hotel": hotel,
        "room": room,
        "rooms": individual_rooms,
    }


@pytest.fixture
async def hotel_with_booking(hotel_with_rooms):
    """Create a user + hotel + room + booking."""
    data = hotel_with_rooms
    booking = await create_test_booking(
        str(data["hotel"]["id"]),
        str(data["room"]["id"]),
    )
    data["booking"] = booking
    return data
