"""Regression coverage for the canonical legacy PMS image upload route."""

import io

from app import s3_service
from PIL import Image

from tests.conftest import create_test_hotel, create_test_user, get_auth_headers


def make_test_image(width: int = 800, height: int = 600, fmt: str = "JPEG") -> bytes:
    image = Image.new("RGB", (width, height), color=(255, 0, 0))
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def make_test_png(width: int = 800, height: int = 600) -> bytes:
    image = Image.new("RGBA", (width, height), color=(0, 255, 0, 128))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


class TestLegacyRoomImageUpload:
    async def test_upload_route_accepts_authenticated_hotel_image(
        self,
        client,
        cleanup_database,
        mock_s3_operations,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", make_test_image(), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 201
        body = response.json()
        assert body["total"] == 1
        uploaded = body["images"][0]
        assert uploaded["url"].startswith("https://test-bucket.s3.amazonaws.com/")
        assert uploaded["thumbnail_url"].startswith("https://test-bucket.s3.amazonaws.com/")
        assert uploaded["key"].startswith(f"rooms/{user['id']}/")
        assert uploaded["width"] == 800
        assert uploaded["height"] == 600
        assert uploaded["size_bytes"] > 0
        assert uploaded["format"] == "JPEG"
        assert len(mock_s3_operations["uploaded"]) == 2

    async def test_upload_route_accepts_multiple_supported_formats(
        self,
        client,
        cleanup_database,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[
                ("files", ("room.jpg", make_test_image(), "image/jpeg")),
                ("files", ("room.png", make_test_png(), "image/png")),
                ("files", ("room.webp", make_test_image(fmt="WEBP"), "image/webp")),
            ],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 201
        assert response.json()["total"] == 3
        assert [image["format"] for image in response.json()["images"]] == [
            "JPEG",
            "PNG",
            "WEBP",
        ]

    async def test_upload_route_requires_authentication(self, client):
        response = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", make_test_image(), "image/jpeg"))],
        )

        assert response.status_code == 401

    async def test_upload_route_rejects_non_hotel_user(self, client, cleanup_database):
        user = await create_test_user(user_type="creator")

        response = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", make_test_image(), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 403

    async def test_upload_route_rejects_invalid_files(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("bad.txt", b"not an image", "text/plain"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "No valid images were uploaded"

    async def test_upload_route_rejects_truncated_images(self, client, cleanup_database):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("truncated.jpg", make_test_image()[:-2], "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "No valid images were uploaded"

    async def test_upload_route_resizes_phone_sized_images(
        self,
        client,
        cleanup_database,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("phone.jpg", make_test_image(4032, 3024), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 201
        uploaded = response.json()["images"][0]
        assert uploaded["width"] <= 1920
        assert uploaded["height"] <= 1920

    async def test_upload_route_rejects_more_than_ten_images(
        self,
        client,
        cleanup_database,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))
        image = make_test_image()

        response = await client.post(
            "/upload/images",
            files=[("files", (f"room-{index}.jpg", image, "image/jpeg")) for index in range(11)],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "A maximum of 10 images can be uploaded at once"

    async def test_upload_route_rejects_excessive_source_pixel_count(
        self,
        client,
        cleanup_database,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("huge.jpg", make_test_image(5000, 4000), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "No valid images were uploaded"

    async def test_upload_route_uses_detected_format_for_storage(
        self,
        client,
        cleanup_database,
        mock_s3_operations,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        response = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", make_test_png(), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 201
        original, thumbnail = mock_s3_operations["uploaded"]
        assert original["key"].endswith(".png")
        assert original["content_type"] == "image/png"
        assert thumbnail["key"].endswith("_thumb.jpeg")
        assert thumbnail["content_type"] == "image/jpeg"

    async def test_upload_route_reports_storage_failure_as_unavailable(
        self,
        client,
        cleanup_database,
        monkeypatch,
    ):
        user = await create_test_user()
        await create_test_hotel(str(user["id"]))

        async def fail_upload(*args, **kwargs):
            raise RuntimeError("S3 unavailable")

        monkeypatch.setattr(s3_service, "upload_file_to_s3", fail_upload)
        response = await client.post(
            "/upload/images",
            files=[("files", ("room.jpg", make_test_image(), "image/jpeg"))],
            headers=get_auth_headers(user["token"]),
        )

        assert response.status_code == 503
        assert response.json()["detail"] == "Image upload service is temporarily unavailable"
