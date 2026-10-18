/**
 * Parser for pytest summary output (pytest 8 format).
 * Handles summary lines like:
 * - "3 passed in 0.12s"
 * - "1 failed, 2 passed, 1 error in 0.30s"
 * - "no tests ran in 0.01s"
 * - "2 errors in 0.05s"
 * - "=== 1 failed, 2 passed, 1 error, 3 warnings in 0.30s ==="
 */

export interface ParsedPytestSummary {
  passed: number;
  failed: number;
  errors: number;
}

export function parsePytestSummary(output: string): ParsedPytestSummary {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/\b(?:passed|failed|errors?|no tests ran)\b/.test(line) && /\bin \d+(\.\d+)?s\b/.test(line)) {
      const passedMatch = line.match(/\b(\d+)\s+passed\b/);
      if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);

      const failedMatch = line.match(/\b(\d+)\s+failed\b/);
      if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);

      const errorsMatch = line.match(/\b(\d+)\s+errors?\b/);
      if (errorsMatch) errors = Number.parseInt(errorsMatch[1], 10);

      return { passed, failed, errors };
    }
  }

  // Fallback if "in X.XXs" is missing
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/\b(\d+\s+passed|\d+\s+failed|\d+\s+errors?|no tests ran)\b/.test(line)) {
      const passedMatch = line.match(/\b(\d+)\s+passed\b/);
      if (passedMatch) passed = Number.parseInt(passedMatch[1], 10);

      const failedMatch = line.match(/\b(\d+)\s+failed\b/);
      if (failedMatch) failed = Number.parseInt(failedMatch[1], 10);

      const errorsMatch = line.match(/\b(\d+)\s+errors?\b/);
      if (errorsMatch) errors = Number.parseInt(errorsMatch[1], 10);

      if (passed > 0 || failed > 0 || errors > 0 || line.includes("no tests ran")) {
        return { passed, failed, errors };
      }
    }
  }

  return { passed: 0, failed: 0, errors: 0 };
}
