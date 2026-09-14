# Integration plan — 2D PLM drawings (productionize the spike)

Promotes the validated spike (`FINDINGS.md`, `STORAGE-DESIGN.md`, `VISION-PAYOFF.md`)
into the demo. The spike proved all three legs work: matplotlib generation, S3 +
presigned-URL storage (validated live), and Bedrock-vision extraction (6/6 fields).

**Principle:** drawings are an *additive* capability — the PLM domain already flows
end-to-end. A generated drawing is an artifact attached to the existing
`DRAWING_RELEASED` event; no new topic, table, or domain.

## Vertical slice order (each independently shippable + demoable)

### Slice 1 — Generate + store drawings (the artifact exists)
The walking skeleton: a released drawing produces a real PNG in S3.
- **`src/generators/drawing.py`** (NEW) — port `spikes/plm-drawings/gen_drawing.py` into
  the generators image as a reusable `render_drawing(part_number, drawing_number, rev,
  bore_dia, tol_up, tol_lo) -> bytes` (PNG). Keep it brand-neutral; parameterize the bore
  callout so the defect part (44821-003, Ø25.00 +0.02/-0.00 H7) is data-driven.
- **`src/generators/requirements.txt`** — add `matplotlib` (manylinux wheels; clean on the
  existing `python:3.12-slim` amd64 image — no system libs).
- **`gen_plm.py`** `_drawing` action — on a `RELEASED` maturity, call `render_drawing`,
  `s3.put_object` to `drawings/{partNumber}/{drawingNumber}-{rev}.png`, and set
  `drawingS3Key` / `drawingS3Bucket` / `drawingUri` / `drawingContentType` on the
  `DRAWING#` item. These ride through `payload` automatically (generic-producer does
  `payload: newImage`) — **no producer change**, so `DRAWING_RELEASED` carries the ref.
- **`src/infra/lib/generator-stack.ts`** — add `s3:PutObject` on
  `arn:aws:s3:::${datalakeBucket}/drawings/*` to the ECS `taskDef.taskRole` (pass the
  datalake bucket name into `GeneratorStackProps`, already available from StorageStack).
- **Done when:** a generator run writes a PNG to S3 and the `DRAWING_RELEASED` event
  payload contains a resolvable `drawingS3Key`.

### Slice 2 — Graph carries the reference (thread-aware)
- **`src/consumers/fast-consumer/handlers/plm.py`** `_drawing` — copy `drawingS3Key` /
  `drawingUri` onto the `ProductDefinitionDocument` node props. (ISA-95-compliant: it's
  an attribute of the existing canonical node, not a new label.)
- **Done when:** `g.V().hasLabel('ProductDefinitionDocument').values('drawingUri')`
  returns the key for released drawings.

### Slice 3 — Human view (presigned-URL viewer)
- **`src/lambdas/drawing-presign/`** (NEW, tiny) — Cognito-authed `GET /drawings/presign
  ?key=…`, validates the key is under `drawings/`, returns a short-TTL
  `generate_presigned_url('get_object')`. Mirror the existing query-Lambda pattern in
  `api-gateway-stack.ts` (lines 96-113): `CognitoUserPoolsAuthorizer` + `LambdaIntegration`.
- **`src/infra/lib/api-gateway-stack.ts`** — add the Lambda + a `query/drawings/presign`
  (or top-level `drawings`) resource; grant it `s3:GetObject` on
  `${datalakeBucket}/drawings/*` only (it already receives `datalakeBucketName`).
- **Frontend** — a `useDrawingUrl(key)` hook mirroring `useHistoricalData.ts` (Bearer
  token → API GW → presigned URL), and a viewer (`<img>` for PNG) on the PLM system page
  and in `TraceDrawer` when a thread node has a `drawingUri`.
- **Done when:** clicking a released drawing in the UI renders the actual PNG.

### Slice 4 — Agent payoff (`read_drawing` tool)
- **`src/agents/tools/read_drawing.py`** (NEW) — `@tool def read_drawing(part_number)`:
  resolve `drawingS3Key` from the graph (`query_graph`) → fetch bytes (presign endpoint,
  reusing the agent's existing `execute-api:Invoke`, OR `s3:GetObject` if granted) →
  Bedrock `invoke_model` vision (port `read_drawing_spike.py`, same
  `global.anthropic.claude-sonnet-4-6` the agents use) → return structured
  {nominal, tolerance band, fit class}. Brand-neutral.
- **`config/agents/agent1-conformance.yaml`** (and optionally `agent5-certification`) —
  add `read_drawing` to the tool allowlist + a decision-rule step: on a bore NCR,
  read the drawing's as-designed tolerance and compare to the as-measured value to
  confirm/deny the out-of-tolerance condition (cite both numbers).
- **Done when:** on a `BORE_DIAMETER_OOT` NCR, the conformance agent reads the drawing,
  extracts Ø25.00 +0.02/-0.00, and states "measured X vs drawing max 25.02 → confirmed".

## Decisions already settled by the spike
- **Library:** matplotlib (raster-first, no system libs, amd64+arm64 wheels).
- **Bucket:** reuse `aerospace-datalake-*` under `drawings/` for the demo. *Production
  hardening (deferred):* dedicated `aerospace-plm-drawings-*` bucket with versioning +
  Object Lock (drawings are regulated DHR/as-built records).
- **Access:** presigned URLs; agents via the existing API-GW invoke grant — no broad S3
  grant on agent roles.
- **Vision model:** the same inference profile the agents already use.

## Sequencing / risk
- Slices 1→2→4 are the "agent reasons over a document" story; Slice 3 is the human view
  and can land in parallel after Slice 1.
- Deploy order (one stack at a time, Docker up): GeneratorStack (Slice 1+matplotlib image
  rebuild) → DigitalThreadStack (Slice 2) → ApiGatewayStack (Slice 3) → AgentCoreStack
  (Slice 4 tool + YAML).
- Cost note: drawing render + a vision call per released drawing — bound generation to the
  demo parts (5) and only on `RELEASED` transitions to keep volume/cost demo-sized.
- Reset: `drawings/` is wiped by the existing datalake reset — no new teardown needed.

## Verification (end-to-end)
1. Generator writes PNG → `aws s3 ls s3://…/drawings/44821-003/`.
2. `DRAWING_RELEASED` payload has `drawingS3Key` (CloudWatch on the producer / a test rule).
3. Neptune `ProductDefinitionDocument` node has `drawingUri`.
4. UI renders the drawing via presign (network tab shows 200 from the presigned URL).
5. Conformance agent on a bore NCR calls `read_drawing`, extracts the tolerance, and
   correlates to the measurement (agent-trace / Agent Activity).
6. Brand-neutrality grep on the new files.
