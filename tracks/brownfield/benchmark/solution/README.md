# Brownfield Positive Control Reference Solution

This directory contains the reference solution patch for the brownfield track (`strategy=balanced` feature):

- `balanced.patch`: A unified diff applying cleanly against `tracks/brownfield/base/`.
  - Implements `strategy=balanced` planning using a greedy min-load strategy in `backend/app/planner.py`, breaking ties by technician ID ascending, then earliest feasible slot.
  - Adds `strategy: Optional[str] = Query(None)` to `POST /plan` in `backend/app/routes.py`, preserving backwards compatibility when omitted.
  - Adds `technician_load: Optional[Dict[str, int]] = Field(default=None)` to `PlanResponse` in `backend/app/schemas.py`, excluded from serialization when unset.

## Verification

To verify that the patch applies cleanly:
```bash
git apply --check tracks/brownfield/benchmark/solution/balanced.patch
```

### Local Test Execution (Positive & Negative Control)

1. **Untouched Base**:
   - Start uvicorn on a temporary copy (to avoid leaving `__pycache__` artifacts in the repository tree):
     ```bash
     cp -r tracks/brownfield/base /tmp/untouched-base
     cd /tmp/untouched-base/backend
     PYTHONDONTWRITEBYTECODE=1 <repo-root>/.cache/reference-venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8901
     ```
   - Regression suite (expected **58 / 58 pass**):
     ```bash
     CONTRACT_BASE_URL=http://127.0.0.1:8901 node --test-concurrency=1 --import tsx --test benchmark/contract-tests/*.test.ts
     ```
   - Change suite (expected **0 / 4 pass**, 0 points):
     ```bash
     CONTRACT_BASE_URL=http://127.0.0.1:8901 node --test-concurrency=1 --import tsx --test tracks/brownfield/benchmark/contract-tests/*.test.ts
     ```

2. **Patched Base (with `balanced.patch`)**:
   - Apply patch to a temporary copy of `tracks/brownfield/base/`:
     ```bash
     cp -r tracks/brownfield/base /tmp/patched-base
     git -C /tmp/patched-base apply <repo-root>/tracks/brownfield/benchmark/solution/balanced.patch
     ```
   - Start uvicorn:
     ```bash
     cd /tmp/patched-base/backend
     PYTHONDONTWRITEBYTECODE=1 <repo-root>/.cache/reference-venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8902
     ```
   - Regression suite (expected **58 / 58 pass**, 4.0 points):
     ```bash
     CONTRACT_BASE_URL=http://127.0.0.1:8902 node --test-concurrency=1 --import tsx --test benchmark/contract-tests/*.test.ts
     ```
   - Change suite (expected **4 / 4 pass**, 3.0 points):
     ```bash
     CONTRACT_BASE_URL=http://127.0.0.1:8902 node --test-concurrency=1 --import tsx --test tracks/brownfield/benchmark/contract-tests/*.test.ts
     ```

This directory is outside `tracks/brownfield/benchmark/contract-tests/` and therefore does not affect `BROWNFIELD_RUBRIC_ID_INPUTS` or the attempt container builds.
