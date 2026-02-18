"""
Seed shared auth database with mock user accounts.

Creates admin, hotel, and creator users in the auth DB.
All mock users get password: Test1234
Admin gets password: Vayada123

Usage:
    python scripts/seed_users.py
"""

import asyncio
import os
import sys
import uuid

import asyncpg
import bcrypt

AUTH_DATABASE_URL = os.getenv(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)

ADMIN_PASSWORD = "Vayada123"
MOCK_PASSWORD = "Test1234"

ADMIN_USER = {
    "email": "admin@vayada.com",
    "name": "Admin User",
    "type": "admin",
    "status": "verified",
    "email_verified": True,
    "avatar": None,
}

MOCK_USERS = [
    # Creators
    {
        "email": "creator1@mock.com",
        "name": "Alexandra Travels",
        "type": "creator",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=1",
    },
    {
        "email": "creator2@mock.com",
        "name": "Marcus Foodie",
        "type": "creator",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=12",
    },
    {
        "email": "creator3@mock.com",
        "name": "Emma Style",
        "type": "creator",
        "status": "pending",
        "email_verified": False,
        "avatar": "https://i.pravatar.cc/150?img=5",
    },
    {
        "email": "creator4@mock.com",
        "name": "David Adventure",
        "type": "creator",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=15",
    },
    # Hotels
    {
        "email": "hotel1@mock.com",
        "name": "Grand Paradise Resort",
        "type": "hotel",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=47",
    },
    {
        "email": "hotel2@mock.com",
        "name": "Mountain View Lodge",
        "type": "hotel",
        "status": "verified",
        "email_verified": True,
        "avatar": None,
    },
    {
        "email": "hotel3@mock.com",
        "name": "Beachside Boutique",
        "type": "hotel",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=51",
    },
    {
        "email": "hotel4@mock.com",
        "name": "City Center Hotel",
        "type": "hotel",
        "status": "pending",
        "email_verified": False,
        "avatar": "https://i.pravatar.cc/150?img=33",
    },
    {
        "email": "hotel5@mock.com",
        "name": "Seaside Retreat",
        "type": "hotel",
        "status": "verified",
        "email_verified": True,
        "avatar": "https://i.pravatar.cc/150?img=60",
    },
]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


async def main():
    conn = await asyncpg.connect(AUTH_DATABASE_URL)
    print("Connected to auth database\n")

    try:
        # Seed admin
        admin_hash = hash_password(ADMIN_PASSWORD)
        result = await conn.execute(
            """
            INSERT INTO users (email, password_hash, name, type, status, email_verified)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (email) DO NOTHING
            """,
            ADMIN_USER["email"],
            admin_hash,
            ADMIN_USER["name"],
            ADMIN_USER["type"],
            ADMIN_USER["status"],
            ADMIN_USER["email_verified"],
        )
        if result == "INSERT 0 0":
            print(f"  Skipped: {ADMIN_USER['email']} (already exists)")
        else:
            print(f"  Created: {ADMIN_USER['email']} (admin)")

        # Seed mock users
        mock_hash = hash_password(MOCK_PASSWORD)
        created = 0
        skipped = 0

        for user in MOCK_USERS:
            result = await conn.execute(
                """
                INSERT INTO users (email, password_hash, name, type, status, email_verified, avatar)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (email) DO NOTHING
                """,
                user["email"],
                mock_hash,
                user["name"],
                user["type"],
                user["status"],
                user["email_verified"],
                user.get("avatar"),
            )
            if result == "INSERT 0 0":
                print(f"  Skipped: {user['email']} (already exists)")
                skipped += 1
            else:
                print(f"  Created: {user['email']} ({user['type']})")
                created += 1

        count = await conn.fetchval("SELECT COUNT(*) FROM users")
        print(f"\nDone. {created} created, {skipped} skipped, {count} total user(s) in auth DB.")
        print(f"\nCredentials:")
        print(f"  Admin:  admin@vayada.com / {ADMIN_PASSWORD}")
        print(f"  Mock:   *@mock.com / {MOCK_PASSWORD}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
