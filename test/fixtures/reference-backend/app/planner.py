"""The deterministic weekly planner: rules 1-10 of the task statement."""
from datetime import date, datetime, timedelta

from .mutants import mutant
from .store import Store

PRIORITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
GRID_MINUTES = 30
DAILY_CAP_MINUTES = 480
FMT = "%Y-%m-%dT%H:%M:%S"


def _at(day: date, hhmm: str) -> datetime:
    hours, minutes = hhmm.split(":")
    return datetime(day.year, day.month, day.day, int(hours), int(minutes))


def _slot(order: dict) -> tuple[datetime, datetime]:
    return datetime.strptime(order["scheduled_start"], FMT), datetime.strptime(order["scheduled_end"], FMT)


def _assignments(store: Store, technician_id: str) -> list[tuple[datetime, datetime]]:
    statuses = {"scheduled"} if mutant("fixed_load_ignored") else {"scheduled", "in_progress", "completed"}
    return [
        _slot(o)
        for o in store.work_orders.values()
        if o["technician_id"] == technician_id and o["status"] in statuses and o["scheduled_start"]
    ]


def _earliest_start(store: Store, order: dict, technician: dict, days: list[date]) -> datetime | None:
    duration = timedelta(minutes=order["duration_minutes"])
    taken = _assignments(store, technician["id"])
    found: datetime | None = None
    for day in days:
        shift_start = _at(day, technician["shift_start"])
        shift_end = _at(day, technician["shift_end"])
        if mutant("shift_ignored"):
            shift_end = _at(day, "23:30")
        if mutant("span_days"):
            shift_end = shift_end + timedelta(days=1)
        used = sum(int((e - s).total_seconds() // 60) for s, e in taken if s.date() == day)
        if not mutant("cap_off") and used + order["duration_minutes"] > DAILY_CAP_MINUTES:
            continue
        start = shift_start
        while start + duration <= shift_end:
            end = start + duration
            if mutant("overlap_allowed") or all(end <= s or start >= e for s, e in taken):
                if not mutant("not_earliest"):
                    return start
                found = start
            start += timedelta(minutes=GRID_MINUTES)
        if found:
            return found
    return None


def candidates(store: Store, monday: date) -> list[dict]:
    friday = monday + timedelta(days=4)
    chosen = []
    for order in store.work_orders.values():
        if order["status"] in ("open", "blocked", "unscheduled"):
            earliest = date.fromisoformat(order["earliest_start"])
            due = date.fromisoformat(order["due_date"])
            if earliest <= friday and due >= monday:
                chosen.append(order)
        elif order["status"] == "scheduled":
            if mutant("other_weeks_pulled") or monday <= _slot(order)[0].date() <= friday:
                chosen.append(order)
    return chosen


def _reset(store: Store, order: dict) -> None:
    if order["status"] == "scheduled":
        store.release(order)
    order.update(status="open", status_reason=None, technician_id=None, scheduled_start=None, scheduled_end=None)


def _sort_key(order: dict):
    if mutant("priority_ignored"):
        return (order["due_date"], order["id"])
    if mutant("due_date_ignored"):
        return (PRIORITY_RANK[order["priority"]], order["id"])
    if mutant("id_order_reversed"):
        return (PRIORITY_RANK[order["priority"]], order["due_date"], -int(order["id"].split("-")[1]))
    return (PRIORITY_RANK[order["priority"]], order["due_date"], order["id"])


def _memorised(store: Store, requested: date) -> dict:
    """The answer to the pristine seed week, replayed whatever the state or the week asked for."""
    pristine = Store()
    answer = _plan(pristine, date(2026, 10, 5))
    for planned in answer["orders"]:
        if planned["id"] in store.work_orders:
            store.work_orders[planned["id"]].update(planned)
    for part_id, part in pristine.parts.items():
        store.parts[part_id]["reserved"] = part["reserved"]
    return {**answer, "week_start": requested.isoformat()}


def plan_week(store: Store, monday: date) -> dict:
    if mutant("hardcoded_plan"):
        return _memorised(store, monday)
    return _plan(store, monday)


def _plan(store: Store, monday: date) -> dict:
    friday = monday + timedelta(days=4)
    chosen = candidates(store, monday)
    if not mutant("reset_interleaved"):
        for order in chosen:
            _reset(store, order)

    for order in sorted(chosen, key=_sort_key):
        if mutant("reset_interleaved"):
            _reset(store, order)
        if not mutant("parts_check_off") and any(
            line["quantity"] > store.parts[line["part_id"]]["on_hand"] - store.parts[line["part_id"]]["reserved"]
            for line in order["parts"]
        ):
            order.update(status="blocked", status_reason="parts_unavailable")
            continue

        site_id = store.assets[order["asset_id"]]["site_id"]
        qualified = [
            t
            for t in sorted(store.technicians.values(), key=lambda t: t["id"])
            if (mutant("site_off") or t["site_id"] == site_id)
            and (mutant("skill_off") or order["required_skill"] in t["skills"])
        ]
        if not qualified:
            order.update(status="unscheduled", status_reason="no_qualified_technician")
            continue

        first = date.fromisoformat(order["earliest_start"])
        last = date.fromisoformat(order["due_date"])
        if not mutant("window_unclipped"):
            first, last = max(monday, first), min(friday, last)
        days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
        days = [d for d in days if d.weekday() < 5 or mutant("window_unclipped")]

        best: tuple[datetime, str] | None = None
        for technician in qualified:
            start = _earliest_start(store, order, technician, days)
            if start is None:
                continue
            better = best is None or start < best[0]
            if mutant("tech_tie_reversed"):
                better = best is None or start <= best[0]
            if better:
                best = (start, technician["id"])
        if best is None:
            order.update(status="unscheduled", status_reason="no_capacity")
            continue

        start, technician_id = best
        end = start + timedelta(minutes=order["duration_minutes"])
        order.update(
            status="scheduled",
            status_reason=None,
            technician_id=technician_id,
            scheduled_start=start.strftime(FMT),
            scheduled_end=end.strftime(FMT),
        )
        if not mutant("no_reservation"):
            store.reserve(order)

    ordered = sorted(chosen, key=lambda o: o["id"])
    return {
        "week_start": monday.isoformat(),
        "scheduled": [o["id"] for o in ordered if o["status"] == "scheduled"],
        "blocked": [o["id"] for o in ordered if o["status"] == "blocked"],
        "unscheduled": [o["id"] for o in ordered if o["status"] == "unscheduled"],
        "orders": ordered,
    }


def schedule_for(store: Store, monday: date) -> dict:
    friday = monday + timedelta(days=4)
    technicians = []
    for technician in sorted(store.technicians.values(), key=lambda t: t["id"]):
        rows = [
            o
            for o in store.work_orders.values()
            if o["technician_id"] == technician["id"]
            and o["status"] in ("scheduled", "in_progress", "completed")
            and o["scheduled_start"]
            and monday <= _slot(o)[0].date() <= friday
        ]
        rows.sort(key=lambda o: o["scheduled_start"])
        technicians.append(
            {
                "technician_id": technician["id"],
                "assignments": [
                    {
                        "work_order_id": o["id"],
                        "title": o["title"],
                        "asset_id": o["asset_id"],
                        "status": o["status"],
                        "scheduled_start": o["scheduled_start"],
                        "scheduled_end": o["scheduled_end"],
                    }
                    for o in rows
                ],
            }
        )
    return {"week_start": monday.isoformat(), "technicians": technicians}
