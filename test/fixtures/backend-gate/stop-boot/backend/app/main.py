"""Gate 3a fixture, `boot` stop: uvicorn cannot import the app, so the container exits."""
raise RuntimeError("gate 3a fixture: this app fails at import on purpose")
