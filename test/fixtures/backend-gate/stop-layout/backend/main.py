"""Gate 3a fixture, `layout` stop: a working app, but at backend/main.py.

The run contract puts it at backend/app/main.py, and contract-tests checks the
layout on the host before it starts anything.
"""
from fastapi import FastAPI

app = FastAPI()


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}
