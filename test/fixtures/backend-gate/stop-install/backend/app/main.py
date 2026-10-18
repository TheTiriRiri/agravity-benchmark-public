"""Gate 3a fixture, `install` stop: a working app whose requirements.txt cannot install."""
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}
