# Meridian Maintenance Console

A full-stack web application that plans preventive-maintenance work orders for technicians across industrial sites.

## Stack and Run Contract

### Backend

Python 3.11, FastAPI, Pydantic (in-memory state only).

From inside `backend/`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 5100
```

### Frontend

React, TypeScript, Vite, Tailwind CSS.

From inside `frontend/`:

```bash
npm install && npm run build
npm run dev
```

The dev server runs on port 5173 and proxies `/api` requests to `http://localhost:5100`.

## Architecture

- `backend/`:
  - `app/main.py`: FastAPI application exposing ASGI object `app`, CORS, and strict error format handlers.
  - `app/schemas.py`: Pydantic request/response models.
  - `app/store.py`: In-memory thread-safe store with seed data restoration.
  - `app/planner.py`: Deterministic 30-minute grid preventive maintenance planning engine.
  - `app/routes.py`: REST endpoints under `/api/v1` (`/health`, `/reset`, `/sites`, `/assets`, `/technicians`, `/parts`, `/work-orders`, `/plan`, `/schedule`).
  - `tests/test_api.py`: Automated pytest test suite covering all specifications, validations, transitions, and deterministic planning.
- `frontend/`:
  - `src/types/api.ts`: TypeScript interfaces for all domain resources and API contracts.
  - `src/services/api.ts`: Centralized HTTP API client with structured error handling.
  - `src/views/DashboardView.tsx`: Overview of work orders by status, technician workload, and low-stock alerts.
  - `src/views/ScheduleView.tsx`: Interactive weekly dispatch timeline, plan generator, and blocked/unscheduled exception lists.
  - `src/views/WorkOrdersView.tsx`: Registry table with status/priority/site filters, creation modal with API validation display, and legal transition actions.
  - `src/views/InventoryView.tsx`: Spare parts table with on hand, reserved, available, min stock, and low stock warnings.
