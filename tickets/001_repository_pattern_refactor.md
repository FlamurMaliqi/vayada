# Ticket: Refactor to Repository Pattern

**Priority:** Medium
**Depends on:** Shared Auth DB migration (complete)
**Scope:** Marketplace backend + Booking engine backend

## Problem

Raw SQL queries are scattered across router files, dependencies, and auth modules. This means:
- Queries for the same table appear in many files
- Schema changes require updating SQL in multiple places
- The `Database` vs `AuthDatabase` decision is repeated everywhere instead of centralized
- Hard to test data access in isolation

## Goal

Introduce a repository layer that centralizes all database queries per table/domain. Routers call repository methods instead of writing SQL inline.

## Proposed Structure

```
app/
  repositories/
    __init__.py
    user_repo.py          # AuthDatabase - users table
    password_reset_repo.py # AuthDatabase - password_reset_tokens
    verification_repo.py   # AuthDatabase - email_verification_codes + tokens
    consent_repo.py        # AuthDatabase - cookie_consent, consent_history, gdpr_requests
    creator_repo.py        # Database - creators table
    hotel_repo.py          # Database - hotel_profiles table
    collaboration_repo.py  # Database - collaborations table
    chat_repo.py           # Database - chat tables
    marketplace_repo.py    # Database - marketplace listing queries
```

## Example

Before (in routers/auth.py):
```python
user = await AuthDatabase.fetchrow(
    "SELECT id, email, password_hash, name, type, status FROM users WHERE email = $1",
    request.email
)
```

After:
```python
from app.repositories.user_repo import UserRepository

user = await UserRepository.get_by_email(request.email)
```

Repository implementation:
```python
# app/repositories/user_repo.py
from app.database import AuthDatabase

class UserRepository:
    @staticmethod
    async def get_by_email(email: str):
        return await AuthDatabase.fetchrow(
            "SELECT * FROM users WHERE email = $1", email
        )

    @staticmethod
    async def get_by_id(user_id: str):
        return await AuthDatabase.fetchrow(
            "SELECT * FROM users WHERE id = $1", user_id
        )

    @staticmethod
    async def create(email: str, password_hash: str, name: str, user_type: str, **consent_fields):
        return await AuthDatabase.fetchrow(
            """
            INSERT INTO users (email, password_hash, name, type, status, ...)
            VALUES ($1, $2, $3, $4, 'pending', ...)
            RETURNING *
            """,
            email, password_hash, name, user_type, ...
        )

    @staticmethod
    async def update_password(user_id: str, password_hash: str):
        await AuthDatabase.execute(
            "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
            password_hash, user_id
        )
    # ... etc
```

## Files to Refactor

### Marketplace (`marketplace/vayada-creator-marketplace-backend/`)

| File | Queries to extract |
|------|--------------------|
| `app/auth.py` | All user, password_reset_token, email_verification queries |
| `app/dependencies.py` | User lookups, creator/hotel profile lookups |
| `app/routers/auth.py` | User CRUD, consent_history inserts, profile creation |
| `app/routers/admin.py` | User CRUD, profile CRUD |
| `app/routers/creators.py` | Creator queries, user lookups |
| `app/routers/hotels.py` | Hotel profile queries, user lookups |
| `app/routers/marketplace.py` | Listing queries, user status filters |
| `app/routers/collaborations.py` | Collaboration queries, user lookups |
| `app/routers/chat.py` | Chat queries, user name lookups |
| `app/routers/consent.py` | Cookie consent, consent history queries |
| `app/routers/gdpr.py` | GDPR request queries, cross-table data export |

### Booking Engine (`booking-engine/vayada-booking-engine-backend/`)

| File | Queries to extract |
|------|--------------------|
| `app/dependencies.py` | User lookups from AuthDatabase |
| `app/routers/admin.py` | User + business profile queries |

## Implementation Order

1. Create `app/repositories/` directory with `__init__.py`
2. Start with `user_repo.py` — most widely used, touches every file
3. Then `creator_repo.py` + `hotel_repo.py` — used in dependencies + multiple routers
4. Then remaining repos one by one
5. Update all importing files to use repositories
6. Remove inline SQL from routers
7. Apply same pattern to booking engine backend
8. Verify all tests pass

## Notes

- Each repository class uses `@staticmethod` methods (no instance state, just like the current `Database` class pattern)
- The `Database` vs `AuthDatabase` choice is made once per repo, not per query
- Complex cross-table operations (like register with compensating action) can live in a service layer if needed, or stay in the router calling multiple repos
- No ORM — keep asyncpg + raw SQL, just centralize it
