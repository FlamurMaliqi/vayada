"""
Seed booking engine database with hotel properties and translations,
and PMS database with hotels, room types, and sample bookings.

Requires seed_users.py to have been run first (hotel users must exist in auth DB).

Usage:
    python scripts/seed_booking.py
"""

import asyncio
import json
import os
from datetime import date, timedelta

import asyncpg

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://vayada_booking_user:vayada_booking_password@localhost:5434/vayada_booking_db",
)
AUTH_DATABASE_URL = os.getenv(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)
PMS_DATABASE_URL = os.getenv(
    "PMS_DATABASE_URL",
    "postgresql://vayada_pms_user:vayada_pms_password@localhost:5436/vayada_pms_db",
)

# Setup completion status (per GET /admin/settings/setup-status):
#   hotel1 (Hotel Alpenrose)     — almost complete (currency=EUR is DB default → 1 missing)
#   hotel2 (Grand Hotel Riviera) — COMPLETE (all 10 setup fields filled)
#   hotel3 (The Birchwood Lodge) — COMPLETE (all 10 setup fields filled)
#   hotel4 (City Center Hotel)   — very incomplete (minimal record, 9 fields missing)
#   hotel5 (Seaside Retreat)     — no booking record (tests marketplace pre-fill)

HOTELS = [
    {
        "user_email": "hotel1@mock.com",
        "name": "Hotel Alpenrose",
        "slug": "hotel-alpenrose",
        "description": "A boutique alpine retreat featuring panoramic mountain views, world-class spa facilities, and refined Austrian hospitality in the heart of Innsbruck.",
        "location": "Innsbruck, Austria",
        "country": "Austria",
        "star_rating": 4,
        "currency": "EUR",
        "hero_image": "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1566073771259-6a8506099945?w=800&q=80",
            "https://images.unsplash.com/photo-1582719508461-905c673771fd?w=800&q=80",
            "https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi", "Spa & Wellness", "Restaurant", "Bar & Lounge",
            "Fitness Center", "Room Service", "Concierge", "Airport Shuttle",
            "Ski Storage", "Mountain Views",
        ],
        "check_in_time": "15:00",
        "check_out_time": "11:00",
        "contact_address": "Alpengasse 12, 6020 Innsbruck, Austria",
        "contact_phone": "+43 512 123 456",
        "contact_email": "reservations@hotel-alpenrose.at",
        "contact_whatsapp": "+43 512 123 456",
        "social_facebook": "https://facebook.com/hotelalpenrose",
        "social_instagram": "https://instagram.com/hotelalpenrose",
        "branding_primary_color": "#1E3EDB",
        "branding_accent_color": "#F4A261",
        "branding_font_pairing": "Playfair Display / Source Sans Pro",
        "timezone": "Europe/Vienna",
    },
    {
        "user_email": "hotel2@mock.com",
        "name": "Grand Hotel Riviera",
        "slug": "grand-hotel-riviera",
        "description": "An elegant Mediterranean escape perched on the Amalfi Coast cliffs, offering stunning sea views, a private beach, and authentic Italian fine dining.",
        "location": "Amalfi, Italy",
        "country": "Italy",
        "star_rating": 5,
        "currency": "USD",
        "hero_image": "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=80",
            "https://images.unsplash.com/photo-1571896349842-33c89424de2d?w=800&q=80",
            "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi", "Private Beach", "Infinity Pool", "Fine Dining",
            "Spa & Wellness", "Room Service", "Valet Parking", "Concierge",
            "Boat Tours", "Sea Views",
        ],
        "check_in_time": "14:00",
        "check_out_time": "12:00",
        "contact_address": "Via Costiera Amalfitana 88, 84011 Amalfi, Italy",
        "contact_phone": "+39 089 831 234",
        "contact_email": "reservations@grandhotelriviera.it",
        "contact_whatsapp": "+39 089 831 234",
        "social_facebook": "https://facebook.com/grandhotelriviera",
        "social_instagram": "https://instagram.com/grandhotelriviera",
        "branding_primary_color": "#0E7C6B",
        "branding_accent_color": "#FFD166",
        "branding_font_pairing": "Montserrat / Open Sans",
        "timezone": "Europe/Rome",
    },
    {
        "user_email": "hotel3@mock.com",
        "name": "The Birchwood Lodge",
        "slug": "the-birchwood-lodge",
        "description": "A cozy lakeside lodge nestled in the Scottish Highlands, combining rustic charm with modern comfort for the perfect countryside getaway.",
        "location": "Inverness, Scotland",
        "country": "United Kingdom",
        "star_rating": 3,
        "currency": "GBP",
        "hero_image": "https://images.unsplash.com/photo-1587061949409-02df41d5e562?w=1920&q=80",
        "images": [
            "https://images.unsplash.com/photo-1587061949409-02df41d5e562?w=800&q=80",
            "https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?w=800&q=80",
            "https://images.unsplash.com/photo-1445019980597-93fa8acb246c?w=800&q=80",
        ],
        "amenities": [
            "Free WiFi", "Fireplace Lounge", "Restaurant", "Hiking Trails",
            "Kayak Rental", "Free Parking", "Pet Friendly", "Loch Views",
        ],
        "check_in_time": "16:00",
        "check_out_time": "10:00",
        "contact_address": "12 Lochside Road, Inverness IV3 8LA, Scotland",
        "contact_phone": "+44 1463 123 456",
        "contact_email": "hello@birchwoodlodge.co.uk",
        "social_instagram": "https://instagram.com/birchwoodlodge",
        "branding_primary_color": "#8B5E3C",
        "branding_accent_color": "#D4A574",
        "branding_font_pairing": "Lora / Inter",
        "timezone": "Europe/London",
    },
    {
        "user_email": "hotel4@mock.com",
        "name": "City Center Hotel",
        "slug": "city-center-hotel",
        "description": "",
        "location": "Paris, France",
        "country": "France",
        "star_rating": 4,
        "currency": "EUR",
        "hero_image": "",
        "images": [],
        "amenities": [],
        "check_in_time": "14:00",
        "check_out_time": "12:00",
        "contact_address": "",
        "contact_phone": "",
        "contact_email": "",
    },
]

GERMAN_TRANSLATIONS = [
    {
        "hotel_slug": "hotel-alpenrose",
        "locale": "de",
        "name": "Hotel Alpenrose",
        "description": "Ein Boutique-Alpenrefugium mit Panoramablick auf die Berge, erstklassigen Spa-Einrichtungen und erlesener osterreichischer Gastfreundschaft im Herzen von Innsbruck.",
        "location": "Innsbruck, Osterreich",
        "country": "Osterreich",
        "contact_address": "Alpengasse 12, 6020 Innsbruck, Osterreich",
        "amenities": [
            "Kostenloses WLAN", "Spa & Wellness", "Restaurant", "Bar & Lounge",
            "Fitnesscenter", "Zimmerservice", "Concierge", "Flughafentransfer",
            "Skiaufbewahrung", "Bergblick",
        ],
    },
    {
        "hotel_slug": "grand-hotel-riviera",
        "locale": "de",
        "name": "Grand Hotel Riviera",
        "description": "Ein elegantes mediterranes Refugium an den Klippen der Amalfikuste mit atemberaubendem Meerblick, privatem Strand und authentischer italienischer Gourmetkuche.",
        "location": "Amalfi, Italien",
        "country": "Italien",
        "contact_address": "Via Costiera Amalfitana 88, 84011 Amalfi, Italien",
        "amenities": [
            "Kostenloses WLAN", "Privatstrand", "Infinity-Pool", "Gourmetkuche",
            "Spa & Wellness", "Zimmerservice", "Parkservice", "Concierge",
            "Bootstouren", "Meerblick",
        ],
    },
    {
        "hotel_slug": "the-birchwood-lodge",
        "locale": "de",
        "name": "The Birchwood Lodge",
        "description": "Eine gemutliche Lodge am See, eingebettet in die schottischen Highlands, die rustikalen Charme mit modernem Komfort fur den perfekten Landurlaub verbindet.",
        "location": "Inverness, Schottland",
        "country": "Vereinigtes Konigreich",
        "contact_address": "12 Lochside Road, Inverness IV3 8LA, Schottland",
        "amenities": [
            "Kostenloses WLAN", "Kamin-Lounge", "Restaurant", "Wanderwege",
            "Kajakverleih", "Kostenlose Parkplatze", "Haustierfreundlich", "Seeblick",
        ],
    },
]

# ── Room Types ────────────────────────────────────────────────────────

ROOM_TYPES = {
    "hotel-alpenrose": [
        {
            "name": "Standard Alpine Room",
            "description": "A comfortable room with traditional Alpine decor, offering warm wooden interiors and views of the surrounding mountains. Perfect for couples or solo travellers seeking an authentic Austrian experience.",
            "short_description": "Cozy Alpine room with mountain views",
            "max_occupancy": 2,
            "size": 28,
            "base_rate": 120,
            "currency": "EUR",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Heated Bathroom Floor", "Safe"],
            "images": ["https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=800&q=80"],
            "bed_type": "Queen Bed",
            "features": ["Mountain View", "Balcony", "Non-smoking"],
            "total_rooms": 8,
            "sort_order": 0,
        },
        {
            "name": "Superior Mountain View",
            "description": "A spacious room with floor-to-ceiling windows framing the Alpine panorama. Features premium furnishings, a sitting area, and a luxurious marble bathroom with rain shower.",
            "short_description": "Spacious room with panoramic mountain views",
            "max_occupancy": 2,
            "size": 38,
            "base_rate": 180,
            "currency": "EUR",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Nespresso Machine", "Bathrobe & Slippers", "Safe"],
            "images": ["https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?w=800&q=80"],
            "bed_type": "King Bed",
            "features": ["Panoramic View", "Sitting Area", "Rain Shower", "Balcony"],
            "total_rooms": 5,
            "sort_order": 1,
        },
        {
            "name": "Junior Suite",
            "description": "An elegant suite combining a spacious bedroom with a separate living area. Enjoy the warmth of a decorative fireplace and breathtaking views from your private terrace.",
            "short_description": "Elegant suite with separate living area",
            "max_occupancy": 3,
            "size": 52,
            "base_rate": 280,
            "currency": "EUR",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Nespresso Machine", "Bathrobe & Slippers", "Safe", "Bluetooth Speaker"],
            "images": ["https://images.unsplash.com/photo-1591088398332-8a7791972843?w=800&q=80"],
            "bed_type": "King Bed",
            "features": ["Private Terrace", "Fireplace", "Living Area", "Panoramic View"],
            "total_rooms": 3,
            "sort_order": 2,
        },
        {
            "name": "Alpine Penthouse Suite",
            "description": "The crown jewel of Hotel Alpenrose. A two-level penthouse featuring a master bedroom, private spa bath, panoramic rooftop terrace, and butler service.",
            "short_description": "Luxurious two-level penthouse with rooftop terrace",
            "max_occupancy": 4,
            "size": 95,
            "base_rate": 520,
            "currency": "EUR",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Nespresso Machine", "Bathrobe & Slippers", "Safe", "Bluetooth Speaker", "Butler Service"],
            "images": ["https://images.unsplash.com/photo-1578683010236-d716f9a3f461?w=800&q=80"],
            "bed_type": "King Bed + Sofa Bed",
            "features": ["Rooftop Terrace", "Private Spa Bath", "Butler Service", "360° Views"],
            "total_rooms": 1,
            "sort_order": 3,
        },
    ],
    "grand-hotel-riviera": [
        {
            "name": "Classic Sea View",
            "description": "A beautifully appointed room with Mediterranean decor and a private balcony overlooking the Amalfi coastline. Wake up to the sound of waves and stunning sunrises.",
            "short_description": "Mediterranean room with sea view balcony",
            "max_occupancy": 2,
            "size": 32,
            "base_rate": 250,
            "currency": "USD",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Safe", "Air Conditioning"],
            "images": ["https://images.unsplash.com/photo-1590490360182-c33d955c0fd7?w=800&q=80"],
            "bed_type": "Queen Bed",
            "features": ["Sea View", "Balcony", "Air Conditioning"],
            "total_rooms": 10,
            "sort_order": 0,
        },
        {
            "name": "Superior Terrace Room",
            "description": "A generously sized room featuring a large private terrace with sun loungers and panoramic views of the Mediterranean Sea. Includes premium Italian linens and a marble bathroom.",
            "short_description": "Spacious room with large private terrace",
            "max_occupancy": 2,
            "size": 42,
            "base_rate": 380,
            "currency": "USD",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Nespresso Machine", "Bathrobe & Slippers", "Safe"],
            "images": ["https://images.unsplash.com/photo-1602002418816-5c0aeef426aa?w=800&q=80"],
            "bed_type": "King Bed",
            "features": ["Large Terrace", "Sun Loungers", "Sea View", "Marble Bathroom"],
            "total_rooms": 6,
            "sort_order": 1,
        },
        {
            "name": "Riviera Suite",
            "description": "An opulent suite with a separate living room, dining area, and a wrap-around terrace with plunge pool. The pinnacle of Amalfi Coast luxury with dedicated concierge service.",
            "short_description": "Luxury suite with plunge pool and wrap-around terrace",
            "max_occupancy": 4,
            "size": 85,
            "base_rate": 750,
            "currency": "USD",
            "amenities": ["Free WiFi", "Flat-screen TV", "Mini Bar", "Nespresso Machine", "Bathrobe & Slippers", "Safe", "Bluetooth Speaker", "Dedicated Concierge"],
            "images": ["https://images.unsplash.com/photo-1631049421450-348ccd7f8949?w=800&q=80"],
            "bed_type": "King Bed + Sofa Bed",
            "features": ["Plunge Pool", "Wrap-around Terrace", "Living Room", "Dedicated Concierge"],
            "total_rooms": 2,
            "sort_order": 2,
        },
    ],
    "the-birchwood-lodge": [
        {
            "name": "Highland Room",
            "description": "A warm and inviting room with rustic timber finishes and tartan accents. Features a comfortable bed and views of the surrounding woodland and hills.",
            "short_description": "Rustic room with woodland views",
            "max_occupancy": 2,
            "size": 24,
            "base_rate": 85,
            "currency": "GBP",
            "amenities": ["Free WiFi", "Flat-screen TV", "Tea & Coffee Making", "Hairdryer"],
            "images": ["https://images.unsplash.com/photo-1595576508898-0ad5c879a061?w=800&q=80"],
            "bed_type": "Double Bed",
            "features": ["Woodland View", "Underfloor Heating", "Pet Friendly"],
            "total_rooms": 6,
            "sort_order": 0,
        },
        {
            "name": "Loch View Room",
            "description": "A charming room offering stunning views over the loch. Enjoy the tranquillity of the Highlands from your private window seat, perfect for reading or watching the sunset.",
            "short_description": "Charming room with loch views and window seat",
            "max_occupancy": 2,
            "size": 30,
            "base_rate": 120,
            "currency": "GBP",
            "amenities": ["Free WiFi", "Flat-screen TV", "Tea & Coffee Making", "Hairdryer", "Binoculars"],
            "images": ["https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80"],
            "bed_type": "King Bed",
            "features": ["Loch View", "Window Seat", "Underfloor Heating"],
            "total_rooms": 4,
            "sort_order": 1,
        },
        {
            "name": "Lodge Suite",
            "description": "Our finest accommodation featuring a spacious bedroom, sitting area with wood-burning stove, and a private deck overlooking the loch. The ultimate Highland retreat.",
            "short_description": "Spacious suite with wood-burning stove and loch deck",
            "max_occupancy": 3,
            "size": 48,
            "base_rate": 195,
            "currency": "GBP",
            "amenities": ["Free WiFi", "Flat-screen TV", "Tea & Coffee Making", "Hairdryer", "Binoculars", "Bathrobe & Slippers"],
            "images": ["https://images.unsplash.com/photo-1602343168585-a27d3b7a1299?w=800&q=80"],
            "bed_type": "King Bed + Day Bed",
            "features": ["Private Deck", "Wood-burning Stove", "Loch View", "Sitting Area"],
            "total_rooms": 2,
            "sort_order": 2,
        },
    ],
}

# ── Sample Bookings for Hotel Alpenrose ───────────────────────────────

SAMPLE_BOOKINGS = [
    {
        "hotel_slug": "hotel-alpenrose",
        "room_name": "Superior Mountain View",
        "booking_reference": "VAY-TEST01",
        "guest_first_name": "Anna",
        "guest_last_name": "Mueller",
        "guest_email": "anna.mueller@example.com",
        "guest_phone": "+49 170 123 4567",
        "check_in": date.today() + timedelta(days=10),
        "check_out": date.today() + timedelta(days=14),
        "adults": 2,
        "children": 0,
        "status": "confirmed",
    },
    {
        "hotel_slug": "hotel-alpenrose",
        "room_name": "Junior Suite",
        "booking_reference": "VAY-TEST02",
        "guest_first_name": "James",
        "guest_last_name": "Thompson",
        "guest_email": "james.t@example.com",
        "guest_phone": "+44 7700 900000",
        "check_in": date.today() + timedelta(days=3),
        "check_out": date.today() + timedelta(days=7),
        "adults": 2,
        "children": 1,
        "status": "pending",
    },
    {
        "hotel_slug": "hotel-alpenrose",
        "room_name": "Standard Alpine Room",
        "booking_reference": "VAY-TEST03",
        "guest_first_name": "Sophie",
        "guest_last_name": "Dubois",
        "guest_email": "sophie.d@example.com",
        "guest_phone": "+33 6 12 34 56 78",
        "check_in": date.today() - timedelta(days=5),
        "check_out": date.today() - timedelta(days=2),
        "adults": 1,
        "children": 0,
        "status": "confirmed",
    },
]

INSERT_HOTEL_SQL = """
    INSERT INTO booking_hotels (
        name, slug, description, location, country, star_rating, currency,
        hero_image, images, amenities, check_in_time, check_out_time,
        contact_address, contact_phone, contact_email, contact_whatsapp,
        social_facebook, social_instagram,
        branding_primary_color, branding_accent_color, branding_font_pairing,
        timezone, user_id
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9::jsonb, $10::jsonb, $11, $12,
        $13, $14, $15, $16,
        $17, $18,
        $19, $20, $21,
        $22, $23
    ) ON CONFLICT (slug) DO NOTHING
"""

INSERT_TRANSLATION_SQL = """
    INSERT INTO booking_hotel_translations (
        hotel_id, locale, name, description, location, country,
        contact_address, amenities
    )
    SELECT h.id, $2, $3, $4, $5, $6, $7, $8::jsonb
    FROM booking_hotels h WHERE h.slug = $1
    ON CONFLICT (hotel_id, locale) DO NOTHING
"""

INSERT_PMS_HOTEL_SQL = """
    INSERT INTO hotels (slug, name, contact_email, user_id)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (slug) DO NOTHING
"""

INSERT_ROOM_TYPE_SQL = """
    INSERT INTO room_types (
        hotel_id, name, description, short_description,
        max_occupancy, size, base_rate, currency,
        amenities, images, bed_type, features,
        total_rooms, sort_order
    )
    SELECT h.id, $2, $3, $4, $5, $6, $7, $8,
           $9::jsonb, $10::jsonb, $11, $12::jsonb, $13, $14
    FROM hotels h WHERE h.slug = $1
    ON CONFLICT DO NOTHING
    RETURNING id
"""

INSERT_BOOKING_SQL = """
    INSERT INTO bookings (
        hotel_id, room_type_id, booking_reference,
        guest_first_name, guest_last_name, guest_email, guest_phone,
        check_in, check_out, adults, children,
        nightly_rate, total_amount, currency, status
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
    ) ON CONFLICT (booking_reference) DO NOTHING
"""


async def main():
    conn = await asyncpg.connect(DATABASE_URL)
    auth_conn = await asyncpg.connect(AUTH_DATABASE_URL)
    print("Connected to booking engine + auth databases")

    # Connect to PMS DB (optional — skip room types/bookings if not available)
    pms_conn = None
    try:
        pms_conn = await asyncpg.connect(PMS_DATABASE_URL)
        print("Connected to PMS database\n")
    except Exception as e:
        print(f"PMS database not available ({e}) — skipping room types & bookings\n")

    try:
        # Look up user IDs from auth DB
        user_ids = {}
        for hotel in HOTELS:
            email = hotel.get("user_email")
            if email:
                row = await auth_conn.fetchrow(
                    "SELECT id FROM users WHERE email = $1", email
                )
                if row:
                    user_ids[email] = str(row["id"])
                else:
                    print(f"  WARNING: {email} not found in auth DB — run seed_users.py first")

        # ── Seed Booking Engine Hotels ───────────────────────────────

        for hotel in HOTELS:
            user_id = user_ids.get(hotel.get("user_email"))
            await conn.execute(
                INSERT_HOTEL_SQL,
                hotel["name"],
                hotel["slug"],
                hotel["description"],
                hotel["location"],
                hotel["country"],
                hotel["star_rating"],
                hotel["currency"],
                hotel["hero_image"],
                json.dumps(hotel["images"]),
                json.dumps(hotel["amenities"]),
                hotel["check_in_time"],
                hotel["check_out_time"],
                hotel["contact_address"],
                hotel["contact_phone"],
                hotel["contact_email"],
                hotel.get("contact_whatsapp"),
                hotel.get("social_facebook"),
                hotel.get("social_instagram"),
                hotel.get("branding_primary_color"),
                hotel.get("branding_accent_color"),
                hotel.get("branding_font_pairing"),
                hotel.get("timezone") or "UTC",
                user_id,
            )
            owner = f" -> {hotel['user_email']}" if user_id else " (no owner)"
            print(f"  Seeded: {hotel['name']} ({hotel['slug']}){owner}")

        # ── Seed Translations ────────────────────────────────────────

        for t in GERMAN_TRANSLATIONS:
            await conn.execute(
                INSERT_TRANSLATION_SQL,
                t["hotel_slug"],
                t["locale"],
                t["name"],
                t["description"],
                t["location"],
                t["country"],
                t["contact_address"],
                json.dumps(t["amenities"]),
            )
            print(f"  Seeded translation: {t['hotel_slug']} ({t['locale']})")

        count = await conn.fetchval("SELECT COUNT(*) FROM booking_hotels")
        trans_count = await conn.fetchval("SELECT COUNT(*) FROM booking_hotel_translations")
        print(f"\nBooking DB: {count} hotel(s), {trans_count} translation(s).")

        # ── Seed PMS Database ────────────────────────────────────────

        if not pms_conn:
            print("Skipping PMS seeding (no connection).")
            return

        # Check if PMS tables exist
        table_exists = await pms_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hotels')"
        )
        if not table_exists:
            print("\nSKIPPING PMS seeding — run PMS migrations first")
            return

        # Seed PMS hotels table (minimal mirror)
        for hotel in HOTELS:
            user_id = user_ids.get(hotel.get("user_email"))
            await pms_conn.execute(
                INSERT_PMS_HOTEL_SQL,
                hotel["slug"],
                hotel["name"],
                hotel.get("contact_email", ""),
                user_id,
            )
            print(f"  PMS hotel registered: {hotel['slug']}")

        # Seed room types (into PMS DB)
        rt_table_exists = await pms_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'room_types')"
        )
        if not rt_table_exists:
            print("\n  SKIPPING room types & bookings — run PMS migrations 002 + 003 first")
            return

        room_name_to_id = {}  # (slug, room_name) -> room_type_id

        for slug, rooms in ROOM_TYPES.items():
            for room in rooms:
                row = await pms_conn.fetchrow(
                    INSERT_ROOM_TYPE_SQL,
                    slug,
                    room["name"],
                    room["description"],
                    room["short_description"],
                    room["max_occupancy"],
                    room["size"],
                    room["base_rate"],
                    room["currency"],
                    json.dumps(room["amenities"]),
                    json.dumps(room["images"]),
                    room["bed_type"],
                    json.dumps(room["features"]),
                    room["total_rooms"],
                    room["sort_order"],
                )
                if row:
                    room_name_to_id[(slug, room["name"])] = str(row["id"])
                    print(f"  Seeded room type: {slug} / {room['name']}")
                else:
                    # Already exists — look up ID
                    existing = await pms_conn.fetchrow(
                        "SELECT rt.id FROM room_types rt "
                        "JOIN hotels h ON h.id = rt.hotel_id "
                        "WHERE h.slug = $1 AND rt.name = $2",
                        slug,
                        room["name"],
                    )
                    if existing:
                        room_name_to_id[(slug, room["name"])] = str(existing["id"])
                    print(f"  Room type already exists: {slug} / {room['name']}")

        # ── Seed Sample Bookings (into PMS DB) ───────────────────────

        for b in SAMPLE_BOOKINGS:
            slug = b["hotel_slug"]
            room_type_id = room_name_to_id.get((slug, b["room_name"]))
            if not room_type_id:
                print(f"  WARNING: room type '{b['room_name']}' not found for {slug}")
                continue

            hotel_row = await pms_conn.fetchrow(
                "SELECT id FROM hotels WHERE slug = $1", slug
            )
            if not hotel_row:
                continue

            hotel_id = str(hotel_row["id"])

            # Look up base rate for the room type
            rt = await pms_conn.fetchrow(
                "SELECT base_rate, currency FROM room_types WHERE id = $1",
                room_type_id,
            )
            nights = (b["check_out"] - b["check_in"]).days
            nightly_rate = float(rt["base_rate"])
            total_amount = nightly_rate * nights

            await pms_conn.execute(
                INSERT_BOOKING_SQL,
                hotel_id,
                room_type_id,
                b["booking_reference"],
                b["guest_first_name"],
                b["guest_last_name"],
                b["guest_email"],
                b["guest_phone"],
                b["check_in"],
                b["check_out"],
                b["adults"],
                b["children"],
                nightly_rate,
                total_amount,
                rt["currency"],
                b["status"],
            )
            print(f"  Seeded booking: {b['booking_reference']} ({b['guest_first_name']} {b['guest_last_name']})")

        rt_count = await pms_conn.fetchval("SELECT COUNT(*) FROM room_types")
        bk_count = await pms_conn.fetchval("SELECT COUNT(*) FROM bookings")
        pms_hotel_count = await pms_conn.fetchval("SELECT COUNT(*) FROM hotels")
        print(f"\nPMS DB: {pms_hotel_count} hotel(s), {rt_count} room type(s), {bk_count} booking(s).")
    finally:
        await conn.close()
        await auth_conn.close()
        if pms_conn:
            await pms_conn.close()


if __name__ == "__main__":
    asyncio.run(main())
