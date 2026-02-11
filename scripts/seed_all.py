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


if __name__ == "__main__":
    main()
