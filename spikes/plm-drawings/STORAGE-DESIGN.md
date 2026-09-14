# Spike: 2D PLM Drawing Artifacts in S3

**Goal**: Store generated 2D PLM drawing artifacts (PNG/PDF — unstructured data) in S3, reference
them from PLM events, and let the frontend + agents retrieve them via presigned URLs.

**Status**: DESIGN + light read-only/local validation. No CDK or app code changed. Nothing committed.
No persistent AWS resources created.

---

## 1. Bucket decision — reuse the datalake bucket under `drawings/`

**Confirmed facts** (read-only, `aws s3api`):

| Property | Value |
|---|---|
| Name | `aerospace-datalake-eu-west-1-123456789012` |
| Encryption | SSE-S3 (`AES256`), `BucketKeyEnabled: false` |
| Lifecycle | none (`NoSuchLifecycleConfiguration`) |
| Existing prefixes | `events/` (Iceberg table data) |
| Removal policy (CDK) | `DESTROY` + `autoDeleteObjects: true` |

**Decision: REUSE the datalake bucket under a dedicated `drawings/` prefix.**

Rationale (for a demo):
- One bucket, one lifecycle/removal story. `reset-demo.sh` / the HITL reset Lambda already wipe this
  bucket; drawings get cleaned for free (they already hold `s3:DeleteObject`/`ListBucket` on it).
- Athena/Iceberg only reads `events/` — a sibling `drawings/` prefix never collides with the Glue
  table location (`s3://.../events/`).
- The presign Lambda and existing query Lambdas can be granted on the *same* bucket ARN they already
  reference, minimising new IAM surface.

**Tradeoff (when a dedicated bucket would win)**:
- *Blast radius*: a reset that wipes the datalake also wipes drawings. For a demo that is desirable;
  for production, drawings are regulated records (DHR/as-built evidence) with retention obligations —
  they should live in a dedicated bucket with versioning, Object Lock (WORM), and a longer lifecycle,
  decoupled from the analytics datalake's churn.
- *Least privilege*: a dedicated bucket lets the presign Lambda hold `s3:GetObject` on drawings only,
  not on the whole analytics lake.
- *Cost/lifecycle independence*: drawings (write-once, read-often) and event parquet (hot then cold)
  have different lifecycle curves.

**Recommendation**: reuse `drawings/` now (demo). Note a dedicated `aerospace-plm-drawings-*` bucket
with versioning + Object Lock as the production hardening step (see §5 TODO).

### Key scheme

```
drawings/{partNumber}/{drawingNumber}-{rev}.{ext}
```

Example: `drawings/44821-003/DWG-44821-003-001-C.png`

- `partNumber`, `drawingNumber`, `rev` come straight from the PLM `DRAWING#` record
  (`partNumber`, `drawingNumber`, `revisionLetter`).
- Deterministic + idempotent: re-releasing the same drawing rev overwrites the same key (matches the
  generator's `ConditionExpression=Attr('PK').not_exists()` "one rev = one artifact" model).
- Human-navigable by part, and a single `ListObjectsV2` prefix returns all revs of a part.
- `{ext}` is `png` (raster preview, frontend `<img>`) or `pdf` (full sheet, download). The metadata
  carries the content type so a viewer knows which.

---

## 2. Event field additions — `DRAWING#` record carries the artifact reference

The generic-producer wraps the whole DDB item as `event.payload` (see
`src/lambdas/generic-producer/index.ts`, `payload: newImage`). So the *only* change needed to make the
event reference the artifact is to add fields to the DRAWING item written by `gen_plm.py`. No producer
change is required — the fields ride along inside `payload`, and the existing entityId extraction
already prefers `drawingNumber`.

**New DRAWING item fields** (added in `gen_plm.py`, `action == 'drawing'`):

```python
table.put_item(Item={
    'PK': f'DRAWING#{info["dwg"]}', 'SK': f'REV#{info["rev"]}',
    'drawingNumber': info['dwg'], 'partNumber': pn,
    'revisionLetter': info['rev'], 'status': 'RELEASED',
    # --- NEW: artifact reference ---
    'drawingS3Bucket': DATALAKE_BUCKET,                                   # env var
    'drawingS3Key':    f'drawings/{pn}/{info["dwg"]}-{info["rev"]}.png',  # see §1 key scheme
    'drawingUri':      f's3://{DATALAKE_BUCKET}/drawings/{pn}/{info["dwg"]}-{info["rev"]}.png',
    'drawingContentType': 'image/png',
    # ------------------------------
    'releasedBy': 'gen-plm', 'createdAt': now, 'updatedAt': now,
}, ConditionExpression=Attr('PK').not_exists())
```

Resulting `DRAWING_RELEASED` event (canonical envelope, abbreviated):

```json
{
  "eventType": "DRAWING_RELEASED",
  "domain": "PLM",
  "entityId": "DWG-44821-003-001",
  "payload": {
    "drawingNumber": "DWG-44821-003-001",
    "partNumber": "44821-003",
    "revisionLetter": "C",
    "status": "RELEASED",
    "drawingS3Key": "drawings/44821-003/DWG-44821-003-001-C.png",
    "drawingUri": "s3://aerospace-datalake-.../drawings/44821-003/DWG-44821-003-001-C.png",
    "drawingContentType": "image/png"
  }
}
```

Downstream, the fast-consumer PLM graph handler can attach `drawingS3Key` as a property on the
existing `Drawing` node, so agents traversing the graph see the artifact pointer.

**Where the bytes come from**: the generator (ECS task) must upload the PNG/PDF to `drawingS3Key`
*before* (or atomically with) the DDB write, so the event never references a missing object. For the
demo a single placeholder/template PNG per part is sufficient; the put goes to the deterministic key.

---

## 3. Presigned-URL retrieval flow

The frontend never gets S3 credentials. It already calls API Gateway with a Cognito ID token
(`useHistoricalData.ts`: `fetch(${API_GATEWAY_URL}/query/athena, Authorization: Bearer <idToken>)`).
A new **Cognito-authed** `GET /drawings/presign?key=<drawingS3Key>` endpoint mints a short-lived
presigned GET URL. Agents use the same endpoint via their existing `execute-api:Invoke` grant (IAM
variant), so no new `s3:GetObject` is needed on agent runtime roles — the presign Lambda holds it.

```
Frontend                 API Gateway            Presign Lambda            S3
  | GET /drawings/presign?key=...  (Cognito ID token)
  |------------------------>|
  |                         | (Cognito authorizer validates)
  |                         |------------------------>|
  |                         |     generate_presigned_url('get_object',
  |                         |       Bucket, Key, ExpiresIn=300)   (SigV4, no S3 call)
  |                         |<------------------------|
  |   { url, expiresIn }    |
  |<------------------------|
  | GET <presigned url>  (no creds, direct to S3)
  |---------------------------------------------------------------->|
  |                          200 image/png bytes                    |
  |<----------------------------------------------------------------|
  | render <img src=url> or PDF download
```

Notes:
- Presign is a **local SigV4 signing operation** — no network/S3 call at mint time (validated in §4).
- 300s TTL mirrors the existing API Gateway cache TTL convention.
- Validate `key` starts with `drawings/` in the Lambda to prevent it being used to presign arbitrary
  datalake objects (e.g. `events/`).

---

## 4. Light validation result (PASSED, no residue)

Run with `AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1` against the real bucket. A tiny text
object stood in for the drawing artifact; deleted immediately after.

| Step | Command | Result |
|---|---|---|
| Bucket access | `aws s3 ls s3://aerospace-datalake-eu-west-1-123456789012/` | OK — `PRE events/` |
| Encryption | `get-bucket-encryption` | `AES256`, BucketKey off |
| Lifecycle | `get-bucket-lifecycle-configuration` | none (NoSuchLifecycleConfiguration) |
| PUT | `put-object --key drawings/_spike/test-44821-003-C.txt` | OK, `ServerSideEncryption: AES256` |
| Presign | `aws s3 presign s3://.../<key> --expires-in 300` | 1375-char SigV4 URL minted locally |
| GET (anon) | `curl <presigned url>` (no creds) | **HTTP 200**, body returned verbatim |
| DELETE | `delete-object --key drawings/_spike/...` | OK |
| Verify gone | `aws s3 ls s3://.../drawings/_spike/` | empty — object removed |

Conclusion: the reuse-with-`drawings/`-prefix + presigned-GET path works against the live bucket.
The generated SigV4 URL is anonymously fetchable for its TTL, exactly as the frontend needs.

---

## 5. CDK / IAM changes that WOULD be needed (future TODO — NOT applied)

These are the exact touchpoints. None are applied in this spike.

1. **Generator upload permission** — `src/infra/lib/generator-stack.ts`
   - Add to `taskDef.taskRole`:
     `s3:PutObject` on `arn:aws:s3:::aerospace-datalake-<region>-<acct>/drawings/*`.
   - Pass the datalake bucket name into `GeneratorStackProps` and set a `DATALAKE_BUCKET` container
     env var (mirrors how `IOT_ENDPOINT` is passed) so `gen_plm.py` can build the key/URI.

2. **`gen_plm.py`** — `src/generators/generators/gen_plm.py`
   - Read `DATALAKE_BUCKET` from env; upload the PNG/PDF bytes to the deterministic key *before* the
     DDB `put_item`; add the four `drawing*` fields to the DRAWING item (see §2).

3. **Presign Lambda + API route** — `src/infra/lib/api-gateway-stack.ts` (+ new
   `src/lambdas/drawings-presign/`)
   - New `NodejsFunction` `aerospace-drawings-presign` (Python or Node) with env `DATALAKE_BUCKET`.
   - IAM: `s3:GetObject` on `arn:aws:s3:::aerospace-datalake-<region>-<acct>/drawings/*`.
   - Route: `api.root.addResource('drawings').addResource('presign')` →
     `GET` Cognito-authed (browser) + an IAM-authed sibling (`presign-iam`) for agents, matching the
     existing `athena` / `athena-iam` dual-auth pattern.
   - Pass `datalakeBucketName` (already a prop on `ApiGatewayStackProps`) — no new prop needed.

4. **Fast-consumer PLM handler** (optional graph enrichment)
   - Attach `drawingS3Key` as a property on the `Drawing` node so `query_graph` surfaces the pointer.

5. **Agent runtime roles** — `src/infra/lib/agentcore-stack.ts`
   - **No change required.** Agents reach the presign endpoint through their existing
     `execute-api:Invoke` on `*`. They never touch S3 directly.

6. **Frontend** — new hook `useDrawing(key)` mirroring `useHistoricalData.ts`: `fetchAuthSession()` →
   `GET /drawings/presign?key=...` → render `<img src={url}>` (PNG) or open PDF.

7. **Production hardening (out of demo scope)** — dedicated `aerospace-plm-drawings-*` bucket with
   versioning + S3 Object Lock (WORM) + retention lifecycle; presign Lambda scoped to that bucket only.
