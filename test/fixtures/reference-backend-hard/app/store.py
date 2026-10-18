"""In-memory state for the hard world. A restart or `reset()` returns the seed."""
import copy
import json
import os
from pathlib import Path

SCHEMA = "console-hard/1"

SEED = json.loads(Path(os.environ["REFERENCE_SEED_PATH"]).read_text())
if SEED.get("schema") != SCHEMA:
    # The mode travels with the data (spec §8.4.1): a classic seed, or any other
    # schema, must not boot the hard reference.
    raise SystemExit(f"hard reference: seed schema is {SEED.get('schema')!r}, expected {SCHEMA!r}")


class Store:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        data = copy.deepcopy(SEED)
        self.sites = {x["id"]: x for x in data["sites"]}
        self.assets = {x["id"]: x for x in data["assets"]}
        self.technicians = {x["id"]: x for x in data["technicians"]}
        self.parts = {x["id"]: x for x in data["parts"]}
        self.work_orders = {x["id"]: x for x in data["work_orders"]}

    def part_view(self, part: dict) -> dict:
        available = part["on_hand"] - part["reserved"]
        return {**part, "available": available, "low_stock": available < part["min_stock"]}

    def next_work_order_id(self) -> str:
        highest = max((int(i.split("-")[1]) for i in self.work_orders), default=0)
        return f"WO-{highest + 1:03d}"

    def site_of(self, order: dict) -> str:
        return self.assets[order["asset_id"]]["site_id"]

    def release(self, order: dict) -> None:
        for line in order["parts"]:
            self.parts[line["part_id"]]["reserved"] -= line["quantity"]

    def reserve(self, order: dict) -> None:
        for line in order["parts"]:
            self.parts[line["part_id"]]["reserved"] += line["quantity"]

    def consume(self, order: dict) -> None:
        for line in order["parts"]:
            self.parts[line["part_id"]]["on_hand"] -= line["quantity"]
            self.parts[line["part_id"]]["reserved"] -= line["quantity"]


store = Store()
