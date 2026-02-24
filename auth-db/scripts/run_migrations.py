#!/usr/bin/env python3
"""
Simple migration runner for the shared auth database.
Connects to database and runs all migration files in order.
"""
import os
import sys
import asyncio
import asyncpg
from pathlib import Path


async def run_migrations():
    """Run all migration files in order"""
    migrations_dir = Path(__file__).parent.parent / "migrations"

    if not migrations_dir.exists():
        print(f"Migrations directory not found: {migrations_dir}")
        sys.exit(1)

    migration_files = sorted(migrations_dir.glob("*.sql"))

    if not migration_files:
        print(f"No migration files found in {migrations_dir}")
        sys.exit(1)

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL environment variable is required")
        sys.exit(1)

    print(f"Found {len(migration_files)} migration files")
    print(f"Connecting to database...")
    print()

    try:
        conn = await asyncpg.connect(database_url)
        print("Connected to database")
        print()

        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)

        # Seed initial schema migration if the DB was set up before this runner existed
        has_users = await conn.fetchval(
            "SELECT EXISTS(SELECT 1 FROM information_schema.tables "
            "WHERE table_schema = 'public' AND table_name = 'users')"
        )
        if has_users:
            await conn.execute(
                "INSERT INTO schema_migrations (filename) VALUES ($1) "
                "ON CONFLICT (filename) DO NOTHING",
                "001_auth_schema.sql",
            )

        executed = await conn.fetch("SELECT filename FROM schema_migrations")
        executed_filenames = {row['filename'] for row in executed}

        for migration_file in migration_files:
            filename = migration_file.name

            if filename in executed_filenames:
                print(f"Skipping {filename} (already executed)")
                continue

            print(f"Running {filename}...")

            try:
                sql = migration_file.read_text()

                lines = [line for line in sql.split('\n')
                         if line.strip() and not line.strip().startswith('--')]
                sql_content = '\n'.join(lines).strip()

                if not sql_content:
                    print(f"Skipping {filename} (empty or comments only)")
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
                        filename
                    )
                    print()
                    continue

                async with conn.transaction():
                    await conn.execute(sql)
                    await conn.execute(
                        "INSERT INTO schema_migrations (filename) VALUES ($1)",
                        filename
                    )

                print(f"Completed {filename}")
                print()

            except Exception as e:
                print(f"Error running {filename}: {e}")
                await conn.close()
                sys.exit(1)

        await conn.close()
        print("All migrations completed successfully!")

    except asyncpg.exceptions.InvalidPasswordError:
        print("Invalid database password. Check your DATABASE_URL.")
        sys.exit(1)
    except asyncpg.exceptions.InvalidCatalogNameError:
        print("Database does not exist. Check your DATABASE_URL.")
        sys.exit(1)
    except Exception as e:
        print(f"Database connection error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(run_migrations())
