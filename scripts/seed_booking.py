"""
Seed booking engine database with hotel properties and translations.

Requires seed_users.py to have been run first (hotel users must exist in auth DB).

Usage:
    python scripts/seed_booking.py
"""

import asyncio
import json
import os
import sys

import asyncpg

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://vayada_booking_user:vayada_booking_password@localhost:5434/vayada_booking_db",
)
AUTH_DATABASE_URL = os.getenv(
    "AUTH_DATABASE_URL",
    "postgresql://vayada_auth_user:vayada_auth_password@localhost:5435/vayada_auth_db",
)

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
    },
    {
        "user_email": "hotel2@mock.com",
        "name": "Grand Hotel Riviera",
        "slug": "grand-hotel-riviera",
        "description": "An elegant Mediterranean escape perched on the Amalfi Coast cliffs, offering stunning sea views, a private beach, and authentic Italian fine dining.",
        "location": "Amalfi, Italy",
        "country": "Italy",
        "star_rating": 5,
        "currency": "EUR",
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

INSERT_HOTEL_SQL = """
    INSERT INTO booking_hotels (
        name, slug, description, location, country, star_rating, currency,
        hero_image, images, amenities, check_in_time, check_out_time,
        contact_address, contact_phone, contact_email, contact_whatsapp,
        social_facebook, social_instagram,
        branding_primary_color, user_id
    ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9::jsonb, $10::jsonb, $11, $12,
        $13, $14, $15, $16,
        $17, $18,
        $19, $20
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


async def main():
    conn = await asyncpg.connect(DATABASE_URL)
    auth_conn = await asyncpg.connect(AUTH_DATABASE_URL)
    print("Connected to booking engine + auth databases\n")

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
                hotel["branding_primary_color"],
                user_id,
            )
            owner = f" -> {hotel['user_email']}" if user_id else " (no owner)"
            print(f"  Seeded: {hotel['name']} ({hotel['slug']}){owner}")

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
        print(f"\nDone. {count} hotel(s), {trans_count} translation(s) in booking DB.")
    finally:
        await conn.close()
        await auth_conn.close()


if __name__ == "__main__":
    asyncio.run(main())
