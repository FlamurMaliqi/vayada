from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # API
    API_HOST: str = "0.0.0.0"
    API_PORT: int = 8002
    API_TITLE: str = "vayada PMS API"
    API_VERSION: str = "1.0.0"

    # Database (PMS own DB)
    DATABASE_URL: str = Field(..., description="PMS PostgreSQL connection string")
    AUTH_DATABASE_URL: str = Field(..., description="Auth PostgreSQL connection string")
    BOOKING_ENGINE_DATABASE_URL: str = Field(
        "", description="Booking engine PostgreSQL connection string"
    )
    DATABASE_POOL_MIN_SIZE: int = 2
    DATABASE_POOL_MAX_SIZE: int = 10
    DATABASE_COMMAND_TIMEOUT: int = 60

    # JWT (must match booking engine)
    JWT_SECRET_KEY: str = Field(..., description="JWT secret key (must match booking engine)")
    JWT_ALGORITHM: str = "HS256"

    # CORS
    CORS_ORIGINS: str = Field(..., description="Comma-separated allowed origins")
    # Preserves the prod *.vayada.com pattern and additionally permits
    # portless local-dev origins (https://*.localhost). Prod env may
    # override to a narrower regex.
    CORS_ORIGIN_REGEX: str = r"https://.*\.vayada\.com|https://([^.]+\.)*localhost(:\d+)?"
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: str = "*"
    CORS_ALLOW_HEADERS: str = "*"

    # SMTP (optional)
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "noreply@vayada.com"
    SMTP_USE_TLS: bool = True
    VAYADA_OPS_EMAIL: str = "bookings@vayada.com"
    # Internal recipient for "new affiliate application" alerts so the Vayada
    # team catches every Refer-a-Guest signup (independent of the hotel admin).
    VAYADA_AFFILIATE_NOTIFICATION_EMAIL: str = "p.paetzold@vayada.com"

    # S3 / Image Upload
    AWS_REGION: str = "eu-west-1"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    S3_BUCKET_NAME: str = ""
    S3_ENDPOINT_URL: str = ""
    S3_PUBLIC_URL: str = ""
    S3_PUBLIC_URL_EXPIRY: int = 3600
    S3_USE_PUBLIC_URLS: bool = True

    # Image Processing
    MAX_IMAGE_SIZE_MB: int = 50
    ALLOWED_IMAGE_TYPES: list = [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/jpg",
        "image/gif",
        "image/avif",
    ]
    MAX_IMAGE_WIDTH: int = 4000
    MAX_IMAGE_HEIGHT: int = 4000
    IMAGE_RESIZE_WIDTH: int = 1920
    IMAGE_RESIZE_HEIGHT: int = 1920
    GENERATE_THUMBNAILS: bool = True
    THUMBNAIL_SIZE: int = 300

    # Booking Engine
    BOOKING_ENGINE_API_URL: str = Field(
        "http://localhost:8001", description="Booking engine backend URL for addon lookups"
    )

    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PLATFORM_ACCOUNT_ID: str = ""

    # Xendit
    XENDIT_SECRET_KEY: str = ""
    XENDIT_WEBHOOK_SECRET: str = ""

    # Booking engine frontend URL (for Xendit redirect URLs)
    BOOKING_ENGINE_URL: str = "https://booking.vayada.com"
    BOOKING_ADMIN_URL: str = "https://admin.booking.vayada.com"

    # Channex
    CHANNEX_API_BASE_URL: str = "https://staging.channex.io"
    CHANNEX_API_KEY: str = ""
    CHANNEX_POLL_INTERVAL_MINUTES: int = 5
    CHANNEX_FULL_SYNC_HOUR: int = 4
    CHANNEX_API_DELAY_SECONDS: float = 0.5
    # Shared secret sent by Channex on each webhook (registered as a custom
    # header — Channex does not natively sign webhooks). Compared against
    # X-Vayada-Webhook-Token on incoming requests.
    CHANNEX_WEBHOOK_SECRET: str = ""

    # Listing Import (Claude AI + Firecrawl)
    ANTHROPIC_API_KEY: str = ""
    FIRECRAWL_API_KEY: str = ""
    LISTING_IMPORT_MODEL: str = "claude-sonnet-4-20250514"
    LISTING_IMPORT_MAX_CHARS: int = 180000

    # Environment
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    model_config = ConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    @property
    def cors_origins_list(self) -> list[str]:
        origins = [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]
        seen = set()
        unique = []
        for o in origins:
            if o not in seen:
                seen.add(o)
                unique.append(o)
        return unique


settings = Settings()
