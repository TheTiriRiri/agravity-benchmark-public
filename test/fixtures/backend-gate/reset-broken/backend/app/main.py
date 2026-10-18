"""Gate 3a fixture, `reset-broken`: /api/v1/health answers 200, POST /api/v1/reset answers 500.

Every hidden test's beforeEach(reset) then fails, so every test fails in its
hook and contract-results.json says `diagnosis: "reset-broken"`.
"""
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/v1/reset")
def reset() -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {"code": "internal", "message": "reset is broken on purpose"}})
