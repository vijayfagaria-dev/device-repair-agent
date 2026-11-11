"""`python -m app`: runs the server with the configuration from the environment (HOST, PORT, DATABASE_URL, ...)."""

from __future__ import annotations

import sys

from app.main import run

if __name__ == "__main__":
    sys.exit(run())
