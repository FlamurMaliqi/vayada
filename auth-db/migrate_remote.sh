#!/bin/bash
# ============================================
# Remote Migration: Split Auth from Business DB
# ============================================
# This script migrates auth data from the marketplace business database
# to the new shared auth database. Run this ONCE on your remote databases.
#
# Steps:
#   1. Create auth DB schema
#   2. Copy auth data from business DB → auth DB
#   3. Verify data was copied correctly
#   4. Drop auth tables from business DB
#
# Usage:
#   chmod +x migrate_remote.sh
#   ./migrate_remote.sh

set -e

# ============================================
# CONFIGURE THESE — your remote DB credentials
# ============================================
# Business DB (marketplace)
BIZ_HOST="localhost"
BIZ_PORT="5432"
BIZ_USER="vayada_user"
BIZ_DB="vayada_db"
# export PGPASSWORD or use .pgpass for the business DB password

# Auth DB (new shared auth database)
AUTH_HOST="localhost"
AUTH_PORT="5435"
AUTH_USER="vayada_auth_user"
AUTH_DB="vayada_auth_db"
AUTH_PASSWORD=""  # Set this or use PGPASSWORD/pgpass

# ============================================
# Tables to migrate (order matters — users first)
# ============================================
AUTH_TABLES=(
    "users"
    "password_reset_tokens"
    "email_verification_codes"
    "email_verification_tokens"
    "cookie_consent"
    "consent_history"
    "gdpr_requests"
)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "============================================"
echo " Auth Database Migration Script"
echo "============================================"
echo ""

# ============================================
# Step 0: Test connections
# ============================================
echo -e "${YELLOW}Step 0: Testing database connections...${NC}"

echo -n "  Business DB ($BIZ_HOST:$BIZ_PORT/$BIZ_DB)... "
if psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "Cannot connect to business database. Check credentials and ensure the database is accessible."
    exit 1
fi

echo -n "  Auth DB ($AUTH_HOST:$AUTH_PORT/$AUTH_DB)... "
if PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" -c "SELECT 1" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAILED${NC}"
    echo "Cannot connect to auth database. Make sure the database exists and is accessible."
    echo "You may need to create it first:"
    echo "  CREATE DATABASE $AUTH_DB OWNER $AUTH_USER;"
    exit 1
fi

echo ""

# ============================================
# Step 1: Check if business DB has auth tables
# ============================================
echo -e "${YELLOW}Step 1: Checking business DB for auth tables...${NC}"

USER_COUNT=$(psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -t -A -c \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'" 2>/dev/null)

if [ "$USER_COUNT" -eq 0 ]; then
    echo -e "${RED}  No 'users' table found in business DB. Nothing to migrate.${NC}"
    exit 1
fi

BIZ_USER_COUNT=$(psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -t -A -c \
    "SELECT COUNT(*) FROM users" 2>/dev/null)
echo -e "  Found ${GREEN}$BIZ_USER_COUNT users${NC} in business DB"

# Show counts for all tables
for table in "${AUTH_TABLES[@]}"; do
    count=$(psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -t -A -c \
        "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "0")
    echo "  $table: $count rows"
done

echo ""

# ============================================
# Step 2: Create auth DB schema
# ============================================
echo -e "${YELLOW}Step 2: Creating auth DB schema...${NC}"

# Check if users table already exists in auth DB
AUTH_TABLE_EXISTS=$(PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" -t -A -c \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'" 2>/dev/null)

if [ "$AUTH_TABLE_EXISTS" -gt 0 ]; then
    AUTH_EXISTING_COUNT=$(PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" -t -A -c \
        "SELECT COUNT(*) FROM users" 2>/dev/null)
    if [ "$AUTH_EXISTING_COUNT" -gt 0 ]; then
        echo -e "${RED}  Auth DB already has $AUTH_EXISTING_COUNT users. Aborting to avoid duplicates.${NC}"
        echo "  If you want to re-run, drop the auth tables first or clear the data."
        exit 1
    fi
    echo -e "  Schema already exists (empty tables). Skipping schema creation."
else
    # Run schema migration (without the admin user INSERT at the end)
    PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" \
        -f "$SCRIPT_DIR/migrations/001_auth_schema.sql"
    echo -e "  ${GREEN}Schema created${NC}"
fi

echo ""

# ============================================
# Step 3: Copy data from business DB → auth DB
# ============================================
echo -e "${YELLOW}Step 3: Copying auth data from business DB to auth DB...${NC}"

DUMP_FILE=$(mktemp /tmp/auth_migration_XXXXXX.sql)
echo "  Using temp file: $DUMP_FILE"

# Dump data from each auth table (order matters — users first due to FKs)
for table in "${AUTH_TABLES[@]}"; do
    echo -n "  Dumping $table... "

    count=$(psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -t -A -c \
        "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "0")

    if [ "$count" -gt 0 ]; then
        pg_dump -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" \
            --data-only --table="public.$table" --no-owner --no-privileges \
            >> "$DUMP_FILE" 2>/dev/null
        echo -e "${GREEN}$count rows${NC}"
    else
        echo "0 rows (skipped)"
    fi
done

echo ""
echo -n "  Importing into auth DB... "

PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" \
    -f "$DUMP_FILE" > /dev/null 2>&1

echo -e "${GREEN}done${NC}"

# Clean up temp file
rm -f "$DUMP_FILE"

echo ""

# ============================================
# Step 4: Verify data was copied
# ============================================
echo -e "${YELLOW}Step 4: Verifying data in auth DB...${NC}"

MIGRATION_OK=true

for table in "${AUTH_TABLES[@]}"; do
    biz_count=$(psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" -t -A -c \
        "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "0")
    auth_count=$(PGPASSWORD="$AUTH_PASSWORD" psql -h "$AUTH_HOST" -p "$AUTH_PORT" -U "$AUTH_USER" -d "$AUTH_DB" -t -A -c \
        "SELECT COUNT(*) FROM $table" 2>/dev/null || echo "0")

    if [ "$biz_count" -eq "$auth_count" ]; then
        echo -e "  $table: ${GREEN}$auth_count / $biz_count OK${NC}"
    else
        echo -e "  $table: ${RED}$auth_count / $biz_count MISMATCH${NC}"
        MIGRATION_OK=false
    fi
done

echo ""

if [ "$MIGRATION_OK" = false ]; then
    echo -e "${RED}Data verification failed! Row counts don't match.${NC}"
    echo "The auth DB has the data that was copied, but counts differ."
    echo "Please investigate before proceeding."
    echo ""
    echo "The business DB auth tables have NOT been dropped."
    exit 1
fi

echo -e "${GREEN}All row counts match!${NC}"
echo ""

# ============================================
# Step 5: Drop auth tables from business DB
# ============================================
echo -e "${YELLOW}Step 5: Ready to drop auth tables from business DB${NC}"
echo ""
echo "  This will:"
echo "  - Drop FK constraints from creators, hotel_profiles, chat_messages"
echo "  - Drop tables: users, password_reset_tokens, email_verification_codes,"
echo "    email_verification_tokens, cookie_consent, consent_history, gdpr_requests"
echo ""
read -p "  Proceed? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    echo "  Aborted. Auth data is in the auth DB but business DB still has the old tables."
    echo "  You can re-run this script or manually run 028_remove_auth_tables.sql later."
    exit 0
fi

psql -h "$BIZ_HOST" -p "$BIZ_PORT" -U "$BIZ_USER" -d "$BIZ_DB" \
    -f "$SCRIPT_DIR/../marketplace/vayada-creator-marketplace-backend/migrations/028_remove_auth_tables.sql"

echo -e "  ${GREEN}Auth tables dropped from business DB${NC}"

echo ""
echo "============================================"
echo -e "${GREEN} Migration complete!${NC}"
echo "============================================"
echo ""
echo "Summary:"
echo "  - Auth data copied to: $AUTH_HOST:$AUTH_PORT/$AUTH_DB"
echo "  - Auth tables removed from: $BIZ_HOST:$BIZ_PORT/$BIZ_DB"
echo ""
echo "Next steps:"
echo "  1. Update your backend's .env to include AUTH_DATABASE_URL"
echo "  2. Deploy the updated backend code"
echo "  3. Test login/register to confirm everything works"
