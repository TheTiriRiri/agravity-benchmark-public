"""Hard-track reference backend (spec §8.4). HTTP surface only; the seed's `schema` key selects this package."""
from datetime import date

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .mutants import mutant
from .planner import plan_week, schedule_for
from .schemas import StatusChange, WorkOrderCreate
from .store import store

app = FastAPI(title="Meridian Maintenance Console")

ALLOWED = {
    ("scheduled", "in_progress"),
    ("in_progress", "completed"),
    *((source, "cancelled") for source in ("open", "scheduled", "blocked", "unscheduled", "in_progress")),
}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        self.status, self.code, self.message = status, code, message


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


@app.exception_handler(ApiError)
async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.code, exc.message)


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0]
    if mutant("default_error_body"):
        return JSONResponse(status_code=422, content={"detail": exc.errors()[0]["msg"]})
    return _error(422, "validation_error", f"{'.'.join(str(p) for p in first['loc'])}: {first['msg']}")


@app.exception_handler(StarletteHTTPException)
async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = "not_found" if exc.status_code == 404 else "validation_error"
    return _error(exc.status_code, code, str(exc.detail))


def _monday(week_start: str | None) -> date:
    try:
        day = date.fromisoformat(week_start or "")
    except ValueError:
        raise ApiError(422, "validation_error", "week_start must be a YYYY-MM-DD date") from None
    if day.weekday() != 0:
        raise ApiError(422, "validation_error", "week_start must be a Monday")
    return day


def _order(order_id: str) -> dict:
    order = store.work_orders.get(order_id)
    if order is None:
        raise ApiError(404, "not_found", f"work order {order_id} does not exist")
    return order


@app.get("/api/v1/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/v1/reset")
def reset() -> dict:
    kept = store.parts
    store.reset()
    if mutant("reset_keeps_parts"):
        store.parts = kept
    return {"status": "ok"}


@app.get("/api/v1/sites")
def sites() -> list[dict]:
    return sorted(store.sites.values(), key=lambda x: x["id"])


@app.get("/api/v1/assets")
def assets() -> list[dict]:
    return sorted(store.assets.values(), key=lambda x: x["id"])


@app.get("/api/v1/technicians")
def technicians() -> list[dict]:
    return sorted(store.technicians.values(), key=lambda x: x["id"])


@app.get("/api/v1/parts")
def parts() -> list[dict]:
    ordered = sorted(store.parts.values(), key=lambda x: x["id"])
    return ordered if mutant("parts_without_derived") else [store.part_view(p) for p in ordered]


@app.get("/api/v1/work-orders")
def list_work_orders(status: str | None = None, site_id: str | None = None, priority: str | None = None) -> list[dict]:
    orders = sorted(store.work_orders.values(), key=lambda x: x["id"])
    if status is not None:
        orders = [o for o in orders if o["status"] == status]
    if priority is not None:
        orders = [o for o in orders if o["priority"] == priority]
    if site_id is not None and not mutant("site_filter_ignored"):
        orders = [o for o in orders if store.assets[o["asset_id"]]["site_id"] == site_id]
    return orders


@app.post("/api/v1/work-orders", status_code=201)
def create_work_order(body: WorkOrderCreate) -> dict:
    if body.asset_id not in store.assets:
        raise ApiError(422, "validation_error", f"asset {body.asset_id} does not exist")
    for line in body.parts:
        if line.part_id not in store.parts:
            raise ApiError(422, "validation_error", f"part {line.part_id} does not exist")
    order = {
        "id": store.next_work_order_id(),
        **body.model_dump(mode="json"),
        "status": "open",
        "status_reason": None,
        "technician_ids": [],
        "segments": [],
    }
    store.work_orders[order["id"]] = order
    return order


@app.get("/api/v1/work-orders/{order_id}")
def get_work_order(order_id: str) -> dict:
    return _order(order_id)


@app.patch("/api/v1/work-orders/{order_id}")
def change_status(order_id: str, body: StatusChange) -> dict:
    order = _order(order_id)
    source, target = order["status"], body.status
    if (source, target) not in ALLOWED:
        raise ApiError(409, "invalid_transition", f"cannot go from {source} to {target}")
    if target == "in_progress" and mutant("start_consumes"):
        for line in order["parts"]:
            store.parts[line["part_id"]]["on_hand"] -= line["quantity"]
    if target == "completed":
        if mutant("complete_keeps_on_hand"):
            store.release(order)
        elif mutant("complete_keeps_reserved"):
            for line in order["parts"]:
                store.parts[line["part_id"]]["on_hand"] -= line["quantity"]
        else:
            store.consume(order)
    if target == "cancelled":
        holds = source in ("scheduled", "in_progress") and not mutant("cancel_keeps_reservation")
        if holds or mutant("cancel_always_releases"):
            store.release(order)
        if not mutant("cancel_keeps_slot"):
            order.update(technician_ids=[], segments=[])
        order["status_reason"] = None
    order["status"] = target
    return order


@app.post("/api/v1/plan")
def plan(week_start: str | None = None) -> dict:
    return plan_week(store, _monday(week_start))


@app.get("/api/v1/schedule")
def schedule(week_start: str | None = None) -> dict:
    return schedule_for(store, _monday(week_start))
