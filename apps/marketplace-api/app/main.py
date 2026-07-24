"""
Main FastAPI application
"""

import logging
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import AuthDatabase, Database, PmsDatabase, check_database_connection
from app.routers import (
    admin,
    auth,
    chat,
    collaborations,
    consent,
    contact,
    creators,
    gdpr,
    hotels,
    invite_codes,
    marketplace,
    notifications,
    trips,
    upload,
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan events for startup and shutdown"""
    # Startup
    await Database.get_pool()
    await AuthDatabase.get_pool()
    if settings.PMS_DATABASE_URL:
        await PmsDatabase.get_pool()

    yield

    # Shutdown
    await PmsDatabase.close_pool()
    await AuthDatabase.close_pool()
    await Database.close_pool()


app = FastAPI(
    title=settings.API_TITLE,
    description="vayada Creator Marketplace Backend API",
    version=settings.API_VERSION,
    lifespan=lifespan,
    debug=settings.DEBUG,
)

# Configure CORS from environment variables
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=settings.cors_methods_list,
    allow_headers=settings.cors_headers_list,
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all so DB error text and stack traces never leak to clients."""
    logger.error(
        f"Unhandled exception on {request.method} {request.url.path}: "
        f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )


@app.get("/")
async def root():
    """Root endpoint"""
    return {"message": "Welcome to vayada API"}


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy", "service": "vayada-api"}


@app.get("/health/db")
async def health_db():
    """Database health check endpoint"""
    db_status = await check_database_connection()
    return {
        "status": "healthy" if db_status.get("connected") else "unhealthy",
        "database": db_status,
    }


# Include routers
app.include_router(auth.router)
app.include_router(creators.router)
app.include_router(hotels.router)
app.include_router(upload.router)
app.include_router(admin.router)
app.include_router(marketplace.router)
app.include_router(collaborations.router)
app.include_router(chat.router)
app.include_router(contact.router)
app.include_router(consent.router)
app.include_router(gdpr.router)
app.include_router(trips.router)
app.include_router(invite_codes.router)
app.include_router(notifications.router)
