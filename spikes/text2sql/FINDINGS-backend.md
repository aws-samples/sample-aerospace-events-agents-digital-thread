# Text-to-SQL — Backend Shape (design spike, no prod code)

**Question:** Where should NL→SQL generation live, what IAM/wiring does it need, and
what are the exact safety guardrails? Deliver a concrete, minimal integration design.

**Ground truth read (not edited):**
- `src/lambdas/athena-query/index.ts` — the Athena Lambda. Has `validateFreeformSql()`
  (SELECT-only; must reference `aerospace_events.domain_events`; forbids
  INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/MERGE), `ensureLimit()` (appends
  `LIMIT 100` if none), `executeQuery(sql, timeoutMs)`, a static `SCHEMA` object, 13
  named queries, and a `freeformSql` op. Handler dispatches on `body.query`.
- `src/infra/lib/api-gateway-stack.ts` — deploys it as `aerospace-athena-query`
  (`NodejsFunction`, `NODEJS_20_X`, **timeout 30 s**, mem 256) behind API GW at
  `POST /query/athena` (Cognito) and `POST /query/athena-iam` (IAM/SigV4).
- `src/agents/tools/read_drawing.py` — Bedrock invoke pattern: `bedrock-runtime`,
  `modelId='global.anthropic.claude-sonnet-4-6'`, `anthropic_version='bedrock-2023-05-31'`,
  and the **markdown-fence-strip** trick (```` ```json … ``` ````) already used in prod.
- Existing Bedrock grants (`agent-stack.ts`, `agentcore-stack.ts`,
  `digital-thread-stack.ts`) all use `actions:['bedrock:InvokeModel', …], resources:['*']`.

---

## 1. Where generation lives — **Extend the existing `athena-query` Lambda**

Add one operation `query: "text2sql"` to the existing handler. **Do not** create a
separate Lambda. Rationale:

- **Reuse of the exact guardrail + execution chain.** `validateFreeformSql`,
  `ensureLimit`, and `executeQuery` already live in this file. The whole point of the
  feature is that model output flows through the *same* validation as `freeformSql`.
  A separate Lambda would either duplicate that logic (drift risk — the security
  invariant could diverge) or add a second network hop to call this one.
- **Reuse of the schema.** The `SCHEMA` object is the grounding prompt for the model.
  Colocated = one source of truth for columns/tips.
- **IAM blast radius stays tiny.** The Bedrock grant lands on a role that already only
  reads Athena/S3/Glue. It gains exactly one action (`bedrock:InvokeModel`) on exactly
  one inference-profile ARN. A new Lambda would mean a new role, new API resource, new
  integration — more surface for the same behaviour.
- **Latency.** In-process `text2sql` = one Bedrock call + the existing query poll loop;
  no extra hop. (Separate-Lambda designs add ~cold-start + invoke latency for nothing.)
- **Simplicity.** ~40 lines added to a file that already owns every dependency. Meets
  "Aim for Simplicity" — smallest change that satisfies the ask.

**When a separate Lambda *would* win (not now):** if generation grew a vector store /
few-shot retriever / long conversation memory with a heavier bundle, or needed a
different timeout/memory profile at scale. None apply to this demo.

---

## 2. Request / response contract (what the frontend calls)

Same endpoint, same auth as today: `POST /query/athena` (Cognito JWT) — no new route.

**Request**
```json
{ "query": "text2sql", "parameters": { "question": "How many critical NCRs per supplier in the last 14 days?" } }
```

**Success (200)** — echoes the question + the SQL the model produced (post-guardrails),
the rows, and timing. `generatedSql` is the *executed* SQL (after `ensureLimit`).
```json
{
  "question": "How many critical NCRs per supplier in the last 14 days?",
  "generatedSql": "SELECT ... FROM aerospace_events.domain_events WHERE ... LIMIT 100",
  "data": [ { "supplier_id": "titan-forge", "cnt": "3" } ],
  "executionMs": 2841
}
```

**Rejected / failed (400)** — the model produced something that failed a guardrail, or
returned non-SELECT. **Return the SQL + a friendly error; do NOT execute.**
```json
{
  "question": "delete all NCRs",
  "generatedSql": "DELETE FROM aerospace_events.domain_events",
  "error": "Generated query was not a read-only SELECT and was blocked. Try rephrasing as a question about the data."
}
```
Bedrock unavailable / model-not-enabled → 500 (or 503) `{ "question", "error": "..." }`.

The frontend renders `generatedSql` (transparency — user sees the SQL), then the
`data` table, reusing the existing freeform results renderer.

---

## 3. Guardrail chain — never trust the model

Flow, in order (all before any execution):

```
question
  → Bedrock InvokeModel (system prompt = SCHEMA columns + tips + "SELECT only,
      single statement, reference aerospace_events.domain_events, respond with SQL only")
  → extract text from response.content[0].text
  → strip markdown fences  (reuse read_drawing.py trick: if startswith ``` … unwrap)
  → single-statement guard  (reject if internal ';' — split, ignore empty trailing)
  → validateFreeformSql(sql)   ← SAME function as freeformSql path
        · must start with SELECT
        · must reference aerospace_events.domain_events
        · forbids INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/TRUNCATE/MERGE
     → on failure: return 400 { question, generatedSql, error }  (do NOT execute)
  → ensureLimit(sql)           ← SAME function; caps result size
  → executeQuery(safeSql, timeoutMs)   ← SAME function
  → 200 { question, generatedSql: safeSql, data, executionMs }
```

Guardrail invariants:
- **The generated SQL passes the identical `validateFreeformSql` + `ensureLimit` the
  human freeform path uses.** The model is treated as an untrusted SQL author. This is
  the core safety property — a jailbroken prompt still can't run DDL/DML because the
  Athena workgroup only ever receives validated SELECTs, and the Lambda role has no
  write grant to Glue/S3 tables anyway (defence in depth).
- **Single statement only.** Add a cheap check (reject if the trimmed SQL contains an
  internal `;`) so the model can't smuggle a second statement past the SELECT prefix
  check. (Athena `StartQueryExecution` runs one statement, but reject early + explicitly.)
- **Timeout.** Pass an explicit budget to `executeQuery` that fits inside the Lambda
  timeout (see §4) — e.g. `executeQuery(safeSql, 45000)` so Bedrock (~2–5 s) + poll loop
  stays under the Lambda ceiling.
- **Non-SELECT / validation failure ⇒ return the SQL and a friendly message, never
  execute.** Surfacing the SQL is a feature (user can learn/rephrase) and makes the
  block auditable.
- **max_tokens** on the Bedrock call kept small (e.g. 512) — the output is one query.

---

## 4. IAM / CDK delta (in `api-gateway-stack.ts`, on `athenaFn`)

Add one policy statement to the existing `athenaFn` role. Scope to the Sonnet inference
profile (tighter than the `resources:['*']` used elsewhere in this repo — recommended
for the new grant; matching the repo's `'*'` convention is the low-effort alternative).

```ts
// Bedrock — NL→SQL generation (text2sql op). Scoped to the Sonnet global profile.
athenaFn.addToRolePolicy(new iam.PolicyStatement({
  actions: ['bedrock:InvokeModel'],
  resources: [
    // The global cross-region inference profile (account-scoped resource):
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
    // The underlying foundation model the profile routes to. A `global.` profile can
    // route to any region, so the foundation-model ARN uses a region wildcard and an
    // EMPTY account field (models are AWS-owned):
    `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*`,
  ],
}));
```

Notes on the ARN forms:
- Inference-profile ARNs are **account-scoped** and carry the profile id verbatim,
  including the `global.` prefix: `…:${account}:inference-profile/global.anthropic.claude-sonnet-4-6`.
- Foundation-model ARNs have **no account id** (`arn:aws:bedrock:<region>::foundation-model/<id>`).
  Because this is a *global* profile, grant across regions with `bedrock:*::foundation-model/…`.
  Both statements are required — invoking via a profile authorizes against the profile
  ARN *and* the model ARN.

**Timeout bump (required).** The Lambda is currently `timeout: 30 s` but `executeQuery`
defaults to a 60 s poll loop — text2sql adds Bedrock latency on top. Raise it:
```ts
timeout: cdk.Duration.seconds(60),   // was 30 — gen (~2–5s) + Athena query poll
```
(Side finding: the existing `freeformSql`/named-query paths are already at latent risk
of a 30 s Lambda timeout cutting off a 60 s `executeQuery`; this bump fixes that too.)
Memory 256 MB is fine. No new API route, model, authorizer, or CORS change needed —
the new op rides the existing `POST /query/athena` integration.

---

## 5. Bedrock model access (fail gracefully)

`global.anthropic.claude-sonnet-4-6` is **already in production** in this account/region
(`read_drawing.py` invokes it via `bedrock-runtime`; the slow consumer sets it as
`BEDROCK_MODEL_ID`). So model access is enabled in eu-west-1 and no console
"model access" enablement step is expected.

Verify before shipping (read-only):
```bash
AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1 \
  aws bedrock get-inference-profile \
  --inference-profile-identifier global.anthropic.claude-sonnet-4-6
```
(or `aws bedrock list-inference-profiles`). A 200 confirms the profile resolves in-region.

**Graceful failure in the real feature:** wrap the `InvokeModel` call; on
`AccessDeniedException` / `ValidationException` (model not enabled) or throttling,
return `{ question, error: "Natural-language query is temporarily unavailable." }`
with 503, and keep the existing named-query + freeform paths fully functional (text2sql
is purely additive — its failure must not regress the dashboard's other queries).

---

## Summary

- **Extend** `athena-query` with a `text2sql` op — reuses `validateFreeformSql` /
  `ensureLimit` / `executeQuery` / `SCHEMA`, one action added to one existing role.
- **Contract:** `POST /query/athena` `{query:"text2sql", parameters:{question}}` →
  `{question, generatedSql, data, executionMs}` or `{question, generatedSql, error}`.
- **Guardrails:** NL → Bedrock → strip fences → single-statement check →
  `validateFreeformSql` → `ensureLimit` → `executeQuery`; non-SELECT/invalid ⇒ return
  SQL + friendly error, never execute. Model is an untrusted author; role has no write
  grant (defence in depth).
- **CDK delta:** one `bedrock:InvokeModel` statement scoped to
  `inference-profile/global.anthropic.claude-sonnet-4-6` + `*::foundation-model/anthropic.claude-sonnet-4-6*`;
  bump Lambda timeout 30 s → 60 s.
- **Model access:** already enabled (read_drawing + slow consumer use it in prod);
  fail gracefully (503 + friendly message) if access/throttle errors occur.
