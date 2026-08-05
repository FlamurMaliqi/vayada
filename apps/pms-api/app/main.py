import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import AuthDatabase, BookingEngineDatabase, Database
from app.dependencies import capture_hotel_header
from app.routers.admin import router as admin_router
from app.routers.admin_affiliates import router as admin_affiliates_router
from app.routers.admin_bookings import router as admin_bookings_router
from app.routers.admin_channex import router as admin_channex_router
from app.routers.admin_checkin_checklist import router as admin_checkin_checklist_router
from app.routers.admin_checkout import router as admin_checkout_router
from app.routers.admin_financials import router as admin_financials_router
from app.routers.admin_messaging import router as admin_messaging_router
from app.routers.admin_module_activations import router as admin_module_activations_router
from app.routers.admin_payments import router as admin_payments_router
from app.routers.admin_room_blocks import router as admin_room_blocks_router
from app.routers.admin_room_types import router as admin_room_types_router
from app.routers.admin_rooms import router as admin_rooms_router
from app.routers.affiliate_dashboard import router as affiliate_dashboard_router
from app.routers.affiliates import router as affiliates_router
from app.routers.bookings import router as bookings_router
from app.routers.platform_admin import router as platform_admin_router
from app.routers.rooms import router as rooms_router
from app.routers.super_admin_bookings import router as super_admin_bookings_router
from app.routers.super_admin_payouts import router as super_admin_payouts_router
from app.routers.webhooks import router as webhooks_router
from app.services.scheduler import (
    fixed_plan_billing_scheduler,
    get_scheduler_health_status,
    get_scheduler_status,
    setup_fixed_plan_billing_scheduler,
    setup_scheduler,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

scheduler = setup_scheduler()
billing_scheduler = setup_fixed_plan_billing_scheduler(fixed_plan_billing_scheduler)


async def run_migrations():
    """Run pending SQL migrations on startup."""
    from pathlib import Path

    pool = await Database.get_pool()
    async with pool.acquire() as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            )
        """)
        executed = {
            r["filename"] for r in await conn.fetch("SELECT filename FROM schema_migrations")
        }
        migrations_dir = Path(__file__).parent.parent / "migrations"
        for f in sorted(migrations_dir.glob("*.sql")):
            if f.name in executed:
                continue
            sql = f.read_text()
            lines = [
                line
                for line in sql.split("\n")
                if line.strip() and not line.strip().startswith("--")
            ]
            if not "\n".join(lines).strip():
                await conn.execute(
                    "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
                    f.name,
                )
                continue
            logger.info(f"Running migration {f.name}...")
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute("INSERT INTO schema_migrations (filename) VALUES ($1)", f.name)
            logger.info(f"Migration {f.name} completed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting vayada PMS...")
    logger.info(
        "Legacy provider webhook cutover modes: %s",
        settings.provider_webhook_cutover_status(),
    )
    await run_migrations()
    logger.info("Migrations complete")
    scheduler_status = get_scheduler_status()
    if scheduler_status["active_jobs"]:
        scheduler.start()
        logger.info(
            "Scheduler started with active_jobs=%s frozen_jobs=%s",
            scheduler_status["active_jobs"],
            [job["id"] for job in scheduler_status["frozen_jobs"]],
        )
    else:
        logger.warning(
            "Scheduler not started because all legacy PMS jobs are frozen: frozen_jobs=%s",
            [job["id"] for job in scheduler_status["frozen_jobs"]],
        )
    billing_scheduler.start()
    logger.info("Fixed-plan billing scheduler started")
    yield
    logger.info("Shutting down vayada PMS...")
    if scheduler.running:
        scheduler.shutdown()
    if billing_scheduler.running:
        billing_scheduler.shutdown()
    await Database.close_pool()
    await AuthDatabase.close_pool()
    await BookingEngineDatabase.close_pool()


app = FastAPI(
    title=settings.API_TITLE,
    description="vayada Property Management System — rooms & bookings",
    version=settings.API_VERSION,
    lifespan=lifespan,
    debug=settings.DEBUG,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Admin routers honor the X-Hotel-Id header for multi-hotel support.
# The capture_hotel_header dependency runs once per request and stores
# the header value in a contextvar that get_hotel_id() reads — this
# lets ~50 endpoints use `await get_hotel_id(user_id)` unchanged while
# still scoping to the header-selected hotel when present. Non-admin
# routers (rooms, bookings, upload, webhooks, etc.) don't need this.
_admin_deps = [Depends(capture_hotel_header)]

app.include_router(rooms_router)
app.include_router(bookings_router)
app.include_router(admin_router, dependencies=_admin_deps)
app.include_router(admin_room_types_router, dependencies=_admin_deps)
app.include_router(admin_rooms_router, dependencies=_admin_deps)
app.include_router(admin_room_blocks_router, dependencies=_admin_deps)
app.include_router(admin_bookings_router, dependencies=_admin_deps)
app.include_router(admin_checkout_router, dependencies=_admin_deps)
app.include_router(admin_checkin_checklist_router, dependencies=_admin_deps)
app.include_router(admin_payments_router, dependencies=_admin_deps)
app.include_router(admin_financials_router, dependencies=_admin_deps)
app.include_router(admin_affiliates_router, dependencies=_admin_deps)
app.include_router(admin_channex_router, dependencies=_admin_deps)
app.include_router(admin_messaging_router, dependencies=_admin_deps)
app.include_router(admin_module_activations_router, dependencies=_admin_deps)
app.include_router(affiliates_router)
app.include_router(webhooks_router)
app.include_router(affiliate_dashboard_router)
app.include_router(super_admin_payouts_router)
app.include_router(super_admin_bookings_router)
app.include_router(platform_admin_router)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "pms",
        "scheduler": get_scheduler_health_status(),
        "cutover": {
            "legacyProviderWebhooks": settings.provider_webhook_cutover_status(),
        },
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.API_HOST,
        port=settings.API_PORT,
        reload=settings.DEBUG,
    )
