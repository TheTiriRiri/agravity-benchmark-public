/**
 * Replays one case against a live backend: POST /reset, run `setup` and
 * discard its replies, then run `script` and return every reply.
 *
 * Setup replies are discarded deliberately. They are scaffolding, and
 * comparing them would make a case fail for a defect in its own preparation
 * rather than in the rule it aims at.
 */
import type { FuzzCase, Step, StepReply } from "./case";

const REQUEST_TIMEOUT_MS = 10_000;

async function send(baseUrl: string, step: Step): Promise<StepReply> {
  const response = await fetch(`${baseUrl}/api/v1${step.path}`, {
    method: step.method,
    headers: step.body === undefined ? undefined : { "content-type": "application/json" },
    body: step.body === undefined ? undefined : JSON.stringify(step.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: normaliseErrorBody(body) };
}

/**
 * `prompt.md` §4 fixes `error.code` and the HTTP status; `error.message` is
 * "any non-empty human-readable string". Freezing the reference's wording
 * would therefore fail every backend on every 4xx step for a difference the
 * contract explicitly allows — and would do it silently, since a case that
 * provokes a 4xx by accident looks the same as one that means to.
 *
 * So an error body is reduced to its contractual part. The message's
 * *existence* is still contract and is checked by the hidden api-contract
 * suite, which is not this file's job.
 */
function normaliseErrorBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return body;
  return { error: { code: (error as { code?: unknown }).code } };
}

export async function replayCase(baseUrl: string, fuzzCase: FuzzCase): Promise<StepReply[]> {
  const reset = await send(baseUrl, { method: "POST", path: "/reset" });
  if (reset.status !== 200) {
    throw new Error(`POST /reset answered ${reset.status}`);
  }
  for (const step of fuzzCase.setup) await send(baseUrl, step);
  const replies: StepReply[] = [];
  for (const step of fuzzCase.script) replies.push(await send(baseUrl, step));
  return replies;
}
