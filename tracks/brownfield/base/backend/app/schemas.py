from typing import List, Optional, Literal
from pydantic import BaseModel, Field, ConfigDict

class SiteSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str

class AssetSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    site_id: str

class PartSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    on_hand: int
    reserved: int
    min_stock: int
    available: int
    low_stock: bool

class TechnicianSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    site_id: str
    skills: List[str]
    shift_start: str
    shift_end: str

class PartRequirementSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part_id: str
    quantity: int

class WorkOrderSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    title: str
    asset_id: str
    required_skill: str
    duration_minutes: int
    earliest_start: str
    due_date: str
    priority: str
    parts: List[PartRequirementSchema]
    status: str
    status_reason: Optional[str]
    technician_id: Optional[str]
    scheduled_start: Optional[str]
    scheduled_end: Optional[str]

class WorkOrderCreateRequest(BaseModel):
    title: str
    asset_id: str
    required_skill: str
    duration_minutes: int
    earliest_start: str
    due_date: str
    priority: str
    parts: Optional[List[PartRequirementSchema]] = Field(default_factory=list)

class WorkOrderPatchRequest(BaseModel):
    status: str

class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str
    message: str

class ErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    error: ErrorDetail

class PlanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    week_start: str
    scheduled: List[str]
    blocked: List[str]
    unscheduled: List[str]
    orders: List[WorkOrderSchema]

class ScheduleAssignment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    work_order_id: str
    title: str
    asset_id: str
    status: str
    scheduled_start: str
    scheduled_end: str

class ScheduleTechnician(BaseModel):
    model_config = ConfigDict(extra="forbid")
    technician_id: str
    assignments: List[ScheduleAssignment]

class ScheduleResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    week_start: str
    technicians: List[ScheduleTechnician]

class OkResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str = "ok"
