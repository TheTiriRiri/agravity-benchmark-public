"""The deterministic weekly planner of the hard world: rules 1-11 of spec §8.4.4."""
from datetime import date, datetime, timedelta
from itertools import combinations

from .mutants import mutant
from .store import Store

PRIORITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
GRID = timedelta(minutes=30)
DAILY_CAP_MINUTES = 480
HOLDS_SLOT = ("scheduled", "in_progress", "completed")
FMT = "%Y-%m-%dT%H:%M:%S"


def _at(day: date, hhmm: str) -> datetime:
    hours, minutes = hhmm.split(":")
    return datetime(day.year, day.month, day.day, int(hours), int(minutes))


def _parse(stamp: str) -> datetime:
    return datetime.strptime(stamp, FMT)


def _minutes(delta: timedelta) -> int:
    return int(delta.total_seconds() // 60)


def _first_start(order: dict) -> datetime:
    return _parse(order["segments"][0]["start"])


def _sort_key(order: dict):
    """Rule 4: earliest due date first (EDF), then priority, then id."""
    rank, due, number = PRIORITY_RANK[order["priority"]], order["due_date"], int(order["id"].split("-")[1])
    if mutant("edf_priority_first") or mutant("off_edf"):
        return (rank, due, number)
    if mutant("priority_ignored"):
        return (due, number)
    if mutant("due_date_ignored"):
        return (rank, number)
    if mutant("id_order_reversed"):
        return (due, rank, -number)
    return (due, rank, number)


def _crew_size(order: dict) -> int:
    return 1 if mutant("crew_single") or mutant("off_crews") else order["crew_size"]


def _travel(store: Store, a: str, b: str) -> int:
    if mutant("off_travel"):
        return 0
    return store.sites[a]["travel_minutes"][b]


class Planner:
    """One plan of one week. `excluded` hides orders from occupancy while a preemption round tries a prefix."""

    def __init__(self, store: Store, monday: date) -> None:
        self.store = store
        self.monday = monday
        self.friday = monday + timedelta(days=4)
        self.excluded: set[str] = set()

    # -- occupancy --------------------------------------------------------

    def _day_load(self, technician_id: str, day: date) -> list[tuple[datetime, datetime, str]]:
        """Every segment the technician holds on `day`, with its site: rule 7's "assignments"."""
        statuses = ("scheduled",) if mutant("fixed_load_ignored") else HOLDS_SLOT
        load = []
        for o in self.store.work_orders.values():
            if o["id"] in self.excluded or o["status"] not in statuses or technician_id not in o["technician_ids"]:
                continue
            for segment in o["segments"]:
                start = _parse(segment["start"])
                if start.date() == day:
                    load.append((start, _parse(segment["end"]), self.store.site_of(o)))
        return sorted(load)

    def _feasible(self, technician: dict, day: date, start: datetime, end: datetime, site: str) -> bool:
        """Rule 7 for one technician: shift, absences, holidays, overlap, travel and the cap."""
        shift_start, shift_end = _at(day, technician["shift_start"]), _at(day, technician["shift_end"])
        if mutant("shift_ignored"):
            shift_end = _at(day, "23:30")
        if mutant("span_days"):
            shift_end += timedelta(days=1)
        if start < shift_start or end > shift_end:
            return False
        if not (mutant("off_holidays") or mutant("holiday_ignored")) and day.isoformat() in self.store.sites[site]["holidays"]:
            return False
        if not (mutant("off_absences") or mutant("absence_ignored")):
            for absence in technician["absences"]:
                if absence["date"] != day.isoformat():
                    continue
                a_from, a_to = _at(day, absence["from"]), _at(day, absence["to"])
                touching = mutant("absence_touch_blocks")
                if (start <= a_to and end >= a_from) if touching else (start < a_to and end > a_from):
                    return False
        load = self._day_load(technician["id"], day)
        if not mutant("overlap_allowed") and any(start < e and end > s for s, e, _ in load):
            return False
        sequence = sorted(load + [(start, end, site)])
        at = sequence.index((start, end, site))
        pairs = list(zip(sequence, sequence[1:]))
        if mutant("travel_previous_only"):
            pairs = [(sequence[at - 1], sequence[at])] if at > 0 else []
        if mutant("travel_off"):
            pairs = []  # no gap check; travel still counts toward the cap, unlike off_travel
        for (_, prev_end, prev_site), (next_start, _, next_site) in pairs:
            gap = _minutes(next_start - prev_end)
            if gap < 0 and mutant("overlap_allowed"):
                continue  # an overlap is also a negative gap: the mutant must switch off both views of it
            if gap < _travel(self.store, prev_site, next_site):
                return False
        if mutant("cap_off"):
            return True
        worked = sum(_minutes(e - s) for s, e, _ in sequence)
        travelled = 0 if mutant("travel_cap_off") else sum(
            _travel(self.store, a[2], b[2]) for a, b in zip(sequence, sequence[1:])
        )
        return worked + travelled <= DAILY_CAP_MINUTES

    def _crew_feasible(self, crew: tuple[dict, ...], day: date, start: datetime, end: datetime, site: str) -> bool:
        members = crew[:1] if mutant("crew_check_first_only") else crew
        return all(self._feasible(t, day, start, end, site) for t in members)

    # -- rules 6 and 8 ----------------------------------------------------

    def qualified(self, order: dict) -> list[dict]:
        site = self.store.site_of(order)
        chosen = []
        for technician in sorted(self.store.technicians.values(), key=lambda t: t["id"]):
            sites = technician["site_ids"][:1] if mutant("site_first_only") else technician["site_ids"]
            if (mutant("site_off") or site in sites) and (mutant("skill_off") or order["required_skill"] in technician["skills"]):
                chosen.append(technician)
        return chosen

    def window(self, order: dict) -> list[date]:
        """The clipped window: weekdays of [max(monday, earliest_start), min(friday, due_date)]."""
        first, last = date.fromisoformat(order["earliest_start"]), date.fromisoformat(order["due_date"])
        if not mutant("window_unclipped"):
            first, last = max(self.monday, first), min(self.friday, last)
        days = [first + timedelta(days=n) for n in range((last - first).days + 1)]
        return [d for d in days if d.weekday() < 5 or mutant("window_unclipped")]

    def _crews(self, order: dict) -> list[tuple[dict, ...]]:
        crews = list(combinations(self.qualified(order), _crew_size(order)))
        tie_reversed = mutant("crew_tie_reversed") if _crew_size(order) == 2 else mutant("tech_tie_reversed")
        return crews[::-1] if tie_reversed else crews

    def _unsplit(self, order: dict) -> tuple[tuple[str, ...], list[tuple[datetime, datetime]]] | None:
        """Rule 8.1: the earliest start over every crew, ties to the lowest id list."""
        duration = timedelta(minutes=order["duration_minutes"])
        site = self.store.site_of(order)
        best = None
        for crew in self._crews(order):
            found = None
            for day in self.window(order):
                start = _at(day, "00:00")
                while start + duration <= _at(day, "00:00") + timedelta(days=2 if mutant("span_days") else 1):
                    if self._crew_feasible(crew, day, start, start + duration, site):
                        found = start
                        if not mutant("not_earliest"):
                            break
                    start += GRID
                if found:
                    break
            if found is not None and (best is None or found < best[0]):
                best = (found, crew)
        if best is None:
            return None
        start, crew = best
        return tuple(t["id"] for t in crew), [(start, start + duration)]

    def _options(self, order: dict, crew: tuple[dict, ...], day: date, minimum: int, longest: int) -> list[tuple[datetime, int]]:
        """Every feasible (start, length) on one day, in the split key's order: earlier start, then longer."""
        site = self.store.site_of(order)
        options = []
        start = _at(day, "00:00")
        while start < _at(day, "00:00") + timedelta(days=1):
            for length in range(longest, minimum - 1, -30):
                if self._crew_feasible(crew, day, start, start + timedelta(minutes=length), site):
                    options.append((start, length))
            start += GRID
        if mutant("split_short_first"):
            options.sort(key=lambda o: (o[0], o[1]))
        return options

    def _split_for(self, order: dict, crew: tuple[dict, ...], k: int) -> list[tuple[datetime, int]] | None:
        """The minimal (s1, -l1, s2, -l2, ...) for this crew with exactly k segments on distinct days."""
        minimum = 30 if mutant("split_min_ignored") else order["min_segment_minutes"]
        days = self.window(order)
        per_day = {d: self._options(order, crew, d, minimum, min(order["duration_minutes"], DAILY_CAP_MINUTES)) for d in days}
        # `per_day` is fixed for this call, so (after, remaining, left) alone determines the
        # best remainder: memoising it turns the otherwise-exponential backtrack (every day's
        # options against every later day's) into one pass per distinct state.
        memo: dict[tuple[int, int, int], list[tuple[datetime, int]] | None] = {}

        def search(after: int, remaining: int, left: int) -> list[tuple[datetime, int]] | None:
            if left == 0:
                return [] if remaining == 0 else None
            key = (after, remaining, left)
            if key in memo:
                return memo[key]
            result = None
            for index in range(after, len(days)):
                for start, length in per_day[days[index]]:
                    if length > remaining - minimum * (left - 1):
                        continue
                    rest = search(index + 1, remaining - length, left - 1)
                    if rest is not None:
                        result = [(start, length)] + rest
                        break
                if result is not None:
                    break
            memo[key] = result
            return result

        return search(0, order["duration_minutes"], k)

    def _split(self, order: dict):
        """Rule 8.2: fewest segments, then the earliest first start, then the lowest id list, then the rest of the key."""
        for k in range(2, len(self.window(order)) + 1):
            best = None
            for crew in self._crews(order):
                segments = self._split_for(order, crew, k)
                if segments is None:
                    continue
                ids = tuple(t["id"] for t in crew)
                if best is None or segments[0][0] < best[1][0][0]:
                    best = (ids, segments)
            if best is not None:
                ids, segments = best
                return ids, [(s, s + timedelta(minutes=l)) for s, l in segments]
        return None

    def placement(self, order: dict):
        splits = order["splittable"] and not mutant("off_splitting")
        unsplit = self._unsplit(order)
        if mutant("split_eager") and splits:
            split = self._split(order)
            if split is not None and (unsplit is None or split[1][0][0] < unsplit[1][0][0]):
                return split
        if unsplit is not None or not splits:
            return unsplit
        return self._split(order)

    # -- rules 5 and 9 ----------------------------------------------------

    def parts_ok(self, order: dict, freed: dict[str, int] | None = None) -> bool:
        if mutant("parts_check_off"):
            return True
        freed = freed or {}
        return all(
            line["quantity"] <= self.store.parts[line["part_id"]]["on_hand"] - self.store.parts[line["part_id"]]["reserved"] + freed.get(line["part_id"], 0)
            for line in order["parts"]
        )

    def assign(self, order: dict, found) -> None:
        ids, segments = found
        order.update(
            status="scheduled",
            status_reason=None,
            technician_ids=sorted(ids),
            segments=[{"start": s.strftime(FMT), "end": e.strftime(FMT)} for s, e in segments],
        )
        if not mutant("no_reservation"):
            self.store.reserve(order)

    def process(self, order: dict) -> None:
        """Rules 5-9 for one order."""
        if not self.parts_ok(order):
            order.update(status="blocked", status_reason="parts_unavailable")
            return
        if len(self.qualified(order)) < _crew_size(order):
            order.update(status="unscheduled", status_reason="no_qualified_technician")
            return
        found = self.placement(order)
        if found is None:
            order.update(status="unscheduled", status_reason="no_capacity")
            return
        self.assign(order, found)

    # -- rule 11 ----------------------------------------------------------

    def _victims(self, subject: dict, chosen: list[dict]) -> list[dict]:
        rank = PRIORITY_RANK[subject["priority"]]
        qualified = {t["id"] for t in self.qualified(subject)}
        window = {d.isoformat() for d in self.window(subject)}
        victims = []
        for o in chosen:
            if o["status"] != "scheduled" or PRIORITY_RANK[o["priority"]] <= rank:
                continue
            related = any(t in qualified for t in o["technician_ids"]) and any(s["start"][:10] in window for s in o["segments"])
            if related or mutant("preempt_unfiltered"):
                victims.append(o)
        victims.sort(key=lambda o: int(o["id"].split("-")[1]), reverse=True)
        victims.sort(key=lambda o: o["due_date"], reverse=True)
        victims.sort(key=lambda o: PRIORITY_RANK[o["priority"]], reverse=True)
        return victims

    def _evict(self, order: dict) -> None:
        self.store.release(order)
        order.update(status="open", status_reason=None, technician_ids=[], segments=[])

    def preempt(self, chosen: list[dict]) -> None:
        evicted: list[dict] = []
        subjects = [o for o in sorted(chosen, key=_sort_key) if o["priority"] == "critical" and o["status_reason"] == "no_capacity"]
        for subject in subjects:
            if not mutant("preempt_parts_after") and not self.parts_ok(subject):
                continue
            found = self.placement(subject)
            prefix: list[dict] = []
            if found is None:
                victims = self._victims(subject, chosen)
                lengths = [len(victims)] if mutant("preempt_evict_all") else range(1, len(victims) + 1)
                for n in lengths:
                    self.excluded = {o["id"] for o in victims[:n]}
                    found = self.placement(subject)
                    self.excluded = set()
                    if found is not None:
                        prefix = victims[:n]
                        break
            if found is None:
                continue
            for victim in prefix:
                self._evict(victim)
                evicted.append(victim)
            if mutant("preempt_parts_after") and not self.parts_ok(subject):
                continue
            self.assign(subject, found)
            if mutant("preempt_reprocess_each_round"):
                for order in sorted(evicted, key=_sort_key):
                    self.process(order)
                evicted = []
        if mutant("preempt_no_reprocess"):
            return
        for order in sorted(evicted, key=_sort_key):
            self.process(order)


def candidates(store: Store, monday: date) -> list[dict]:
    friday = monday + timedelta(days=4)
    chosen = []
    for order in store.work_orders.values():
        if order["status"] in ("open", "blocked", "unscheduled"):
            if date.fromisoformat(order["earliest_start"]) <= friday and date.fromisoformat(order["due_date"]) >= monday:
                chosen.append(order)
        elif order["status"] == "scheduled":
            if mutant("other_weeks_pulled") or monday <= _first_start(order).date() <= friday:
                chosen.append(order)
    return chosen


def _reset(store: Store, order: dict) -> None:
    if order["status"] == "scheduled":
        store.release(order)
    order.update(status="open", status_reason=None, technician_ids=[], segments=[])


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
    planner = Planner(store, monday)
    chosen = candidates(store, monday)
    if not mutant("reset_interleaved"):
        for order in chosen:
            _reset(store, order)
    for order in sorted(chosen, key=_sort_key):
        if mutant("reset_interleaved"):
            _reset(store, order)
        planner.process(order)
    if not mutant("off_preemption"):
        planner.preempt(chosen)
    ordered = sorted(chosen, key=lambda o: o["id"])
    return {
        "week_start": monday.isoformat(),
        "scheduled": [o["id"] for o in ordered if o["status"] == "scheduled"],
        "blocked": [o["id"] for o in ordered if o["status"] == "blocked"],
        "unscheduled": [o["id"] for o in ordered if o["status"] == "unscheduled"],
        "orders": ordered,
    }


def schedule_for(store: Store, monday: date) -> dict:
    """One assignment per (technician, segment) whose start falls in the week."""
    friday = monday + timedelta(days=4)
    technicians = []
    for technician in sorted(store.technicians.values(), key=lambda t: t["id"]):
        rows = []
        for o in store.work_orders.values():
            if o["status"] not in HOLDS_SLOT or technician["id"] not in o["technician_ids"]:
                continue
            for segment in o["segments"]:
                if monday <= _parse(segment["start"]).date() <= friday:
                    rows.append(
                        {
                            "work_order_id": o["id"],
                            "title": o["title"],
                            "asset_id": o["asset_id"],
                            "status": o["status"],
                            "scheduled_start": segment["start"],
                            "scheduled_end": segment["end"],
                        }
                    )
        rows.sort(key=lambda r: (r["scheduled_start"], r["work_order_id"]))
        technicians.append({"technician_id": technician["id"], "assignments": rows})
    return {"week_start": monday.isoformat(), "technicians": technicians}
