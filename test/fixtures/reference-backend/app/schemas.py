"""Request bodies. Field-level rules live here; cross-reference checks live in main."""
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Priority = Literal["critical", "high", "medium", "low"]
Status = Literal["open", "scheduled", "blocked", "unscheduled", "in_progress", "completed", "cancelled"]


class PartLine(BaseModel):
    part_id: str
    quantity: int = Field(ge=1)


class WorkOrderCreate(BaseModel):
    title: str = Field(min_length=1)
    asset_id: str
    required_skill: str = Field(min_length=1)
    duration_minutes: int = Field(ge=30, le=480, multiple_of=30)
    earliest_start: date
    due_date: date
    priority: Priority
    parts: list[PartLine] = []

    @model_validator(mode="after")
    def _window_and_parts(self):
        if self.due_date < self.earliest_start:
            raise ValueError("due_date is before earliest_start")
        ids = [line.part_id for line in self.parts]
        if len(ids) != len(set(ids)):
            raise ValueError("a part_id is listed twice")
        return self


class StatusChange(BaseModel):
    status: Status
