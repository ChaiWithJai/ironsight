import type { Config, Context } from '@netlify/functions';
import { existingLearnerId, resolveLearner } from './lib/session.mts';
import {
  createRunRepository,
  type Evidence,
  type RunRepository,
} from './lib/run-store.mts';

/**
 * Versioned course-runs API (v1). One Function owns the whole durable-progress
 * surface so a learner's run, attempts and reflections share a single
 * ownership check and rate-limit window:
 *
 *   POST /api/v1/runs                     start or resume the active run
 *   GET  /api/v1/runs/:id                 full run state (attempts + reflections)
 *   POST /api/v1/runs/:id/complete        mark the run completed
 *   POST /api/v1/runs/:id/attempts        submit a mission attempt (idempotent)
 *   POST /api/v1/runs/:id/reflections     save/replace a reflection
 *
 * The version lives in the path (`/api/v1/...`), not a header, so a stable
 * bookmarked/cached client keeps talking to the contract it was built against
 * while a `/api/v2` can ship beside it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_768;
const MAX_EVIDENCE_BYTES = 16_384;
const MAX_EVIDENCE_KEYS = 64;
const MAX_TOKEN = 128; // ids, versions, keys
const MAX_MISSION_ID = 64;
const MAX_REFLECTION_CHARS = 4_000;
const MAX_STRING_VALUE = 512; // a single string evidence value

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

function fail(code: string, message: string, status: number, extra?: Record<string, unknown>): Response {
  return json({ code, message, ...extra }, status);
}

/** Reads a size-capped JSON object body. */
async function readBody(request: Request): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return { ok: false, response: fail('PAYLOAD_TOO_LARGE', 'Request body is too large.', 413) };
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: fail('INVALID_JSON', 'Could not read request body.', 400) };
  }
  if (raw.length === 0) return { ok: true, value: {} };
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, response: fail('PAYLOAD_TOO_LARGE', 'Request body is too large.', 413) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, response: fail('INVALID_JSON', 'Request body must be valid JSON.', 400) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: fail('INVALID_BODY', 'Request body must be a JSON object.', 400) };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function token(value: unknown, field: string, max: number, issues: string[]): string {
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${field} is required`);
    return '';
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) issues.push(`${field} is required`);
  if (cleaned.length > max) issues.push(`${field} must be ${max} characters or fewer`);
  return cleaned.slice(0, max);
}

/**
 * Structured evidence: a flat map of primitive values, matching the academy's
 * MissionEvidence type. Rejecting nesting and capping counts/sizes keeps a
 * forged or runaway payload from becoming an abuse vector.
 */
function evidenceOf(value: unknown, issues: string[]): Evidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push('evidence must be an object');
    return {};
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_EVIDENCE_KEYS) issues.push(`evidence must have ${MAX_EVIDENCE_KEYS} keys or fewer`);
  const out: Evidence = {};
  for (const [key, raw] of entries.slice(0, MAX_EVIDENCE_KEYS)) {
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        issues.push(`evidence.${key} must be a finite number`);
        continue;
      }
      out[key] = raw;
    } else if (typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'string') {
      out[key] = raw.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_STRING_VALUE);
    } else {
      issues.push(`evidence.${key} must be a number, string or boolean`);
    }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(out)).byteLength;
  if (bytes > MAX_EVIDENCE_BYTES) issues.push(`evidence must be ${MAX_EVIDENCE_BYTES} bytes or fewer`);
  return out;
}

export function createRunsHandler(repository: RunRepository) {
  return async (request: Request, context: Pick<Context, 'params'>): Promise<Response> => {
    try {
      const method = request.method;
      const path = new URL(request.url).pathname.replace(/\/+$/, '');
      const id = context.params.id;
      // The sub-resource is the trailing static segment after the id, if any.
      const action = id ? path.split(`/${id}/`)[1]?.split('/')[0] ?? '' : '';

      // ---- POST /api/v1/runs — start or resume -----------------------------
      if (method === 'POST' && !id) {
        const body = await readBody(request);
        if (!body.ok) return body.response;
        const issues: string[] = [];
        const courseVersion = token(body.value.courseVersion, 'courseVersion', MAX_TOKEN, issues);
        let worldId: string | null = null;
        if (body.value.worldId != null) {
          if (typeof body.value.worldId !== 'string' || !UUID.test(body.value.worldId)) {
            issues.push('worldId must be a world uuid');
          } else {
            worldId = body.value.worldId;
          }
        }
        if (issues.length) return fail('INVALID_RUN', 'Could not start the run.', 422, { issues });

        const learner = resolveLearner(request);
        const run = await repository.startRun({ learnerId: learner.id, courseVersion, worldId });
        const headers: HeadersInit = {};
        if (learner.setCookie) headers['set-cookie'] = learner.setCookie;
        return json({ run }, run.resumed ? 200 : 201, headers);
      }

      if (!id || !UUID.test(id)) {
        if (id) return fail('INVALID_RUN_ID', 'Run id is invalid.', 400);
        return fail('METHOD_NOT_ALLOWED', 'Use POST /api/v1/runs to start a run.', 405, undefined);
      }

      // Every id-scoped route requires an identity and run ownership. Identity
      // is never minted on a read/sub-resource — only POST /runs bootstraps it.
      const learnerId = existingLearnerId(request);
      if (!learnerId) return fail('NO_SESSION', 'Start a run before recording progress.', 401);
      const run = await repository.getRun(id);
      if (!run) return fail('RUN_NOT_FOUND', 'That run does not exist.', 404);
      if (run.learnerId !== learnerId) return fail('FORBIDDEN', 'This run belongs to another learner.', 403);

      // ---- GET /api/v1/runs/:id --------------------------------------------
      if (method === 'GET' && !action) {
        return json({ run });
      }

      // ---- POST /api/v1/runs/:id/complete ----------------------------------
      if (method === 'POST' && action === 'complete') {
        const completed = await repository.completeRun(id, learnerId);
        if (!completed) return fail('RUN_NOT_COMPLETABLE', 'This run cannot be completed.', 409);
        return json({ run: completed });
      }

      // ---- POST /api/v1/runs/:id/attempts ----------------------------------
      if (method === 'POST' && action === 'attempts') {
        const body = await readBody(request);
        if (!body.ok) return body.response;
        const issues: string[] = [];
        const missionId = token(body.value.missionId, 'missionId', MAX_MISSION_ID, issues);
        const idempotencyKey = token(body.value.idempotencyKey, 'idempotencyKey', MAX_TOKEN, issues);
        const evaluatorVersion = token(body.value.evaluatorVersion, 'evaluatorVersion', MAX_TOKEN, issues);
        if (typeof body.value.passed !== 'boolean') issues.push('passed must be a boolean');
        const evidence = evidenceOf(body.value.evidence, issues);
        if (issues.length) return fail('INVALID_ATTEMPT', 'Could not record the attempt.', 422, { issues });

        const attempt = await repository.recordAttempt({
          runId: id,
          missionId,
          idempotencyKey,
          evaluatorVersion,
          passed: body.value.passed as boolean,
          evidence,
        });
        return json({ attempt }, attempt.replayed ? 200 : 201);
      }

      // ---- POST /api/v1/runs/:id/reflections -------------------------------
      if (method === 'POST' && action === 'reflections') {
        const body = await readBody(request);
        if (!body.ok) return body.response;
        const issues: string[] = [];
        const promptId = token(body.value.promptId, 'promptId', MAX_MISSION_ID, issues);
        const promptVersion = token(body.value.promptVersion, 'promptVersion', MAX_TOKEN, issues);
        const rubricVersion =
          body.value.rubricVersion == null
            ? null
            : token(body.value.rubricVersion, 'rubricVersion', MAX_TOKEN, issues);
        const evaluatorVersion =
          body.value.evaluatorVersion == null
            ? null
            : token(body.value.evaluatorVersion, 'evaluatorVersion', MAX_TOKEN, issues);
        let response = '';
        if (typeof body.value.response !== 'string' || body.value.response.trim().length === 0) {
          issues.push('response is required');
        } else {
          response = body.value.response
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
            .slice(0, MAX_REFLECTION_CHARS);
          if (body.value.response.length > MAX_REFLECTION_CHARS) {
            issues.push(`response must be ${MAX_REFLECTION_CHARS} characters or fewer`);
          }
        }
        const rubric =
          body.value.rubric && typeof body.value.rubric === 'object' && !Array.isArray(body.value.rubric)
            ? body.value.rubric
            : null;
        if (issues.length) return fail('INVALID_REFLECTION', 'Could not save the reflection.', 422, { issues });

        const reflection = await repository.saveReflection({
          runId: id,
          promptId,
          promptVersion,
          rubricVersion,
          evaluatorVersion,
          response,
          rubric,
        });
        return json({ reflection }, 201);
      }

      return fail('METHOD_NOT_ALLOWED', 'Unsupported method or route for this run.', 405, undefined);
    } catch (error) {
      console.error('[runs] request failed', error);
      return fail(
        'RUN_SERVICE_UNAVAILABLE',
        'Durable progress is unavailable. Your local academy progress is unaffected.',
        503,
      );
    }
  };
}

export default async (request: Request, context: Context): Promise<Response> =>
  createRunsHandler(createRunRepository())(request, context);

export const config: Config = {
  path: [
    '/api/v1/runs',
    '/api/v1/runs/:id',
    '/api/v1/runs/:id/complete',
    '/api/v1/runs/:id/attempts',
    '/api/v1/runs/:id/reflections',
  ],
  method: ['GET', 'POST'],
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['domain', 'ip'],
    // Progress sync is chattier than publication (an attempt per mission plus
    // reflections), so a higher ceiling than /api/worlds, still bounded.
    windowLimit: 60,
    windowSize: 60,
  },
};
