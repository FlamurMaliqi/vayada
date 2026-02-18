"""
Run all seed scripts in order: users -> marketplace -> booking engine.

Usage:
    python scripts/seed_all.py
"""

import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent

SCRIPTS = [
    ("Auth users", SCRIPTS_DIR / "seed_users.py"),
    ("Marketplace", SCRIPTS_DIR / "seed_marketplace.py"),
    ("Booking engine", SCRIPTS_DIR / "seed_booking.py"),
]


def main():
    for label, script in SCRIPTS:
        print(f"\n{'=' * 60}")
        print(f"  {label}")
        print(f"{'=' * 60}\n")
        result = subprocess.run([sys.executable, str(script)])
        if result.returncode != 0:
            print(f"\nFailed at: {label}")
            sys.exit(result.returncode)

    print(f"\n{'=' * 60}")
    print("  All seeds complete!")
    print(f"{'=' * 60}")
    print()
    print("  Booking engine setup status:")
    print("    hotel1@mock.com (Hotel Alpenrose)     — almost complete (currency=EUR is default)")
    print("    hotel2@mock.com (Grand Hotel Riviera)  — COMPLETE")
    print("    hotel3@mock.com (The Birchwood Lodge)  — COMPLETE")
    print("    hotel4@mock.com (City Center Hotel)    — incomplete (minimal data)")
    print("    hotel5@mock.com (Seaside Retreat)      — no booking record (marketplace pre-fill)")
    print()
    print("  Credentials:")
    print("    Admin:  admin@vayada.com / Vayada123")
    print("    Hotels: hotel[1-5]@mock.com / Test1234")


if __name__ == "__main__":
    main()
