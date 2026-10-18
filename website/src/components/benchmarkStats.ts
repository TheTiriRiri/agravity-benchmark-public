export interface RubricStats {
  max: number;
  hidden: number;
  auto: number;
  agent: number;
  human: number;
  judgeManual: number;
}

/**
 * Computes summary statistics from a rubric row set:
 * - max: sum of all numeric criteria maxima
 * - hidden: sum of hidden test criteria
 * - auto: sum of auto criteria (e.g. Local build, Diff locality)
 * - agent: sum of judge agent criteria
 * - human: sum of human evaluation criteria
 * - judgeManual: sum of agent + human criteria
 */
export function computeRubricStats(
  rows: readonly { max: number | null; scoredBy: string }[],
): RubricStats {
  const max = rows.reduce((sum, r) => sum + (r.max ?? 0), 0);
  const hidden = rows
    .filter((r) => r.scoredBy === 'hidden')
    .reduce((sum, r) => sum + (r.max ?? 0), 0);
  const auto = rows
    .filter((r) => r.scoredBy === 'auto')
    .reduce((sum, r) => sum + (r.max ?? 0), 0);
  const agent = rows
    .filter((r) => r.scoredBy === 'agent')
    .reduce((sum, r) => sum + (r.max ?? 0), 0);
  const human = rows
    .filter((r) => r.scoredBy === 'human')
    .reduce((sum, r) => sum + (r.max ?? 0), 0);
  return { max, hidden, auto, agent, human, judgeManual: agent + human };
}

/**
 * Counts newline characters in text, matching Unix `wc -l` behavior.
 */
export function countLines(text: string): number {
  return (text.match(/\n/g) || []).length;
}

/**
 * Extracts a scalar value for a top-level key in a YAML snippet.
 */
export function yamlScalar(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  if (!match) return null;

  const quoted = match[1].match(/^(["'])(.*?)\1/);
  if (quoted) return quoted[2];

  const value = match[1].replace(/\s+#.*$/, '').trim();
  return value === '' ? null : value;
}

/**
 * Extracts a required scalar value for a key in YAML, throwing a descriptive error if missing.
 */
export function requiredYamlScalar(source: string, key: string, filename: string): string {
  const val = yamlScalar(source, key);
  if (val === null) {
    throw new Error(`benchmark.astro: missing required field "${key}" in ${filename}`);
  }
  return val;
}

export interface RunnerMeta {
  judge: string;
  rubric: string;
  agyVersion: string | null;
  attempts: string | null;
}

/**
 * Parses runner YAML configuration, enforcing required fields (judge, rubric).
 */
export function parseRunnerMeta(yamlSource: string, filename: string): RunnerMeta {
  const judge = requiredYamlScalar(yamlSource, 'judge', filename);
  const rubric = requiredYamlScalar(yamlSource, 'rubric', filename);
  const agyVersion = yamlScalar(yamlSource, 'agyVersion');
  const attempts = yamlScalar(yamlSource, 'attempts');
  return { judge, rubric, agyVersion, attempts };
}
