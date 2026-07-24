"""
Authentication routes
"""

import logging

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth import (
    create_email_verification_code,
    create_password_reset_token,
    hash_password,
    mark_email_as_verified,
    mark_email_verification_token_as_used,
    mark_password_reset_token_as_used,
    validate_email_verification_token,
    validate_password_reset_token,
    verify_email_code,
)
from app.config import settings
from app.dependencies import get_current_user_id
from app.email_service import (
    create_email_verification_html,
    create_password_reset_email_html,
    send_email,
)
from app.jwt_utils import (
    create_access_token,
    create_totp_session_token,
    decode_access_token,
    decode_totp_session_token,
    get_token_expiration_seconds,
    is_token_expired,
)
from app.models.auth import (
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginHistoryResponse,
    LoginRequest,
    LoginResponse,
    RegisterRequest,
    RegisterResponse,
    ResetPasswordRequest,
    ResetPasswordResponse,
    SendVerificationCodeRequest,
    SendVerificationCodeResponse,
    TokenValidationResponse,
    TotpConfirmRequest,
    TotpConfirmResponse,
    TotpRecoveryCodeCountResponse,
    TotpRegenerateRequest,
    TotpRegenerateResponse,
    TotpSetupResponse,
    TotpStatusResponse,
    TotpVerifyRequest,
    VerifyEmailCodeRequest,
    VerifyEmailCodeResponse,
    VerifyEmailResponse,
)
from app.repositories.consent_repo import ConsentRepository
from app.repositories.creator_repo import CreatorRepository
from app.repositories.hotel_repo import HotelRepository
from app.repositories.login_audit_repo import LoginAuditRepository, RateLimitRepository
from app.repositories.password_reset_repo import PasswordResetRepository
from app.repositories.totp_repo import TotpRepository
from app.repositories.user_repo import UserRepository
from app.totp_utils import (
    decrypt_secret,
    encrypt_secret,
    generate_recovery_codes,
    generate_totp_secret,
    get_totp_uri,
    hash_recovery_code,
    verify_recovery_code,
    verify_totp_code,
)

logger = logging.getLogger(__name__)

LOCAL_AUTH_RETIRED_DETAIL = (
    "Local password authentication is retired for this migrated WorkOS account. "
    "Sign in with WorkOS AuthKit."
)


async def is_workos_migrated_platform_user(user: dict | None) -> bool:
    if not settings.LOCAL_AUTH_RETIREMENT_ENABLED:
        return False
    if not user:
        return False
    is_platform_user = bool(user.get("is_superadmin")) or user.get("type") == "admin"
    if not is_platform_user:
        return False
    return await UserRepository.has_workos_identity(str(user["id"]))


async def reject_retired_local_auth(user: dict | None) -> None:
    if await is_workos_migrated_platform_user(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=LOCAL_AUTH_RETIRED_DETAIL)


router = APIRouter(prefix="/auth", tags=["authentication"])


@router.post(
    "/send-verification-code",
    response_model=SendVerificationCodeResponse,
    status_code=status.HTTP_200_OK,
)
async def send_verification_code(request: SendVerificationCodeRequest):
    """
    Send a 6-digit verification code to the user's email address.
    This is used during registration to verify the email address.

    The code expires in 15 minutes and can only be used once.
    """
    try:
        # Check if email is already registered
        if await UserRepository.exists_by_email(request.email):
            # Don't reveal if email exists for security
            return SendVerificationCodeResponse(
                message="If this email is not registered, a verification code has been sent.",
                code=None,
            )

        # Generate and store verification code
        code = await create_email_verification_code(request.email, expires_in_minutes=15)

        # Create email content
        html_body = create_email_verification_html(code, None)

        # Send email
        email_sent = await send_email(
            to_email=request.email, subject="Verify Your Email - vayada", html_body=html_body
        )

        if not email_sent and settings.DEBUG:
            # In debug mode, return code if email fails
            return SendVerificationCodeResponse(
                message="Verification code sent. (Email failed, code returned for debug)", code=code
            )
        elif not email_sent:
            # In production, return generic message
            return SendVerificationCodeResponse(
                message="If this email is not registered, a verification code has been sent.",
                code=None,
            )
        else:
            return SendVerificationCodeResponse(
                message="Verification code sent to your email.",
                code=code if settings.DEBUG else None,
            )

    except Exception as e:
        logger.error(f"Error sending verification code: {e}")
        # Return generic message for security
        return SendVerificationCodeResponse(
            message="If this email is not registered, a verification code has been sent.", code=None
        )


@router.post(
    "/verify-email-code", response_model=VerifyEmailCodeResponse, status_code=status.HTTP_200_OK
)
async def verify_email_code_endpoint(request: VerifyEmailCodeRequest):
    """
    Verify a 6-digit code sent to the user's email.
    This marks the email as verified for future registration.
    """
    try:
        # Verify the code
        is_valid = await verify_email_code(request.email, request.code)

        if is_valid:
            # Mark email as verified (if user exists, update their status)
            await mark_email_as_verified(request.email)

            logger.info(f"Email verification successful for: {request.email}")
            return VerifyEmailCodeResponse(message="Email verified successfully!", verified=True)
        else:
            logger.warning(
                f"Email verification failed for: {request.email} with code: {request.code}"
            )
            return VerifyEmailCodeResponse(
                message="Invalid or expired verification code. Please request a new code.",
                verified=False,
            )

    except Exception as e:
        logger.error(f"Error verifying email code for {request.email}: {e}", exc_info=True)
        return VerifyEmailCodeResponse(
            message="An error occurred while verifying the code. Please try again.", verified=False
        )


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(request: RegisterRequest):
    """
    Register a new user (creator or hotel)

    - **email**: User's email address (must be unique)
    - **password**: Password (minimum 8 characters)
    - **type**: User type - either "creator" or "hotel"
    - **name**: User's name
    - **terms_accepted**: Must be True (required for GDPR)
    - **privacy_accepted**: Must be True (required for GDPR)
    - **marketing_consent**: Optional marketing consent
    """
    try:
        # Validate GDPR consent requirements
        if not request.terms_accepted:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You must accept the Terms of Service to register",
            )

        if not request.privacy_accepted:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You must accept the Privacy Policy to register",
            )

        # Check if email already exists
        if await UserRepository.exists_by_email(request.email):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered"
            )

        # Hash password
        password_hash = bcrypt.hashpw(request.password.encode("utf-8"), bcrypt.gensalt()).decode(
            "utf-8"
        )

        # Use provided name or default to email prefix
        user_name = request.name
        if not user_name or user_name.strip() == "":
            # Extract name from email (part before @)
            user_name = request.email.split("@")[0].capitalize()

        # Default versions if not provided
        terms_version = request.terms_version or "2024-01-01"
        privacy_version = request.privacy_version or "2024-01-01"

        # Insert user into auth database with consent fields
        user = await UserRepository.create(
            email=request.email,
            password_hash=password_hash,
            name=user_name,
            user_type=request.type,
            terms_version=terms_version,
            privacy_version=privacy_version,
            marketing_consent=request.marketing_consent,
        )

        # Create profile in business DB + consent history in auth DB
        # Uses compensating action: if profile creation fails, delete user from auth DB
        try:
            # Automatically create corresponding profile based on user type
            if request.type == "creator":
                await CreatorRepository.create(user["id"])
            elif request.type == "hotel":
                await HotelRepository.create_profile(user["id"], user["name"])

            # Create consent history records for GDPR audit trail
            await ConsentRepository.record(user["id"], "terms", True, version=terms_version)
            await ConsentRepository.record(user["id"], "privacy", True, version=privacy_version)

            if request.marketing_consent:
                await ConsentRepository.record(user["id"], "marketing", True)
        except Exception:
            # Compensating action: clean up user from auth DB if profile creation failed
            await UserRepository.delete(user["id"])
            raise

        # Create JWT token
        access_token = create_access_token(
            data={"sub": str(user["id"]), "email": user["email"], "type": user["type"]}
        )

        return RegisterResponse(
            id=str(user["id"]),
            email=user["email"],
            name=user["name"],
            type=user["type"],
            status=user["status"],
            access_token=access_token,
            expires_in=get_token_expiration_seconds(),
            message="User registered successfully",
        )

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Registration failed"
        )


@router.post("/login", response_model=LoginResponse, status_code=status.HTTP_200_OK)
async def login(http_request: Request, request: LoginRequest):
    """Login with email and password. Admin accounts with 2FA enrolled receive a totp_session."""
    ip = http_request.client.host if http_request.client else None
    ua = http_request.headers.get("user-agent")

    try:
        user = await UserRepository.get_by_email(request.email)

        if not user:
            lockout = await RateLimitRepository.check_locked(request.email)
            if lockout:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "message": "Too many failed login attempts. Try again later.",
                        "locked_until": lockout["locked_until"].isoformat(),
                    },
                )
            await RateLimitRepository.record_failure(request.email)
            await LoginAuditRepository.log(
                email=request.email,
                success=False,
                failure_reason="user_not_found",
                ip_address=ip,
                user_agent=ua,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
            )

        if await is_workos_migrated_platform_user(user):
            await LoginAuditRepository.log(
                email=request.email,
                success=False,
                failure_reason="local_auth_retired",
                auth_method="password",
                user_id=str(user["id"]),
                ip_address=ip,
                user_agent=ua,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail=LOCAL_AUTH_RETIRED_DETAIL
            )

        lockout = await RateLimitRepository.check_locked(request.email)
        if lockout:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "message": "Too many failed login attempts. Try again later.",
                    "locked_until": lockout["locked_until"].isoformat(),
                },
            )

        password_valid = bcrypt.checkpw(
            request.password.encode("utf-8"), user["password_hash"].encode("utf-8")
        )
        if not password_valid:
            await RateLimitRepository.record_failure(request.email)
            await LoginAuditRepository.log(
                email=request.email,
                success=False,
                failure_reason="wrong_password",
                user_id=str(user["id"]),
                ip_address=ip,
                user_agent=ua,
            )
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password"
            )

        if user["status"] == "suspended":
            await LoginAuditRepository.log(
                email=request.email,
                success=False,
                failure_reason="suspended",
                user_id=str(user["id"]),
                ip_address=ip,
                user_agent=ua,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Account is suspended"
            )

        await RateLimitRepository.clear(request.email)

        is_superadmin = bool(user.get("is_superadmin"))
        if is_superadmin and await TotpRepository.is_enrolled(str(user["id"])):
            totp_session = create_totp_session_token(str(user["id"]), user["email"], user["type"])
            await LoginAuditRepository.log(
                email=request.email,
                success=False,
                failure_reason="totp_required",
                auth_method="password",
                user_id=str(user["id"]),
                ip_address=ip,
                user_agent=ua,
            )
            return LoginResponse(
                message="Two-factor authentication required.",
                requires_totp=True,
                totp_session=totp_session,
            )

        access_token = create_access_token(
            data={"sub": str(user["id"]), "email": user["email"], "type": user["type"]}
        )
        await LoginAuditRepository.log(
            email=request.email,
            success=True,
            auth_method="password",
            user_id=str(user["id"]),
            ip_address=ip,
            user_agent=ua,
        )
        return LoginResponse(
            id=str(user["id"]),
            email=user["email"],
            name=user["name"],
            type=user["type"],
            status=user["status"],
            access_token=access_token,
            expires_in=get_token_expiration_seconds(),
            is_superadmin=is_superadmin,
            message="Login successful",
        )

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Login failed"
        )


@router.post("/totp/verify", response_model=LoginResponse, status_code=status.HTTP_200_OK)
async def totp_verify(http_request: Request, request: TotpVerifyRequest):
    """Verify a TOTP code (or recovery code) after the password step. Issues a full JWT on success."""
    ip = http_request.client.host if http_request.client else None
    ua = http_request.headers.get("user-agent")

    payload = decode_totp_session_token(request.totp_session)
    if not payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session"
        )

    user_id = payload["sub"]
    email = payload["email"]
    user_type = payload["type"]

    lockout = await RateLimitRepository.check_locked(email)
    if lockout:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": "Too many failed attempts. Try again later.",
                "locked_until": lockout["locked_until"].isoformat(),
            },
        )

    user = await UserRepository.get_by_id(
        user_id, columns="id, email, name, type, status, is_superadmin"
    )
    if not user or user["status"] == "suspended":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")
    await reject_retired_local_auth(user)

    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row or not secret_row["enrolled"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="2FA not enrolled")

    code = request.code.strip()
    verified = False
    auth_method = "password+totp"

    if len(code) > 6:
        for rc in await TotpRepository.get_unused_recovery_codes(user_id):
            if verify_recovery_code(code, rc["code_hash"]):
                await TotpRepository.mark_recovery_code_used(str(rc["id"]))
                verified = True
                auth_method = "password+recovery_code"
                break
    else:
        secret = decrypt_secret(secret_row["secret_encrypted"])
        verified = verify_totp_code(secret, code)

    if not verified:
        await RateLimitRepository.record_failure(email)
        await LoginAuditRepository.log(
            email=email,
            success=False,
            failure_reason="wrong_totp",
            auth_method=auth_method,
            user_id=user_id,
            ip_address=ip,
            user_agent=ua,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid code")

    await RateLimitRepository.clear(email)
    access_token = create_access_token(data={"sub": user_id, "email": email, "type": user_type})
    await LoginAuditRepository.log(
        email=email,
        success=True,
        auth_method=auth_method,
        user_id=user_id,
        ip_address=ip,
        user_agent=ua,
    )
    return LoginResponse(
        id=user_id,
        email=user["email"],
        name=user["name"],
        type=user["type"],
        status=user["status"],
        access_token=access_token,
        expires_in=get_token_expiration_seconds(),
        is_superadmin=bool(user.get("is_superadmin")),
        message="Login successful",
    )


@router.post("/totp/setup", response_model=TotpSetupResponse, status_code=status.HTTP_200_OK)
async def totp_setup(user_id: str = Depends(get_current_user_id)):
    """Generate a new TOTP secret and return the otpauth URI for QR display. Does not enroll yet."""
    user = await UserRepository.get_by_id(user_id, columns="id, email, type, is_superadmin")
    if not user or not user.get("is_superadmin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Superadmin access required"
        )
    await reject_retired_local_auth(user)

    secret = generate_totp_secret()
    await TotpRepository.upsert_secret(user_id, encrypt_secret(secret))

    return TotpSetupResponse(
        otpauth_uri=get_totp_uri(secret, user["email"]),
        secret=secret,
        message="Scan the QR code with your authenticator app, then confirm with a code.",
    )


@router.post("/totp/confirm", response_model=TotpConfirmResponse, status_code=status.HTTP_200_OK)
async def totp_confirm(request: TotpConfirmRequest, user_id: str = Depends(get_current_user_id)):
    """Verify the first TOTP code to complete enrollment and receive recovery codes."""
    user = await UserRepository.get_by_id(user_id, columns="id, type, is_superadmin")
    await reject_retired_local_auth(user)

    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Run /totp/setup first")

    secret = decrypt_secret(secret_row["secret_encrypted"])
    if not verify_totp_code(secret, request.code.strip()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid code")

    await TotpRepository.mark_enrolled(user_id)
    await TotpRepository.delete_recovery_codes(user_id)

    codes = generate_recovery_codes()
    await TotpRepository.insert_recovery_codes(user_id, [hash_recovery_code(c) for c in codes])

    return TotpConfirmResponse(
        recovery_codes=codes,
        message="2FA enabled. Save these recovery codes — they will not be shown again.",
    )


@router.post(
    "/totp/recovery-codes/regenerate",
    response_model=TotpRegenerateResponse,
    status_code=status.HTTP_200_OK,
)
async def totp_regenerate_recovery_codes(
    request: TotpRegenerateRequest, user_id: str = Depends(get_current_user_id)
):
    """Regenerate recovery codes. Requires a valid TOTP code as confirmation."""
    user = await UserRepository.get_by_id(user_id, columns="id, type, is_superadmin")
    await reject_retired_local_auth(user)

    secret_row = await TotpRepository.get_secret(user_id)
    if not secret_row or not secret_row["enrolled"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="2FA not enrolled")

    secret = decrypt_secret(secret_row["secret_encrypted"])
    if not verify_totp_code(secret, request.code.strip()):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid TOTP code")

    await TotpRepository.delete_recovery_codes(user_id)
    codes = generate_recovery_codes()
    await TotpRepository.insert_recovery_codes(user_id, [hash_recovery_code(c) for c in codes])

    return TotpRegenerateResponse(
        recovery_codes=codes,
        message="Recovery codes regenerated. Save these — they will not be shown again.",
    )


@router.get(
    "/totp/recovery-codes/count",
    response_model=TotpRecoveryCodeCountResponse,
    status_code=status.HTTP_200_OK,
)
async def totp_recovery_code_count(user_id: str = Depends(get_current_user_id)):
    """Return the number of unused recovery codes remaining."""
    count = await TotpRepository.count_unused_recovery_codes(user_id)
    return TotpRecoveryCodeCountResponse(count=count)


@router.get("/totp/status", response_model=TotpStatusResponse, status_code=status.HTTP_200_OK)
async def totp_status(user_id: str = Depends(get_current_user_id)):
    """Return whether the current user has TOTP enrolled."""
    enrolled = await TotpRepository.is_enrolled(user_id)
    return TotpStatusResponse(enrolled=enrolled)


@router.get("/login-history", response_model=LoginHistoryResponse, status_code=status.HTTP_200_OK)
async def login_history(user_id: str = Depends(get_current_user_id)):
    """Return the 20 most recent login events for the current user."""
    entries = await LoginAuditRepository.get_recent(user_id)
    return LoginHistoryResponse(
        entries=[
            {
                **e,
                "id": str(e["id"]),
                "created_at": e["created_at"].isoformat(),
            }
            for e in entries
        ]
    )


@router.post(
    "/validate-token", response_model=TokenValidationResponse, status_code=status.HTTP_200_OK
)
async def validate_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
):
    """
    Validate if the current token is still valid

    This endpoint can be used by the frontend to check if the token is still valid
    before making API calls, or to refresh user information.

    Returns token validation status and user information.

    Note: This endpoint is optional - if no token is provided, returns valid=False
    """
    if not credentials:
        return TokenValidationResponse(
            valid=False, expired=False, user_id=None, email=None, type=None
        )

    token = credentials.credentials

    # Decode token first to check if it's valid
    payload = decode_access_token(token)
    if not payload:
        # Invalid token - check if it's expired or just malformed
        is_exp = is_token_expired(token)
        # If is_exp is None, token is invalid (not a valid JWT format)
        # If is_exp is True, token is expired
        # If is_exp is False, token is valid but signature is wrong
        return TokenValidationResponse(
            valid=False,
            expired=is_exp
            if is_exp is not None
            else False,  # False if invalid format, True if expired
            user_id=None,
            email=None,
            type=None,
        )

    # Check if token is expired (only if payload exists)
    is_exp = is_token_expired(token)
    if is_exp is True:
        return TokenValidationResponse(
            valid=False, expired=True, user_id=None, email=None, type=None
        )

    # Get user info
    user_id = payload.get("sub")
    if not user_id:
        return TokenValidationResponse(
            valid=False, expired=False, user_id=None, email=None, type=None
        )

    user = await UserRepository.get_by_id(user_id, columns="id, email, type")

    if not user:
        return TokenValidationResponse(
            valid=False, expired=False, user_id=None, email=None, type=None
        )

    return TokenValidationResponse(
        valid=True, expired=False, user_id=str(user["id"]), email=user["email"], type=user["type"]
    )


@router.post(
    "/forgot-password", response_model=ForgotPasswordResponse, status_code=status.HTTP_200_OK
)
async def forgot_password(request: ForgotPasswordRequest):
    """
    Request a password reset

    - **email**: User's email address

    This endpoint will:
    1. Check if the email exists
    2. Generate a secure reset token
    3. Store the token in the database (expires in 1 hour)
    4. Return a success message

    Note: In production, the reset token should be sent via email.
    For development/testing, the token is returned in the response.
    """
    try:
        # Find user by email
        user = await UserRepository.get_by_email(request.email)

        # Always return success message (security best practice - don't reveal if email exists)
        # But only create token if user exists and is not suspended
        if (
            user
            and user["status"] != "suspended"
            and not await is_workos_migrated_platform_user(user)
        ):
            # Create password reset token (expires in 1 hour)
            token = await create_password_reset_token(str(user["id"]), expires_in_hours=1)

            # Create reset link
            reset_link = f"{settings.FRONTEND_URL}/reset-password?token={token}"

            # Get user name for email personalization
            user_name = user.get("name") or user["email"].split("@")[0]

            # Create email content
            html_body = create_password_reset_email_html(reset_link, user_name)

            # Send email
            email_sent = await send_email(
                to_email=user["email"], subject="Reset Your vayada Password", html_body=html_body
            )

            # In development mode, return token for testing if email failed
            # In production, always return None for token
            return_token = None
            if settings.DEBUG and not email_sent:
                # If email sending failed in debug mode, return token for testing
                return_token = token
                logger.warning("Email sending failed in debug mode. Returning token in response.")

            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=return_token,
            )
        else:
            # Still return success (security best practice)
            return ForgotPasswordResponse(
                message="If an account with that email exists, a password reset link has been sent.",
                token=None,
            )

    except Exception:
        # Still return success message (security best practice)
        return ForgotPasswordResponse(
            message="If an account with that email exists, a password reset link has been sent.",
            token=None,
        )


@router.post(
    "/reset-password", response_model=ResetPasswordResponse, status_code=status.HTTP_200_OK
)
async def reset_password(request: ResetPasswordRequest):
    """
    Reset password using a reset token

    - **token**: Password reset token (from forgot-password endpoint)
    - **new_password**: New password (minimum 8 characters)

    This endpoint will:
    1. Validate the reset token
    2. Check if token is expired or already used
    3. Update the user's password
    4. Mark the token as used
    """
    try:
        # Validate the reset token
        token_data = await validate_password_reset_token(request.token)

        if not token_data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token"
            )

        user_id = token_data["user_id"]
        user = await UserRepository.get_by_id(
            user_id, columns="id, email, type, status, is_superadmin"
        )
        await reject_retired_local_auth(user)

        # Hash the new password
        password_hash = hash_password(request.new_password)

        # Update user's password
        await UserRepository.update_password(user_id, password_hash)

        # Mark token as used
        await mark_password_reset_token_as_used(request.token)

        # Invalidate all existing tokens for this user (security best practice)
        await PasswordResetRepository.invalidate_all_for_user(user_id)

        return ResetPasswordResponse(message="Password has been reset successfully")

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to reset password"
        )


@router.get("/verify-email", response_model=VerifyEmailResponse, status_code=status.HTTP_200_OK)
async def verify_email_endpoint(token: str = Query(..., description="Email verification token")):
    """
    Verify email address using a verification token from the profile completion email.

    This endpoint is called when a user clicks the verification link in their email.
    The token is provided as a query parameter.

    - **token**: Email verification token from the profile completion email

    Returns:
    - Success message if verification is successful
    - Error message if token is invalid, expired, or already used
    """
    try:
        # Validate the verification token
        token_data = await validate_email_verification_token(token)

        if not token_data:
            logger.warning("Invalid or expired email verification token attempted")
            return VerifyEmailResponse(
                message="Invalid or expired verification token. Please request a new verification link.",
                verified=False,
                email=None,
            )

        user_id = token_data["user_id"]
        email = token_data["email"]
        user = await UserRepository.get_by_id(
            user_id, columns="id, email, type, status, is_superadmin"
        )
        if await is_workos_migrated_platform_user(user):
            logger.info("Skipped legacy email verification for WorkOS-linked user %s", user_id)
            return VerifyEmailResponse(
                message="Email verification is managed by WorkOS AuthKit for this account.",
                verified=False,
                email=email,
            )

        # Mark email as verified
        email_verified = await mark_email_as_verified(email)

        if not email_verified:
            logger.error(f"Failed to mark email as verified for user {user_id}")
            return VerifyEmailResponse(
                message="Failed to verify email. Please try again or contact support.",
                verified=False,
                email=email,
            )

        # Mark token as used
        await mark_email_verification_token_as_used(token)

        logger.info(f"Email verified successfully for user {user_id} ({email})")
        return VerifyEmailResponse(
            message="Email verified successfully! Your account is now fully activated.",
            verified=True,
            email=email,
        )

    except Exception as e:
        logger.error(f"Error verifying email with token: {str(e)}", exc_info=True)
        return VerifyEmailResponse(
            message="An error occurred while verifying your email. Please try again or contact support.",
            verified=False,
            email=None,
        )
