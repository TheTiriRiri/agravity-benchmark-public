import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.store import store

client = TestClient(app)

@pytest.fixture(autouse=True)
def run_before_each_test():
    store.reset()

def test_health():
    res = client.get("/api/v1/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}

def test_reset():
    # Make a change
    res = client.patch("/api/v1/work-orders/WO-010", json={"status": "completed"})
    assert res.status_code == 200
    # Reset
    res_reset = client.post("/api/v1/reset")
    assert res_reset.status_code == 200
    assert res_reset.json() == {"status": "ok"}
    # Verify state is seed again
    wo = client.get("/api/v1/work-orders/WO-010").json()
    assert wo["status"] == "in_progress"

def test_get_sites():
    res = client.get("/api/v1/sites")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 2
    assert [s["id"] for s in data] == ["S-001", "S-002"]
    assert set(data[0].keys()) == {"id", "name"}

def test_get_assets():
    res = client.get("/api/v1/assets")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 8
    assert data[0]["id"] == "A-001"
    assert set(data[0].keys()) == {"id", "name", "site_id"}

def test_get_technicians():
    res = client.get("/api/v1/technicians")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 4
    assert data[0]["id"] == "T-001"
    assert set(data[0].keys()) == {"id", "name", "site_id", "skills", "shift_start", "shift_end"}

def test_get_parts():
    res = client.get("/api/v1/parts")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 10
    # Check part computation
    p1 = [p for p in data if p["id"] == "P-001"][0]
    assert p1["on_hand"] == 6
    assert p1["reserved"] == 0
    assert p1["min_stock"] == 2
    assert p1["available"] == 6
    assert p1["low_stock"] is False

    # P-005: on_hand=2, reserved=1, min_stock=1 => available=1, low_stock=False
    p5 = [p for p in data if p["id"] == "P-005"][0]
    assert p5["available"] == 1
    assert p5["low_stock"] is False

    # P-003: on_hand=1, reserved=0, min_stock=2 => available=1, low_stock=True
    p3 = [p for p in data if p["id"] == "P-003"][0]
    assert p3["available"] == 1
    assert p3["low_stock"] is True
    assert set(p1.keys()) == {"id", "name", "on_hand", "reserved", "min_stock", "available", "low_stock"}

def test_get_work_orders_filters():
    res_all = client.get("/api/v1/work-orders")
    assert res_all.status_code == 200
    assert len(res_all.json()) == 14

    # Filter status
    res_status = client.get("/api/v1/work-orders?status=completed")
    assert res_status.status_code == 200
    assert len(res_status.json()) == 1
    assert res_status.json()[0]["id"] == "WO-008"

    # Filter priority
    res_pri = client.get("/api/v1/work-orders?priority=critical")
    assert res_pri.status_code == 200
    assert len(res_pri.json()) == 2
    assert [w["id"] for w in res_pri.json()] == ["WO-001", "WO-014"]

    # Filter site_id
    res_site = client.get("/api/v1/work-orders?site_id=S-002")
    assert res_site.status_code == 200
    site2_orders = res_site.json()
    # Assets A-005 to A-008 belong to S-002
    assert len(site2_orders) == 6

    # Combined filter
    res_comb = client.get("/api/v1/work-orders?site_id=S-002&status=in_progress")
    assert res_comb.status_code == 200
    assert len(res_comb.json()) == 1
    assert res_comb.json()[0]["id"] == "WO-010"

def test_post_work_order_success():
    payload = {
        "title": "Emergency belt check",
        "asset_id": "A-001",
        "required_skill": "mechanical",
        "duration_minutes": 60,
        "earliest_start": "2026-10-06",
        "due_date": "2026-10-07",
        "priority": "high",
        "parts": [{"part_id": "P-001", "quantity": 1}]
    }
    res = client.post("/api/v1/work-orders", json=payload)
    assert res.status_code == 201
    wo = res.json()
    assert wo["id"] == "WO-015"
    assert wo["title"] == "Emergency belt check"
    assert wo["status"] == "open"
    assert wo["status_reason"] is None
    assert wo["technician_id"] is None
    assert wo["scheduled_start"] is None
    assert wo["scheduled_end"] is None

    # Check next is WO-016
    res2 = client.post("/api/v1/work-orders", json=payload)
    assert res2.status_code == 201
    assert res2.json()["id"] == "WO-016"

def test_post_work_order_validations():
    base_payload = {
        "title": "Test Order",
        "asset_id": "A-001",
        "required_skill": "electrical",
        "duration_minutes": 120,
        "earliest_start": "2026-10-05",
        "due_date": "2026-10-06",
        "priority": "medium",
        "parts": []
    }

    # Missing field
    for req_field in ["title", "asset_id", "required_skill", "duration_minutes", "earliest_start", "due_date", "priority"]:
        p = dict(base_payload)
        del p[req_field]
        res = client.post("/api/v1/work-orders", json=p)
        assert res.status_code == 422
        assert res.json()["error"]["code"] == "validation_error"

    # Empty title
    p = dict(base_payload, title="   ")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"

    # Invalid duration
    p = dict(base_payload, duration_minutes=15)
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422
    p = dict(base_payload, duration_minutes=500)
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422
    p = dict(base_payload, duration_minutes=45)
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # Malformed date
    p = dict(base_payload, earliest_start="2026-13-45")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422
    p = dict(base_payload, due_date="invalid-date")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # due_date before earliest_start
    p = dict(base_payload, earliest_start="2026-10-06", due_date="2026-10-05")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # Invalid priority
    p = dict(base_payload, priority="super-critical")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # Invalid quantity
    p = dict(base_payload, parts=[{"part_id": "P-001", "quantity": 0}])
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # Duplicate part
    p = dict(base_payload, parts=[{"part_id": "P-001", "quantity": 1}, {"part_id": "P-001", "quantity": 2}])
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    # Non-existent asset or part
    p = dict(base_payload, asset_id="A-999")
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

    p = dict(base_payload, parts=[{"part_id": "P-999", "quantity": 1}])
    res = client.post("/api/v1/work-orders", json=p)
    assert res.status_code == 422

def test_patch_work_order_transitions():
    # 404 on unknown id
    res = client.patch("/api/v1/work-orders/WO-999", json={"status": "cancelled"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"

    # 422 on invalid status
    res = client.patch("/api/v1/work-orders/WO-001", json={"status": "invalid_status"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"

    # Plan week to schedule WO-001
    plan_res = client.post("/api/v1/plan?week_start=2026-10-05")
    assert plan_res.status_code == 200
    wo1 = client.get("/api/v1/work-orders/WO-001").json()
    assert wo1["status"] == "scheduled"
    assert wo1["technician_id"] is not None

    # Invalid transition: scheduled -> completed is 409
    res_bad = client.patch("/api/v1/work-orders/WO-001", json={"status": "completed"})
    assert res_bad.status_code == 409
    assert res_bad.json()["error"]["code"] == "invalid_transition"

    # Valid: scheduled -> in_progress
    res_ip = client.patch("/api/v1/work-orders/WO-001", json={"status": "in_progress"})
    assert res_ip.status_code == 200
    assert res_ip.json()["status"] == "in_progress"
    assert res_ip.json()["technician_id"] == wo1["technician_id"]

    # Valid: in_progress -> completed (on_hand -= qty, reserved -= qty)
    # Check P-004 stock before completion
    p4_before = [p for p in client.get("/api/v1/parts").json() if p["id"] == "P-004"][0]
    res_comp = client.patch("/api/v1/work-orders/WO-001", json={"status": "completed"})
    assert res_comp.status_code == 200
    p4_after = [p for p in client.get("/api/v1/parts").json() if p["id"] == "P-004"][0]
    assert p4_after["on_hand"] == p4_before["on_hand"] - 1
    assert p4_after["reserved"] == p4_before["reserved"] - 1

    # Open -> cancelled
    wo2 = client.get("/api/v1/work-orders/WO-002").json()
    # Since plan scheduled WO-002, let's create a new open work order
    new_wo = client.post("/api/v1/work-orders", json={
        "title": "Open cancel test",
        "asset_id": "A-001",
        "required_skill": "mechanical",
        "duration_minutes": 60,
        "earliest_start": "2026-10-05",
        "due_date": "2026-10-05",
        "priority": "low",
        "parts": []
    }).json()
    res_cancel_open = client.patch(f"/api/v1/work-orders/{new_wo['id']}", json={"status": "cancelled"})
    assert res_cancel_open.status_code == 200
    assert res_cancel_open.json()["status"] == "cancelled"

    # in_progress -> cancelled releases reservation and clears slot fields
    wo10 = client.get("/api/v1/work-orders/WO-010").json()
    assert wo10["status"] == "in_progress"
    p5_before = [p for p in client.get("/api/v1/parts").json() if p["id"] == "P-005"][0]
    res_cancel_ip = client.patch("/api/v1/work-orders/WO-010", json={"status": "cancelled"})
    assert res_cancel_ip.status_code == 200
    wo10_cancelled = res_cancel_ip.json()
    assert wo10_cancelled["status"] == "cancelled"
    assert wo10_cancelled["technician_id"] is None
    assert wo10_cancelled["scheduled_start"] is None
    assert wo10_cancelled["scheduled_end"] is None
    p5_after = [p for p in client.get("/api/v1/parts").json() if p["id"] == "P-005"][0]
    assert p5_after["reserved"] == p5_before["reserved"] - 1

def test_plan_endpoint_and_validations():
    # Missing week_start
    res = client.post("/api/v1/plan")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"

    # Malformed week_start
    res = client.post("/api/v1/plan?week_start=not-a-date")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"

    # Not a Monday (2026-10-06 is Tuesday)
    res = client.post("/api/v1/plan?week_start=2026-10-06")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "validation_error"

    # Valid plan
    res = client.post("/api/v1/plan?week_start=2026-10-05")
    assert res.status_code == 200
    data = res.json()
    assert data["week_start"] == "2026-10-05"
    assert set(data.keys()) == {"week_start", "scheduled", "blocked", "unscheduled", "orders"}
    all_candidates = data["scheduled"] + data["blocked"] + data["unscheduled"]
    assert sorted(all_candidates) == sorted([o["id"] for o in data["orders"]])
    assert len(all_candidates) == len(set(all_candidates))

def test_schedule_endpoint():
    # Plan first
    client.post("/api/v1/plan?week_start=2026-10-05")

    # Missing week_start
    res = client.get("/api/v1/schedule")
    assert res.status_code == 422

    # Not Monday
    res = client.get("/api/v1/schedule?week_start=2026-10-07")
    assert res.status_code == 422

    # Valid schedule
    res = client.get("/api/v1/schedule?week_start=2026-10-05")
    assert res.status_code == 200
    data = res.json()
    assert data["week_start"] == "2026-10-05"
    assert len(data["technicians"]) == 4
    assert [t["technician_id"] for t in data["technicians"]] == ["T-001", "T-002", "T-003", "T-004"]
    t1 = data["technicians"][0]
    assert t1["technician_id"] == "T-001"
    assert len(t1["assignments"]) > 0
    a1 = t1["assignments"][0]
    assert set(a1.keys()) == {"work_order_id", "title", "asset_id", "status", "scheduled_start", "scheduled_end"}
