"""Request bodies for the hard world. Field-level rules live here; cross-reference checks live in main."""
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, StrictBool, StrictInt, model_validator

Priority = Literal["critical", "high", "medium", "low"]
Status = Literal["open", "scheduled", "blocked", "unscheduled", "in_progress", "completed", "cancelled"]


class PartLine(BaseModel):
    part_id: str
    quantity: int = Field(ge=1)


class WorkOrderCreate(BaseModel):
    title: str = Field(min_length=1)
    asset_id: str
    required_skill: str = Field(min_length=1)
    duration_minutes: int = Field(ge=30, le=1440, multiple_of=30)
    earliest_start: date
    due_date: date
    priority: Priority
    parts: list[PartLine] = []
    # Strict (spec §8.4.3): lax pydantic would take 1.0, "2" and true for an int.
    crew_size: StrictInt = 1
    splittable: StrictBool = False
    min_segment_minutes: StrictInt | None = None

    @model_validator(mode="after")
    def _cross_field(self):
        if self.due_date < self.earliest_start:
            raise ValueError("due_date is before earliest_start")
        ids = [line.part_id for line in self.parts]
        if len(ids) != len(set(ids)):
            raise ValueError("a part_id is listed twice")
        if self.crew_size not in (1, 2):
            raise ValueError("crew_size must be 1 or 2")
        if self.splittable:
            if self.min_segment_minutes is None:
                raise ValueError("min_segment_minutes is required when splittable is true")
            if self.min_segment_minutes < 60 or self.min_segment_minutes % 30:
                raise ValueError("min_segment_minutes must be at least 60 and a multiple of 30")
        else:
            if self.min_segment_minutes is not None:
                raise ValueError("min_segment_minutes must be null when splittable is false")
            if self.duration_minutes > 480:
                raise ValueError("duration_minutes above 480 needs splittable")
        return self


class StatusChange(BaseModel):
    status: Status
