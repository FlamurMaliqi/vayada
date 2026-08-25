"""Legacy room-image upload compatibility route.

The canonical Python-backed PMS frontend still posts multipart files to
``POST /upload/images``. Keep this route until that frozen frontend is retired;
the target PMS frontend uses platform-media upload sessions instead.
"""

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app import s3_service
from app.config import settings
from app.dependencies import require_hotel_admin
from app.image_processing import generate_thumbnail, get_image_info, process_image, validate_image
from app.models.upload import ImageUploadResponse, MultipleImageUploadResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])


@router.post(
    "/images",
    response_model=MultipleImageUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_room_images(
    files: list[UploadFile] = File(...),
    user_id: str = Depends(require_hotel_admin),
) -> MultipleImageUploadResponse:
    """Upload room images for the canonical legacy PMS frontend."""
    if not settings.S3_BUCKET_NAME:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="S3 storage is not configured",
        )

    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No files provided",
        )
    if len(files) > 10:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A maximum of 10 images can be uploaded at once",
        )

    uploaded: list[ImageUploadResponse] = []
    had_operational_failure = False
    max_size_bytes = settings.MAX_IMAGE_SIZE_MB * 1024 * 1024
    max_source_pixels = settings.MAX_IMAGE_WIDTH * settings.MAX_IMAGE_HEIGHT

    for file in files:
        try:
            file_content = await file.read(max_size_bytes + 1)
            if not file_content:
                continue

            resize_enabled = settings.IMAGE_RESIZE_WIDTH > 0 or settings.IMAGE_RESIZE_HEIGHT > 0
            is_valid, error_message = validate_image(
                file_content,
                file.filename or "image",
                file.content_type,
                check_dimensions=not resize_enabled,
            )
            if not is_valid:
                logger.warning("Skipping invalid image %s: %s", file.filename, error_message)
                continue

            image_info = get_image_info(file_content)
            if image_info.get("width", 0) * image_info.get("height", 0) > max_source_pixels:
                logger.warning("Skipping image with excessive pixel count: %s", file.filename)
                continue
            processed_content = file_content

            if resize_enabled:
                processed_content = process_image(
                    file_content,
                    resize_width=(
                        settings.IMAGE_RESIZE_WIDTH if settings.IMAGE_RESIZE_WIDTH > 0 else None
                    ),
                    resize_height=(
                        settings.IMAGE_RESIZE_HEIGHT if settings.IMAGE_RESIZE_HEIGHT > 0 else None
                    ),
                    format=image_info.get("format") or "JPEG",
                )
                image_info = get_image_info(processed_content)

            is_valid, error_message = validate_image(
                processed_content,
                file.filename or "image",
                check_dimensions=True,
            )
            if not is_valid:
                logger.warning(
                    "Skipping processed image %s: %s",
                    file.filename,
                    error_message,
                )
                continue

            detected_format = str(image_info.get("format") or "JPEG").lower()
            file_key = s3_service.generate_file_key(
                "rooms",
                f"image.{detected_format}",
                user_id,
            )
            content_type = f"image/{detected_format}"
            try:
                url = await s3_service.upload_file_to_s3(
                    processed_content,
                    file_key,
                    content_type=content_type,
                    make_public=settings.S3_USE_PUBLIC_URLS,
                )
            except Exception as exc:
                had_operational_failure = True
                logger.error("Error uploading file %s: %s", file.filename, exc)
                continue

            thumbnail_url = None
            if settings.GENERATE_THUMBNAILS:
                try:
                    thumbnail = generate_thumbnail(
                        file_content,
                        size=settings.THUMBNAIL_SIZE,
                    )
                    thumbnail_key = f"{file_key.rsplit('.', 1)[0]}_thumb.jpeg"
                    thumbnail_url = await s3_service.upload_file_to_s3(
                        thumbnail,
                        thumbnail_key,
                        content_type="image/jpeg",
                        make_public=settings.S3_USE_PUBLIC_URLS,
                    )
                except Exception as exc:
                    logger.warning("Thumbnail failed for %s: %s", file.filename, exc)

            uploaded.append(
                ImageUploadResponse(
                    url=url,
                    thumbnail_url=thumbnail_url,
                    key=file_key,
                    width=image_info.get("width", 0),
                    height=image_info.get("height", 0),
                    size_bytes=image_info.get("size_bytes", len(processed_content)),
                    format=image_info.get("format", "JPEG"),
                )
            )
        except Exception as exc:
            logger.warning("Skipping unprocessable image %s: %s", file.filename, exc)

    if not uploaded:
        if had_operational_failure:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Image upload service is temporarily unavailable",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid images were uploaded",
        )

    return MultipleImageUploadResponse(images=uploaded, total=len(uploaded))
