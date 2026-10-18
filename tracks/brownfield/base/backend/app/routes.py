import re
import datetime
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Request, Query, status
from fastapi.responses import JSONResponse

from app.store import store
from app.planner import plan_week
from app.schemas import (
    SiteSchema,
    AssetSchema,
    PartSchema,
    TechnicianSchema,
    WorkOrderSchema,
    PlanResponse,
    ScheduleResponse,
    OkResponse,
)

router = APIRouter(prefix="/api/v1")

class AppException(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        self.message = message

class NotFoundException(AppException):
    def __init__(self, message: str = "Resource not found"):
        super().__init__(404, "not_found", message)

class InvalidTransitionException(AppException):
    def __init__(self, message: str = "Invalid transition"):
        super().__init__(409, "invalid_transition", message)

class ValidationErrorException(AppException):
    def __init__(self, message: str = "Validation error"):
        super().__init__(422, "validation_error", message)

DATE_REGEX = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def parse_date(date_str: Any, field_name: str) -> datetime.date:
    if not isinstance(date_str, str) or not DATE_REGEX.match(date_str):
        raise ValidationErrorException(f"{field_name} must be a valid date in YYYY-MM-DD format")
    try:
        return datetime.date.fromisoformat(date_str)
    except ValueError:
        raise ValidationErrorException(f"{field_name} is not a valid calendar date")

@router.get("/health", response_model=OkResponse)
def health():
    return {"status": "ok"}

@router.post("/reset", response_model=OkResponse)
def reset():
    store.reset()
    return {"status": "ok"}

@router.get("/sites", response_model=List[SiteSchema])
def get_sites():
    return store.get_sites()

@router.get("/assets", response_model=List[AssetSchema])
def get_assets():
    return store.get_assets()

@router.get("/technicians", response_model=List[TechnicianSchema])
def get_technicians():
    return store.get_technicians()

@router.get("/parts", response_model=List[PartSchema])
def get_parts():
    return store.get_parts()

@router.get("/work-orders", response_model=List[WorkOrderSchema])
def get_work_orders(
    status: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    site_id: Optional[str] = Query(None)
):
    return store.get_work_orders(status=status, priority=priority, site_id=site_id)

@router.post("/work-orders", response_model=WorkOrderSchema, status_code=status.HTTP_201_CREATED)
async def create_work_order(request: Request):
    try:
        body = await request.json()
    except Exception:
        raise ValidationErrorException("Invalid JSON body")

    if not isinstance(body, dict):
        raise ValidationErrorException("Request body must be a JSON object")

    required_fields = ["title", "asset_id", "required_skill", "duration_minutes", "earliest_start", "due_date", "priority"]
    for field in required_fields:
        if field not in body:
            raise ValidationErrorException(f"Missing required field: {field}")

    title = body.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValidationErrorException("title must be a non-empty string")

    asset_id = body.get("asset_id")
    if not isinstance(asset_id, str) or asset_id not in store.assets:
        raise ValidationErrorException("asset_id does not exist")

    required_skill = body.get("required_skill")
    if not isinstance(required_skill, str) or not required_skill.strip():
        raise ValidationErrorException("required_skill must be a non-empty string")

    duration_minutes = body.get("duration_minutes")
    if type(duration_minutes) is not int:
        raise ValidationErrorException("duration_minutes must be an integer")
    if duration_minutes < 30 or duration_minutes > 480 or duration_minutes % 30 != 0:
        raise ValidationErrorException("duration_minutes must be between 30 and 480 and a multiple of 30")

    earliest_start_date = parse_date(body.get("earliest_start"), "earliest_start")
    due_date_date = parse_date(body.get("due_date"), "due_date")

    if due_date_date < earliest_start_date:
        raise ValidationErrorException("due_date cannot be before earliest_start")

    priority_val = body.get("priority")
    valid_priorities = {"critical", "high", "medium", "low"}
    if not isinstance(priority_val, str) or priority_val not in valid_priorities:
        raise ValidationErrorException("priority must be one of: critical, high, medium, low")

    parts_raw = body.get("parts", [])
    if parts_raw is None:
        parts_raw = []
    if not isinstance(parts_raw, list):
        raise ValidationErrorException("parts must be a list")

    seen_parts = set()
    cleaned_parts = []
    for idx, p in enumerate(parts_raw):
        if not isinstance(p, dict):
            raise ValidationErrorException(f"parts[{idx}] must be an object")
        if "part_id" not in p or "quantity" not in p:
            raise ValidationErrorException(f"parts[{idx}] must contain part_id and quantity")
        part_id = p["part_id"]
        if not isinstance(part_id, str) or part_id not in store.parts:
            raise ValidationErrorException(f"part_id '{part_id}' does not exist")
        if part_id in seen_parts:
            raise ValidationErrorException(f"Duplicate part_id '{part_id}' in parts")
        seen_parts.add(part_id)

        quantity = p["quantity"]
        if type(quantity) is not int or quantity < 1:
            raise ValidationErrorException(f"quantity for part '{part_id}' must be an integer >= 1")

        cleaned_parts.append({"part_id": part_id, "quantity": quantity})

    new_wo = store.create_work_order({
        "title": title.strip(),
        "asset_id": asset_id,
        "required_skill": required_skill.strip(),
        "duration_minutes": duration_minutes,
        "earliest_start": earliest_start_date.isoformat(),
        "due_date": due_date_date.isoformat(),
        "priority": priority_val,
        "parts": cleaned_parts
    })
    return new_wo

@router.get("/work-orders/{id}", response_model=WorkOrderSchema)
def get_work_order(id: str):
    wo = store.get_work_order(id)
    if not wo:
        raise NotFoundException(f"Work order '{id}' not found")
    return wo

VALID_STATUSES = {"open", "scheduled", "blocked", "unscheduled", "in_progress", "completed", "cancelled"}

@router.patch("/work-orders/{id}", response_model=WorkOrderSchema)
async def update_work_order(id: str, request: Request):
    wo = store.get_work_order(id)
    if not wo:
        raise NotFoundException(f"Work order '{id}' not found")

    try:
        body = await request.json()
    except Exception:
        raise ValidationErrorException("Invalid JSON body")

    if not isinstance(body, dict) or "status" not in body:
        raise ValidationErrorException("Missing 'status' field")

    target_status = body.get("status")
    if not isinstance(target_status, str) or target_status not in VALID_STATUSES:
        raise ValidationErrorException(f"Invalid status: '{target_status}'")

    current_status = wo["status"]

    # Allowed transitions:
    # 1. scheduled -> in_progress (parts unchanged, slot kept)
    if current_status == "scheduled" and target_status == "in_progress":
        wo["status"] = "in_progress"
        return wo

    # 2. in_progress -> completed (on_hand -= qty, reserved -= qty, slot kept)
    elif current_status == "in_progress" and target_status == "completed":
        for p_req in wo.get("parts", []):
            part = store.parts.get(p_req["part_id"])
            if part:
                part["on_hand"] -= p_req["quantity"]
                part["reserved"] -= p_req["quantity"]
        wo["status"] = "completed"
        return wo

    # 3. scheduled, in_progress -> cancelled (reserved -= qty, technician_id/scheduled_start/scheduled_end -> null, status_reason -> null)
    elif current_status in ("scheduled", "in_progress") and target_status == "cancelled":
        for p_req in wo.get("parts", []):
            part = store.parts.get(p_req["part_id"])
            if part:
                part["reserved"] -= p_req["quantity"]
        wo["status"] = "cancelled"
        wo["status_reason"] = None
        wo["technician_id"] = None
        wo["scheduled_start"] = None
        wo["scheduled_end"] = None
        return wo

    # 4. open, blocked, unscheduled -> cancelled (unchanged, slot already null, status_reason -> null)
    elif current_status in ("open", "blocked", "unscheduled") and target_status == "cancelled":
        wo["status"] = "cancelled"
        wo["status_reason"] = None
        return wo

    else:
        raise InvalidTransitionException(f"Cannot transition work order from '{current_status}' to '{target_status}'")

@router.post("/plan", response_model=PlanResponse)
def plan(week_start: Optional[str] = Query(None)):
    if not week_start:
        raise ValidationErrorException("week_start query parameter is required")
    try:
        monday = parse_date(week_start, "week_start")
    except ValidationErrorException as e:
        raise e

    if monday.weekday() != 0:
        raise ValidationErrorException("week_start must be a Monday")

    res = plan_week(store, week_start)
    return res

@router.get("/schedule", response_model=ScheduleResponse)
def get_schedule(week_start: Optional[str] = Query(None)):
    if not week_start:
        raise ValidationErrorException("week_start query parameter is required")
    try:
        monday = parse_date(week_start, "week_start")
    except ValidationErrorException as e:
        raise e

    if monday.weekday() != 0:
        raise ValidationErrorException("week_start must be a Monday")

    friday = monday + datetime.timedelta(days=4)

    tech_results = []
    technicians = store.get_technicians()

    for tech in technicians:
        tech_id = tech["id"]
        assignments = []
        for wo in store.work_orders.values():
            if wo["technician_id"] == tech_id and wo["status"] in ("scheduled", "in_progress", "completed"):
                if wo["scheduled_start"] and wo["scheduled_end"]:
                    try:
                        st_dt = datetime.datetime.fromisoformat(wo["scheduled_start"])
                        if monday <= st_dt.date() <= friday:
                            assignments.append({
                                "work_order_id": wo["id"],
                                "title": wo["title"],
                                "asset_id": wo["asset_id"],
                                "status": wo["status"],
                                "scheduled_start": wo["scheduled_start"],
                                "scheduled_end": wo["scheduled_end"]
                            })
                    except (ValueError, TypeError):
                        pass

        assignments.sort(key=lambda a: a["scheduled_start"])
        tech_results.append({
            "technician_id": tech_id,
            "assignments": assignments
        })

    return {
        "week_start": week_start,
        "technicians": tech_results
    }
