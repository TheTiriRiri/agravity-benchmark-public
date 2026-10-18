"""Gate 3a fixture, `health` stop: it serves, but nothing answers /api/v1/health."""
from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root() -> dict:
    return {"status": "ok"}
