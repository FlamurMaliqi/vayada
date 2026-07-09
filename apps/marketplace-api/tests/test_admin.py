"""
Tests for admin management endpoints.
"""

import pytest
from app.database import AuthDatabase, Database
from app.jwt_utils import create_access_token
from httpx import AsyncClient

from tests.conftest import (
    create_test_admin,
    create_test_collaboration,
    create_test_creator,
    create_test_hotel,
    create_test_listing,
    create_test_platform,
    create_test_user,
    generate_test_email,
    get_auth_headers,
)


class TestGetUsers:
    """Tests for GET /admin/users"""

    async def test_get_users_success(self, client: AsyncClient, test_admin, test_creator):
        """Test getting users list."""
        response = await client.get("/admin/users", headers=get_auth_headers(test_admin["token"]))

        assert response.status_code == 200
        data = response.json()
        assert "users" in data
        assert "total" in data
        assert isinstance(data["users"], list)

    async def test_get_users_pagination(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test pagination of users list."""
        # Create multiple users
        for _ in range(5):
            await create_test_creator()

        response = await client.get(
            "/admin/users?page=1&page_size=3", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["users"]) <= 3
        assert data["total"] >= 5

    async def test_get_users_filter_by_type(
        self, client: AsyncClient, test_admin, test_creator, test_hotel
    ):
        """Test filtering users by type."""
        response = await client.get(
            "/admin/users?type=creator", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for user in data["users"]:
            assert user["type"] == "creator"

    async def test_get_users_filter_by_status(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test filtering users by status."""
        await create_test_creator(status="verified")
        await create_test_creator(status="pending")

        response = await client.get(
            "/admin/users?status=verified", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for user in data["users"]:
            assert user["status"] == "verified"

    async def test_get_users_search(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test searching users by name or email."""
        await create_test_creator(name="Unique Name Creator")

        response = await client.get(
            "/admin/users?search=Unique Name", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert any("Unique Name" in u["name"] for u in data["users"])

    async def test_get_users_not_admin(self, client: AsyncClient, test_creator):
        """Test that non-admin cannot access users list."""
        response = await client.get("/admin/users", headers=get_auth_headers(test_creator["token"]))

        assert response.status_code == 403

    async def test_get_users_no_auth(self, client: AsyncClient):
        """Test that unauthenticated request is rejected."""
        response = await client.get("/admin/users")

        assert response.status_code == 403

    async def test_get_users_avatar_falls_back_to_creator_profile_picture(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Creator with profile_picture but no users.avatar should surface the picture as avatar."""
        creator = await create_test_creator()
        picture_url = "https://example.com/creator.jpg"
        await Database.execute(
            "UPDATE creators SET profile_picture = $1 WHERE user_id = $2",
            picture_url,
            creator["user"]["id"],
        )

        response = await client.get(
            "/admin/users?type=creator", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        match = next((u for u in data["users"] if u["id"] == str(creator["user"]["id"])), None)
        assert match is not None
        assert match["avatar"] == picture_url

    async def test_get_users_avatar_falls_back_to_hotel_picture(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Hotel with hotel_profiles.picture but no users.avatar should surface the picture as avatar."""
        hotel = await create_test_hotel()
        picture_url = "https://example.com/hotel.jpg"
        await Database.execute(
            "UPDATE hotel_profiles SET picture = $1 WHERE user_id = $2",
            picture_url,
            hotel["user"]["id"],
        )

        response = await client.get(
            "/admin/users?type=hotel", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        match = next((u for u in data["users"] if u["id"] == str(hotel["user"]["id"])), None)
        assert match is not None
        assert match["avatar"] == picture_url

    async def test_get_users_avatar_override_takes_precedence(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """When users.avatar is set, it takes precedence over creator profile_picture."""
        creator = await create_test_creator()
        override_url = "https://example.com/admin-override.jpg"
        creator_picture_url = "https://example.com/creator.jpg"
        await AuthDatabase.execute(
            "UPDATE users SET avatar = $1 WHERE id = $2", override_url, creator["user"]["id"]
        )
        await Database.execute(
            "UPDATE creators SET profile_picture = $1 WHERE user_id = $2",
            creator_picture_url,
            creator["user"]["id"],
        )

        response = await client.get(
            "/admin/users?type=creator", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        match = next((u for u in data["users"] if u["id"] == str(creator["user"]["id"])), None)
        assert match is not None
        assert match["avatar"] == override_url


class TestGetUserDetails:
    """Tests for GET /admin/users/{user_id}"""

    async def test_get_creator_details(
        self, client: AsyncClient, test_admin, test_creator_verified
    ):
        """Test getting creator user details."""
        user_id = str(test_creator_verified["user"]["id"])

        response = await client.get(
            f"/admin/users/{user_id}", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == user_id
        assert data["type"] == "creator"
        assert "profile" in data
        assert data["profile"]["platforms"] is not None

    async def test_get_hotel_details(self, client: AsyncClient, test_admin, test_hotel_verified):
        """Test getting hotel user details with listings."""
        user_id = str(test_hotel_verified["user"]["id"])

        response = await client.get(
            f"/admin/users/{user_id}", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == user_id
        assert data["type"] == "hotel"
        assert "profile" in data
        assert "listings" in data["profile"]

    async def test_get_user_not_found(self, client: AsyncClient, test_admin):
        """Test getting non-existent user."""
        response = await client.get(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 404


class TestCreateUser:
    """Tests for POST /admin/users"""

    async def test_create_creator(self, client: AsyncClient, test_admin):
        """Test creating a creator user."""
        email = generate_test_email("admin_created")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Admin Created Creator",
                "type": "creator",
                "status": "verified",
                "emailVerified": True,
                "creatorProfile": {
                    "location": "New York, USA",
                    "shortDescription": "Professional content creator",
                },
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["email"] == email
        assert data["type"] == "creator"
        assert data["status"] == "verified"

    async def test_create_hotel_with_listings(self, client: AsyncClient, test_admin):
        """Test creating a hotel user with listings."""
        email = generate_test_email("admin_hotel")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Admin Created Hotel",
                "type": "hotel",
                "status": "verified",
                "hotelProfile": {
                    "name": "Luxury Hotel",
                    "location": "Paris, France",
                    "about": "A beautiful hotel with amazing amenities",
                    "listings": [
                        {
                            "name": "Deluxe Suite",
                            "location": "Paris",
                            "description": "Luxury suite with stunning views of the Eiffel Tower",
                            "accommodationType": "Luxury Hotel",
                            "collaborationOfferings": [
                                {
                                    "collaborationType": "Free Stay",
                                    "availabilityMonths": ["January", "February"],
                                    "platforms": ["Instagram"],
                                    "freeStayMinNights": 3,
                                    "freeStayMaxNights": 5,
                                }
                            ],
                            "creatorRequirements": {"platforms": ["Instagram"]},
                        }
                    ],
                },
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["type"] == "hotel"

    async def test_create_user_duplicate_email(self, client: AsyncClient, test_admin, test_creator):
        """Test creating user with duplicate email."""
        response = await client.post(
            "/admin/users",
            json={
                "email": test_creator["user"]["email"],
                "password": "SecurePassword123!",
                "name": "Duplicate User",
                "type": "creator",
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 400
        assert "already registered" in response.json()["detail"].lower()

    async def test_create_user_with_platforms(self, client: AsyncClient, test_admin):
        """Test creating creator with platforms."""
        email = generate_test_email("with_platforms")

        response = await client.post(
            "/admin/users",
            json={
                "email": email,
                "password": "SecurePassword123!",
                "name": "Creator With Platforms",
                "type": "creator",
                "creatorProfile": {
                    "location": "London",
                    "platforms": [
                        {
                            "name": "Instagram",
                            "handle": "@admintest",
                            "followers": 100000,
                            "engagementRate": 4.5,
                        }
                    ],
                },
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 201


class TestUpdateUser:
    """Tests for PUT /admin/users/{user_id}"""

    async def test_update_user_status(self, client: AsyncClient, test_admin, test_creator):
        """Test updating user status."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "verified"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        user = await AuthDatabase.fetchrow("SELECT status FROM users WHERE id = $1", user_id)
        assert user["status"] == "verified"

    async def test_update_user_email(self, client: AsyncClient, test_admin, test_creator):
        """Test updating user email."""
        user_id = str(test_creator["user"]["id"])
        new_email = generate_test_email("updated")

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"email": new_email},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        user = await AuthDatabase.fetchrow("SELECT email FROM users WHERE id = $1", user_id)
        assert user["email"] == new_email

    async def test_update_user_not_found(self, client: AsyncClient, test_admin):
        """Test updating non-existent user."""
        response = await client.put(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 404

    async def test_admin_cannot_modify_own_status(self, client: AsyncClient, test_admin):
        """Test that admin cannot modify their own status."""
        admin_id = str(test_admin["user"]["id"])

        response = await client.put(
            f"/admin/users/{admin_id}",
            json={"status": "suspended"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 400


class TestCreatorApprovalNotification:
    """Creator approval notification side effects for legacy admin status writes."""

    @staticmethod
    async def _wait_for_emails(mock_send_email, expected_count: int, timeout: float = 1.0):
        """send_email_background fires a task; yield briefly so it runs."""
        import asyncio

        deadline = asyncio.get_event_loop().time() + timeout
        while len(mock_send_email) < expected_count and asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(0.02)

    async def test_pending_to_verified_creates_notification_and_email(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_send_email
    ):
        """Pending creator approval creates one notification and one email."""
        creator = await create_test_creator(status="pending")
        user_id = str(creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "verified"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200
        await self._wait_for_emails(mock_send_email, 1)

        notifs = await Database.fetch(
            "SELECT type, title, body, link_url FROM notifications WHERE user_id = $1",
            creator["user"]["id"],
        )
        assert len(notifs) == 1
        assert notifs[0]["type"] == "creator_approved"
        approval_emails = [e for e in mock_send_email if e["to"] == creator["user"]["email"]]
        assert len(approval_emails) == 1

    async def test_already_verified_no_duplicate(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_send_email
    ):
        """Already verified creators do not get duplicate approval notifications."""
        creator = await create_test_creator(status="verified")
        user_id = str(creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "verified"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200

        # Give any spurious background email a chance to land
        import asyncio

        await asyncio.sleep(0.05)

        notifs = await Database.fetch(
            "SELECT id FROM notifications WHERE user_id = $1 AND type = 'creator_approved'",
            creator["user"]["id"],
        )
        assert len(notifs) == 0
        approval_emails = [e for e in mock_send_email if e["to"] == creator["user"]["email"]]
        assert approval_emails == []

    async def test_revoke_then_reapprove_notifies_again(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_send_email
    ):
        """Re-approving after revoke creates one new approval notification."""
        creator = await create_test_creator(status="verified")
        user_id = str(creator["user"]["id"])
        headers = get_auth_headers(test_admin["token"])

        revoke = await client.put(
            f"/admin/users/{user_id}", json={"status": "suspended"}, headers=headers
        )
        assert revoke.status_code == 200

        reapprove = await client.put(
            f"/admin/users/{user_id}", json={"status": "verified"}, headers=headers
        )
        assert reapprove.status_code == 200
        await self._wait_for_emails(mock_send_email, 1)

        notifs = await Database.fetch(
            "SELECT id FROM notifications WHERE user_id = $1 AND type = 'creator_approved'",
            creator["user"]["id"],
        )
        assert len(notifs) == 1
        approval_emails = [e for e in mock_send_email if e["to"] == creator["user"]["email"]]
        assert len(approval_emails) == 1

    async def test_hotel_status_change_does_not_create_creator_notification(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_send_email
    ):
        """Hotel status updates do not create creator approval notifications."""
        hotel = await create_test_hotel(status="pending")
        user_id = str(hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "verified"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200

        import asyncio

        await asyncio.sleep(0.05)

        notifs = await Database.fetch(
            "SELECT id FROM notifications WHERE user_id = $1 AND type = 'creator_approved'",
            hotel["user"]["id"],
        )
        assert len(notifs) == 0

    async def test_rejected_does_not_notify(
        self, client: AsyncClient, test_admin, cleanup_database, init_database, mock_send_email
    ):
        """Rejected creators do not get approval notifications."""
        creator = await create_test_creator(status="pending")
        user_id = str(creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}",
            json={"status": "rejected"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200

        import asyncio

        await asyncio.sleep(0.05)

        notifs = await Database.fetch(
            "SELECT id FROM notifications WHERE user_id = $1 AND type = 'creator_approved'",
            creator["user"]["id"],
        )
        assert len(notifs) == 0
        approval_emails = [e for e in mock_send_email if e["to"] == creator["user"]["email"]]
        assert approval_emails == []


class TestDeleteUser:
    """Tests for DELETE /admin/users/{user_id}"""

    async def test_delete_user_success(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Test deleting a user."""
        creator = await create_test_creator()
        user_id = str(creator["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200

        user = await AuthDatabase.fetchrow(
            "SELECT id FROM users WHERE id = $1", creator["user"]["id"]
        )
        assert user is None

    async def test_delete_user_cascade(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Legacy deletion cascades product profile data."""
        creator = await create_test_creator()
        await create_test_platform(creator_id=str(creator["creator"]["id"]))
        user_id = str(creator["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200

        creator_profile = await Database.fetchrow(
            "SELECT id FROM creators WHERE user_id = $1", creator["user"]["id"]
        )
        assert creator_profile is None

    async def test_delete_user_not_found(self, client: AsyncClient, test_admin):
        """Test deleting non-existent user."""
        response = await client.delete(
            "/admin/users/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 404

    async def test_admin_cannot_delete_self(self, client: AsyncClient, test_admin):
        """Test that admin cannot delete themselves."""
        admin_id = str(test_admin["user"]["id"])

        response = await client.delete(
            f"/admin/users/{admin_id}", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 400


class TestUpdateCreatorProfile:
    """Tests for PUT /admin/users/{user_id}/profile/creator"""

    async def test_update_creator_profile(self, client: AsyncClient, test_admin, test_creator):
        """Test updating creator product profile fields."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={
                "location": "San Francisco, USA",
                "shortDescription": "Updated description",
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == test_creator["user"]["name"]
        assert data["location"] == "San Francisco, USA"

    async def test_update_creator_with_platforms(
        self, client: AsyncClient, test_admin, test_creator
    ):
        """Test updating creator profile with platforms."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={
                "platforms": [
                    {
                        "name": "TikTok",
                        "handle": "@admin_updated",
                        "followers": 200000,
                        "engagementRate": 5.5,
                    }
                ]
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["platforms"]) == 1
        assert data["platforms"][0]["name"] == "TikTok"

    async def test_update_creator_wrong_type(self, client: AsyncClient, test_admin, test_hotel):
        """Test updating creator profile for hotel user."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/creator",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 400


class TestUpdateHotelProfile:
    """Tests for PUT /admin/users/{user_id}/profile/hotel"""

    async def test_update_hotel_profile(self, client: AsyncClient, test_admin, test_hotel):
        """Test updating hotel profile."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/hotel",
            json={
                "name": "Updated Hotel Name",
                "location": "Barcelona, Spain",
                "about": "Updated description",
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Updated Hotel Name"
        assert data["location"] == "Barcelona, Spain"

    async def test_update_hotel_wrong_type(self, client: AsyncClient, test_admin, test_creator):
        """Test updating hotel profile for creator user."""
        user_id = str(test_creator["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/profile/hotel",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 400


class TestAdminCreateListing:
    """Tests for POST /admin/users/{user_id}/listings"""

    async def test_create_listing(self, client: AsyncClient, test_admin, test_hotel):
        """Test admin creating listing for hotel."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.post(
            f"/admin/users/{user_id}/listings",
            json={
                "name": "Admin Created Listing",
                "location": "Dubai",
                "description": "Luxury listing with stunning desert views and amenities",
                "accommodationType": "Luxury Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["March", "April"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 4,
                        "freeStayMaxNights": 7,
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"]},
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "Admin Created Listing"

    async def test_create_listing_wrong_type(self, client: AsyncClient, test_admin, test_creator):
        """Test creating listing for non-hotel user."""
        user_id = str(test_creator["user"]["id"])

        response = await client.post(
            f"/admin/users/{user_id}/listings",
            json={
                "name": "Test Listing",
                "location": "Test Location",
                "description": "Test description for the listing creation",
                "accommodationType": "Hotel",
                "collaborationOfferings": [
                    {
                        "collaborationType": "Free Stay",
                        "availabilityMonths": ["May"],
                        "platforms": ["Instagram"],
                        "freeStayMinNights": 2,
                        "freeStayMaxNights": 5,
                    }
                ],
                "creatorRequirements": {"platforms": ["Instagram"]},
            },
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 400


class TestAdminUpdateListing:
    """Tests for PUT /admin/users/{user_id}/listings/{listing_id}"""

    async def test_update_listing(self, client: AsyncClient, test_admin, test_hotel_verified):
        """Test admin updating listing."""
        user_id = str(test_hotel_verified["user"]["id"])
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/listings/{listing_id}",
            json={"name": "Admin Updated Listing", "description": "Updated by admin"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Admin Updated Listing"

    async def test_update_listing_not_found(self, client: AsyncClient, test_admin, test_hotel):
        """Test updating non-existent listing."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.put(
            f"/admin/users/{user_id}/listings/00000000-0000-0000-0000-000000000000",
            json={"name": "Test"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 404


class TestAdminDeleteListing:
    """Tests for DELETE /admin/users/{user_id}/listings/{listing_id}"""

    async def test_delete_listing(self, client: AsyncClient, test_admin, test_hotel_verified):
        """Test admin deleting listing."""
        user_id = str(test_hotel_verified["user"]["id"])
        listing_id = str(test_hotel_verified["listing"]["listing"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}/listings/{listing_id}",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_listing"]["id"] == listing_id

    async def test_delete_listing_not_found(self, client: AsyncClient, test_admin, test_hotel):
        """Test deleting non-existent listing."""
        user_id = str(test_hotel["user"]["id"])

        response = await client.delete(
            f"/admin/users/{user_id}/listings/00000000-0000-0000-0000-000000000000",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 404


class TestAdminGetCollaborations:
    """Tests for GET /admin/collaborations"""

    async def test_get_collaborations(self, client: AsyncClient, test_admin, test_collaboration):
        """Test getting all collaborations."""
        response = await client.get(
            "/admin/collaborations", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        assert "collaborations" in data
        assert "total" in data

    async def test_get_collaborations_pagination(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test collaborations pagination."""
        response = await client.get(
            "/admin/collaborations?page=1&page_size=10",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["collaborations"]) <= 10

    async def test_get_collaborations_filter_by_status(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test filtering collaborations by status."""
        response = await client.get(
            "/admin/collaborations?status=pending", headers=get_auth_headers(test_admin["token"])
        )

        assert response.status_code == 200
        data = response.json()
        for collab in data["collaborations"]:
            assert collab["status"] == "pending"

    async def test_get_collaborations_search(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Test searching collaborations."""
        creator_name = test_collaboration["creator"]["user"]["name"]

        response = await client.get(
            f"/admin/collaborations?search={creator_name}",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["collaborations"]) >= 1


class TestAdminRespondToCollaboration:
    """Tests for POST /admin/collaborations/{id}/respond"""

    async def test_admin_accepts_pending_collaboration(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Admin accepting a pending creator-initiated collab moves it to negotiating."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "accepted", "response_message": "Approved by admin"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "negotiating"
        assert data["hotel_agreed_at"] is not None

    async def test_admin_declines_pending_collaboration(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Admin can decline a pending collab on behalf of the hotel."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "declined"},
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        assert response.json()["status"] == "declined"

    async def test_admin_cannot_respond_to_non_pending(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Admin cannot respond once the collaboration has moved past pending."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # First admin-accept moves it to negotiating
        await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_admin["token"]),
        )

        response = await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "declined"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 400

    async def test_admin_respond_not_found(self, client: AsyncClient, test_admin):
        response = await client.post(
            "/admin/collaborations/00000000-0000-0000-0000-000000000000/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 404

    async def test_non_admin_cannot_respond(
        self, client: AsyncClient, test_creator, test_collaboration
    ):
        collab_id = str(test_collaboration["collaboration"]["id"])
        response = await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_creator["token"]),
        )
        assert response.status_code == 403


class TestAdminApproveCollaboration:
    """Tests for POST /admin/collaborations/{id}/approve"""

    async def test_admin_approve_marks_hotel_agreed(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """Approving with no creator agreement yet just marks hotel_agreed_at."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        response = await client.post(
            f"/admin/collaborations/{collab_id}/approve",
            headers=get_auth_headers(test_admin["token"]),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["hotel_agreed_at"] is not None
        # No creator agreement yet -> not yet finalized
        assert data["status"] != "accepted"

    async def test_admin_approve_finalizes_when_creator_already_agreed(
        self, client: AsyncClient, test_admin, test_collaboration
    ):
        """If creator has already approved, admin approval flips status to accepted."""
        collab_id = str(test_collaboration["collaboration"]["id"])

        # Admin accepts (moves to negotiating, sets hotel_agreed_at)
        await client.post(
            f"/admin/collaborations/{collab_id}/respond",
            json={"status": "accepted"},
            headers=get_auth_headers(test_admin["token"]),
        )
        # Creator approves
        await client.post(
            f"/collaborations/{collab_id}/approve",
            headers=get_auth_headers(test_collaboration["creator"]["token"]),
        )

        # Confirm finalized
        collab = await Database.fetchrow(
            "SELECT status FROM collaborations WHERE id = $1",
            test_collaboration["collaboration"]["id"],
        )
        assert collab["status"] == "accepted"

    async def test_admin_approve_not_found(self, client: AsyncClient, test_admin):
        response = await client.post(
            "/admin/collaborations/00000000-0000-0000-0000-000000000000/approve",
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 404


class TestAdminAuthorization:
    """Tests for admin authorization"""

    async def test_creator_cannot_access_admin(self, client: AsyncClient, test_creator):
        """Test that creator cannot access admin endpoints."""
        response = await client.get("/admin/users", headers=get_auth_headers(test_creator["token"]))

        assert response.status_code == 403

    async def test_hotel_cannot_access_admin(self, client: AsyncClient, test_hotel):
        """Test that hotel cannot access admin endpoints."""
        response = await client.get("/admin/users", headers=get_auth_headers(test_hotel["token"]))

        assert response.status_code == 403

    async def test_suspended_admin_cannot_access(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Test that suspended superadmin cannot access endpoints."""
        admin_user = await create_test_user(user_type="creator", status="suspended")
        await AuthDatabase.execute(
            "UPDATE users SET is_superadmin = true WHERE id = $1", admin_user["id"]
        )
        token = create_access_token(
            {"sub": str(admin_user["id"]), "email": admin_user["email"], "type": admin_user["type"]}
        )

        response = await client.get("/admin/users", headers=get_auth_headers(token))

        assert response.status_code == 403

    async def test_superadmin_user_can_access_admin_endpoints(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """Non-admin type user with is_superadmin=True can access admin endpoints."""
        user = await create_test_user(user_type="creator")
        await AuthDatabase.execute(
            "UPDATE users SET is_superadmin = true WHERE id = $1", user["id"]
        )
        token = create_access_token(
            {"sub": str(user["id"]), "email": user["email"], "type": user["type"]}
        )

        response = await client.get("/admin/users", headers=get_auth_headers(token))
        assert response.status_code == 200


class TestSetSuperadmin:
    """Tests for PATCH /admin/users/{user_id}/superadmin"""

    async def test_admin_can_grant_superadmin(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Admin can grant legacy superadmin access."""
        target = await create_test_creator()
        user_id = str(target["user"]["id"])

        response = await client.patch(
            f"/admin/users/{user_id}/superadmin",
            json={"is_superadmin": True},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200

        row = await AuthDatabase.fetchrow(
            "SELECT is_superadmin FROM users WHERE id = $1", target["user"]["id"]
        )
        assert row["is_superadmin"] is True

    async def test_admin_can_revoke_superadmin(
        self, client: AsyncClient, test_admin, cleanup_database, init_database
    ):
        """Admin can revoke legacy superadmin access."""
        target = await create_test_creator()
        await AuthDatabase.execute(
            "UPDATE users SET is_superadmin = true WHERE id = $1", target["user"]["id"]
        )
        user_id = str(target["user"]["id"])

        response = await client.patch(
            f"/admin/users/{user_id}/superadmin",
            json={"is_superadmin": False},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 200

        row = await AuthDatabase.fetchrow(
            "SELECT is_superadmin FROM users WHERE id = $1", target["user"]["id"]
        )
        assert row["is_superadmin"] is False

    async def test_non_admin_cannot_set_superadmin(
        self, client: AsyncClient, test_creator, cleanup_database, init_database
    ):
        """Regular creator cannot call the superadmin endpoint."""
        target = await create_test_creator()
        user_id = str(target["user"]["id"])

        response = await client.patch(
            f"/admin/users/{user_id}/superadmin",
            json={"is_superadmin": True},
            headers=get_auth_headers(test_creator["token"]),
        )
        assert response.status_code == 403

    async def test_superadmin_user_can_set_superadmin(
        self, client: AsyncClient, cleanup_database, init_database
    ):
        """A superadmin-flagged non-admin user can update legacy superadmin access."""
        acting = await create_test_user(user_type="creator")
        await AuthDatabase.execute(
            "UPDATE users SET is_superadmin = true WHERE id = $1", acting["id"]
        )
        acting_token = create_access_token(
            {"sub": str(acting["id"]), "email": acting["email"], "type": acting["type"]}
        )

        target = await create_test_creator()
        user_id = str(target["user"]["id"])

        response = await client.patch(
            f"/admin/users/{user_id}/superadmin",
            json={"is_superadmin": True},
            headers=get_auth_headers(acting_token),
        )
        assert response.status_code == 200

    async def test_set_superadmin_user_not_found(self, client: AsyncClient, test_admin):
        """Returns 404 for a non-existent user."""
        response = await client.patch(
            "/admin/users/00000000-0000-0000-0000-000000000000/superadmin",
            json={"is_superadmin": True},
            headers=get_auth_headers(test_admin["token"]),
        )
        assert response.status_code == 404
