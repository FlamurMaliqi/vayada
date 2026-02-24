#!/usr/bin/env bash
#
# Run database migrations against AWS RDS for a given service.
#
# Usage:
#   ./scripts/run_migration.sh pms
#   ./scripts/run_migration.sh booking
#   ./scripts/run_migration.sh marketplace
#   ./scripts/run_migration.sh auth
#
# Prerequisites:
#   - AWS CLI configured with appropriate permissions
#   - infra/terraform.tfvars with database passwords
#   - Python 3 with asyncpg installed
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TFVARS="$REPO_ROOT/infra/terraform.tfvars"
RDS_ENDPOINT="vayada-database.c7eiqkoq4as4.eu-west-1.rds.amazonaws.com"
RDS_SG_ID="sg-0089fc5e42fa33566"
RDS_PORT=5432
AWS_REGION="eu-west-1"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
die() { echo "❌ $*" >&2; exit 1; }

read_tfvar() {
    # Extract a value from terraform.tfvars: key = "value"
    local key="$1"
    grep -E "^${key}[[:space:]]*=" "$TFVARS" | sed 's/.*=[[:space:]]*"\(.*\)"/\1/'
}

# ---------------------------------------------------------------------------
# Validate arguments
# ---------------------------------------------------------------------------
if [[ $# -lt 1 ]]; then
    echo "Usage: $0 <service>"
    echo "  service: pms | booking | marketplace"
    exit 1
fi

SERVICE="$1"

# ---------------------------------------------------------------------------
# Service config mapping (matches infra/ecs.tf)
# ---------------------------------------------------------------------------
case "$SERVICE" in
    pms)
        DB_USER="vayada_pms_user"
        DB_NAME="vayada_pms_db"
        DB_PASSWORD_KEY="db_pms_password"
        MIGRATION_SCRIPT="pms/vayada-pms-backend/scripts/run_migrations.py"
        SERVICE_DIR="pms/vayada-pms-backend"
        ;;
    booking)
        DB_USER="vayada_booking_user"
        DB_NAME="vayada_booking_db"
        DB_PASSWORD_KEY="db_booking_password"
        MIGRATION_SCRIPT="booking-engine/vayada-booking-engine-backend/scripts/run_migrations.py"
        SERVICE_DIR="booking-engine/vayada-booking-engine-backend"
        ;;
    marketplace)
        DB_USER="vayada_user"
        DB_NAME="vayada_db"
        DB_PASSWORD_KEY="db_marketplace_password"
        MIGRATION_SCRIPT="marketplace/vayada-creator-marketplace-backend/scripts/run_migrations.py"
        SERVICE_DIR="marketplace/vayada-creator-marketplace-backend"
        ;;
    auth)
        DB_USER="vayada_auth_user"
        DB_NAME="vayada_auth_db"
        DB_PASSWORD_KEY="db_auth_password"
        MIGRATION_SCRIPT="auth-db/scripts/run_migrations.py"
        SERVICE_DIR="auth-db"
        ;;
    *)
        die "Unknown service: $SERVICE (expected: pms, booking, marketplace, auth)"
        ;;
esac

# ---------------------------------------------------------------------------
# Read password from tfvars
# ---------------------------------------------------------------------------
[[ -f "$TFVARS" ]] || die "terraform.tfvars not found at $TFVARS"

DB_PASSWORD=$(read_tfvar "$DB_PASSWORD_KEY")
[[ -n "$DB_PASSWORD" ]] || die "Could not read $DB_PASSWORD_KEY from $TFVARS"

# Verify migration script exists
FULL_MIGRATION_SCRIPT="$REPO_ROOT/$MIGRATION_SCRIPT"
[[ -f "$FULL_MIGRATION_SCRIPT" ]] || die "Migration script not found: $FULL_MIGRATION_SCRIPT"

# ---------------------------------------------------------------------------
# Get public IP
# ---------------------------------------------------------------------------
echo "🌐 Getting your public IP..."
MY_IP=$(curl -s https://checkip.amazonaws.com | tr -d '[:space:]')
[[ -n "$MY_IP" ]] || die "Could not determine public IP"
echo "   Your IP: $MY_IP"

# ---------------------------------------------------------------------------
# Security group management
# ---------------------------------------------------------------------------
SG_RULE_ADDED=false

cleanup_sg() {
    if [[ "$SG_RULE_ADDED" == "true" ]]; then
        echo ""
        echo "🔒 Removing security group ingress rule..."
        aws ec2 revoke-security-group-ingress \
            --region "$AWS_REGION" \
            --group-id "$RDS_SG_ID" \
            --protocol tcp \
            --port "$RDS_PORT" \
            --cidr "${MY_IP}/32" \
            2>/dev/null && echo "   ✅ Rule removed" || echo "   ⚠️  Could not remove rule (may already be gone)"
    fi
}

trap cleanup_sg EXIT

echo "🔓 Adding temporary security group ingress rule..."
aws ec2 authorize-security-group-ingress \
    --region "$AWS_REGION" \
    --group-id "$RDS_SG_ID" \
    --protocol tcp \
    --port "$RDS_PORT" \
    --cidr "${MY_IP}/32" \
    >/dev/null
SG_RULE_ADDED=true
echo "   ✅ Ingress rule added for ${MY_IP}/32 on port $RDS_PORT"

# Give AWS a moment to propagate the rule
sleep 2

# ---------------------------------------------------------------------------
# Run migrations
# ---------------------------------------------------------------------------
echo ""
echo "🚀 Running $SERVICE migrations..."
echo ""

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${RDS_ENDPOINT}:${RDS_PORT}/${DB_NAME}?sslmode=require"

cd "$REPO_ROOT/$SERVICE_DIR"
DATABASE_URL="$DATABASE_URL" python3 scripts/run_migrations.py

echo ""
echo "✅ Done!"
