"""
Image validation and processing utilities
"""

import io
import logging

from PIL import Image

from app.config import settings

logger = logging.getLogger(__name__)


def validate_image(
    file_content: bytes,
    filename: str,
    content_type: str | None = None,
    check_dimensions: bool = True,
) -> tuple[bool, str | None]:
    max_size_bytes = settings.MAX_IMAGE_SIZE_MB * 1024 * 1024
    if len(file_content) > max_size_bytes:
        return False, f"Image size exceeds maximum allowed size of {settings.MAX_IMAGE_SIZE_MB}MB"

    try:
        image = Image.open(io.BytesIO(file_content))
        image_format = image.format

        valid_formats = {"JPEG", "PNG", "WEBP", "GIF", "AVIF"}
        if image_format not in valid_formats:
            return False, "Invalid image format. Allowed formats: JPEG, PNG, WEBP, GIF, AVIF"

        width, height = image.size
        if check_dimensions and (
            width > settings.MAX_IMAGE_WIDTH or height > settings.MAX_IMAGE_HEIGHT
        ):
            return (
                False,
                f"Image dimensions exceed maximum allowed size ({settings.MAX_IMAGE_WIDTH}x{settings.MAX_IMAGE_HEIGHT})",
            )

        if content_type:
            valid_content_types = settings.ALLOWED_IMAGE_TYPES
            if content_type not in valid_content_types:
                return (
                    False,
                    f"Invalid content type. Allowed types: {', '.join(valid_content_types)}",
                )

        return True, None

    except Exception as e:
        logger.error(f"Error validating image: {e}")
        return False, f"Invalid image file: {str(e)}"


def process_image(
    file_content: bytes,
    resize_width: int | None = None,
    resize_height: int | None = None,
    quality: int = 85,
    format: str = "JPEG",
) -> bytes:
    try:
        image = Image.open(io.BytesIO(file_content))

        if format == "JPEG" and image.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(image, mask=image.split()[-1] if image.mode == "RGBA" else None)
            image = background
        elif image.mode != "RGB" and format == "JPEG":
            image = image.convert("RGB")

        if resize_width or resize_height:
            original_width, original_height = image.size

            if resize_width and resize_height:
                ratio = min(resize_width / original_width, resize_height / original_height)
                new_width = int(original_width * ratio)
                new_height = int(original_height * ratio)
            elif resize_width:
                ratio = resize_width / original_width
                new_height = int(original_height * ratio)
                new_width = resize_width
            else:
                ratio = resize_height / original_height
                new_width = int(original_width * ratio)
                new_height = resize_height

            if new_width < original_width or new_height < original_height:
                image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)

        output = io.BytesIO()
        save_kwargs = {"format": format}

        if format == "JPEG":
            save_kwargs["quality"] = quality
            save_kwargs["optimize"] = True
        elif format == "PNG":
            save_kwargs["optimize"] = True

        image.save(output, **save_kwargs)
        output.seek(0)

        return output.read()

    except Exception as e:
        logger.error(f"Error processing image: {e}")
        raise Exception(f"Failed to process image: {str(e)}") from e


def generate_thumbnail(file_content: bytes, size: int = 300, quality: int = 85) -> bytes:
    try:
        image = Image.open(io.BytesIO(file_content))

        if image.mode in ("RGBA", "LA", "P"):
            background = Image.new("RGB", image.size, (255, 255, 255))
            if image.mode == "P":
                image = image.convert("RGBA")
            background.paste(image, mask=image.split()[-1] if image.mode == "RGBA" else None)
            image = background
        elif image.mode != "RGB":
            image = image.convert("RGB")

        width, height = image.size
        if width > height:
            left = (width - height) // 2
            right = left + height
            top = 0
            bottom = height
        else:
            top = (height - width) // 2
            bottom = top + width
            left = 0
            right = width

        image = image.crop((left, top, right, bottom))
        image = image.resize((size, size), Image.Resampling.LANCZOS)

        output = io.BytesIO()
        image.save(output, format="JPEG", quality=quality, optimize=True)
        output.seek(0)

        return output.read()

    except Exception as e:
        logger.error(f"Error generating thumbnail: {e}")
        raise Exception(f"Failed to generate thumbnail: {str(e)}") from e


def get_image_info(file_content: bytes) -> dict:
    try:
        image = Image.open(io.BytesIO(file_content))
        return {
            "width": image.size[0],
            "height": image.size[1],
            "format": image.format,
            "mode": image.mode,
            "size_bytes": len(file_content),
        }
    except Exception as e:
        logger.error(f"Error getting image info: {e}")
        return {}
