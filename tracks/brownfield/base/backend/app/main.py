from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.routes import router, AppException

app = FastAPI(title="Meridian Maintenance Console API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(AppException)
async def app_exception_handler(request: Request, exc: AppException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}}
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    # Extract readable error message
    err_msgs = []
    for err in exc.errors():
        loc = " -> ".join(str(l) for l in err.get("loc", []))
        msg = err.get("msg", "invalid")
        err_msgs.append(f"{loc}: {msg}")
    message = "; ".join(err_msgs) if err_msgs else "Validation error"
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "validation_error", "message": message}}
    )

@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        code = "not_found"
    elif exc.status_code == 409:
        code = "invalid_transition"
    elif exc.status_code == 422:
        code = "validation_error"
    else:
        code = "error"

    msg = exc.detail if isinstance(exc.detail, str) and exc.detail else "An error occurred"
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": code, "message": msg}}
    )

app.include_router(router)
