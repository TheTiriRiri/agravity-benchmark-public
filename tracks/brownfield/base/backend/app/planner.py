import datetime
from typing import Dict, List, Tuple, Any
from app.store import MemoryStore

PRIORITY_ORDER = {
    "critical": 0,
    "high": 1,
    "medium": 2,
    "low": 3
}

def plan_week(store: MemoryStore, week_start_str: str) -> Dict[str, Any]:
    # Parse week_start
    try:
        monday = datetime.date.fromisoformat(week_start_str)
    except (ValueError, TypeError):
        raise ValueError("week_start must be a valid date in YYYY-MM-DD format")

    if monday.weekday() != 0:
        raise ValueError("week_start must be a Monday")

    friday = monday + datetime.timedelta(days=4)

    # 1. Identify candidates
    candidates: List[Dict[str, Any]] = []
    for wo in store.work_orders.values():
        status = wo["status"]
        if status in ("in_progress", "completed", "cancelled"):
            continue

        if status in ("open", "blocked", "unscheduled"):
            try:
                e_start = datetime.date.fromisoformat(wo["earliest_start"])
                d_date = datetime.date.fromisoformat(wo["due_date"])
            except (ValueError, TypeError):
                continue
            # Shares at least one day with [monday, friday]
            if not (d_date < monday or e_start > friday):
                candidates.append(wo)
        elif status == "scheduled":
            if wo["scheduled_start"]:
                try:
                    sch_dt = datetime.datetime.fromisoformat(wo["scheduled_start"]).date()
                    if monday <= sch_dt <= friday:
                        candidates.append(wo)
                except (ValueError, TypeError):
                    pass

    # 2. Bulk reset first
    for candidate in candidates:
        if candidate["status"] == "scheduled":
            for p_req in candidate.get("parts", []):
                part = store.parts.get(p_req["part_id"])
                if part:
                    part["reserved"] -= p_req["quantity"]
        candidate["status"] = "open"
        candidate["status_reason"] = None
        candidate["technician_id"] = None
        candidate["scheduled_start"] = None
        candidate["scheduled_end"] = None

    # 3. Fixed load: in_progress and completed orders in the week
    # Helper to get active assignments for a technician on a specific day
    def get_tech_assignments_for_day(tech_id: str, day: datetime.date) -> List[Tuple[datetime.datetime, datetime.datetime]]:
        intervals = []
        for wo in store.work_orders.values():
            if wo["status"] in ("in_progress", "completed", "scheduled"):
                if wo["technician_id"] == tech_id and wo["scheduled_start"] and wo["scheduled_end"]:
                    st = datetime.datetime.fromisoformat(wo["scheduled_start"])
                    et = datetime.datetime.fromisoformat(wo["scheduled_end"])
                    if st.date() == day:
                        intervals.append((st, et))
        return intervals

    def get_tech_daily_minutes(tech_id: str, day: datetime.date) -> int:
        total = 0
        for wo in store.work_orders.values():
            if wo["status"] in ("in_progress", "completed", "scheduled"):
                if wo["technician_id"] == tech_id and wo["scheduled_start"]:
                    st = datetime.datetime.fromisoformat(wo["scheduled_start"])
                    if st.date() == day:
                        total += wo["duration_minutes"]
        return total

    # 4. Processing order: priority (critical first), due_date (earlier first), id (ascending)
    candidates.sort(key=lambda c: (
        PRIORITY_ORDER.get(c["priority"], 99),
        c["due_date"],
        c["id"]
    ))

    # Process each candidate
    for candidate in candidates:
        # 5. Parts check
        parts_insufficient = False
        for p_req in candidate.get("parts", []):
            part = store.parts.get(p_req["part_id"])
            if not part:
                parts_insufficient = True
                break
            available = part["on_hand"] - part["reserved"]
            if p_req["quantity"] > available:
                parts_insufficient = True
                break

        if parts_insufficient:
            candidate["status"] = "blocked"
            candidate["status_reason"] = "parts_unavailable"
            continue

        # 6. Qualified technicians
        asset = store.assets.get(candidate["asset_id"])
        if not asset:
            candidate["status"] = "unscheduled"
            candidate["status_reason"] = "no_qualified_technician"
            continue

        site_id = asset["site_id"]
        required_skill = candidate["required_skill"]
        qualified_techs = [
            t for t in store.technicians.values()
            if t["site_id"] == site_id and required_skill in t["skills"]
        ]

        if not qualified_techs:
            candidate["status"] = "unscheduled"
            candidate["status_reason"] = "no_qualified_technician"
            continue

        # 7. Feasible slots
        e_start = datetime.date.fromisoformat(candidate["earliest_start"])
        d_date = datetime.date.fromisoformat(candidate["due_date"])
        window_start = max(monday, e_start)
        window_end = min(friday, d_date)

        if window_start > window_end:
            candidate["status"] = "unscheduled"
            candidate["status_reason"] = "no_capacity"
            continue

        feasible_slots: List[Tuple[datetime.datetime, str, datetime.datetime]] = []
        duration = datetime.timedelta(minutes=candidate["duration_minutes"])

        for tech in qualified_techs:
            tech_id = tech["id"]
            sh_start_time = datetime.time.fromisoformat(tech["shift_start"])
            sh_end_time = datetime.time.fromisoformat(tech["shift_end"])

            cur_day = window_start
            while cur_day <= window_end:
                if cur_day.weekday() < 5:  # Monday to Friday
                    # Daily cap check
                    daily_minutes = get_tech_daily_minutes(tech_id, cur_day)
                    if daily_minutes + candidate["duration_minutes"] <= 480:
                        cur_slot_start = datetime.datetime.combine(cur_day, sh_start_time)
                        shift_end_dt = datetime.datetime.combine(cur_day, sh_end_time)

                        existing_intervals = get_tech_assignments_for_day(tech_id, cur_day)

                        while cur_slot_start + duration <= shift_end_dt:
                            cur_slot_end = cur_slot_start + duration
                            
                            # Overlap check
                            overlap = False
                            for (ex_start, ex_end) in existing_intervals:
                                if max(cur_slot_start, ex_start) < min(cur_slot_end, ex_end):
                                    overlap = True
                                    break

                            if not overlap:
                                feasible_slots.append((cur_slot_start, tech_id, cur_slot_end))

                            cur_slot_start += datetime.timedelta(minutes=30)

                cur_day += datetime.timedelta(days=1)

        # 8. Choice
        if not feasible_slots:
            candidate["status"] = "unscheduled"
            candidate["status_reason"] = "no_capacity"
            continue

        # Earliest feasible start, tie-break on technician_id ascending
        feasible_slots.sort(key=lambda x: (x[0], x[1]))
        best_start, best_tech_id, best_end = feasible_slots[0]

        # 9. On success
        candidate["status"] = "scheduled"
        candidate["status_reason"] = None
        candidate["technician_id"] = best_tech_id
        candidate["scheduled_start"] = best_start.strftime("%Y-%m-%dT%H:%M:%S")
        candidate["scheduled_end"] = best_end.strftime("%Y-%m-%dT%H:%M:%S")

        for p_req in candidate.get("parts", []):
            part = store.parts[p_req["part_id"]]
            part["reserved"] += p_req["quantity"]

    scheduled_ids = sorted([c["id"] for c in candidates if c["status"] == "scheduled"])
    blocked_ids = sorted([c["id"] for c in candidates if c["status"] == "blocked"])
    unscheduled_ids = sorted([c["id"] for c in candidates if c["status"] == "unscheduled"])
    all_candidate_orders = sorted(candidates, key=lambda c: c["id"])

    return {
        "week_start": week_start_str,
        "scheduled": scheduled_ids,
        "blocked": blocked_ids,
        "unscheduled": unscheduled_ids,
        "orders": all_candidate_orders
    }
