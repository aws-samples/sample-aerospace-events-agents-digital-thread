# Spike: 2D PLM drawings as unstructured data

**Date:** 2026-06-01 · **Status:** spike complete · **Verdict: GO** (fold into `gen_plm.py`
as a follow-up — see decision below).

Goal: prove we can generate realistic 2D engineering drawings (the kind a PLM platform
emits), store them as unstructured artifacts referenced from PLM events, and extract value
from them — so the demo works with unstructured data, not only structured events. Tied to
the demo defect: bore diameter out of tolerance on P/N 44821-003 "Wing box bore fitting".

Ran as 3 independent sub-spikes (fan-out). All three succeeded.

## Sub-spike 1 — generation fidelity vs effort → **matplotlib**
Assessed ezdxf, matplotlib, reportlab, svgwrite/Pillow. Recommendation: **matplotlib**.

| Candidate | Believable? | ~LOC | Deps | ARM64/Docker |
|---|---|---|---|---|
| **matplotlib** ✅ | High — pen weights, section hatching, dimension arrows, ISO title block; raster-first (vision-readable) | ~330 | matplotlib+numpy (manylinux wheels) | Excellent, no system libs |
| ezdxf | High fidelity (native CAD/DIMSTYLE) but composition fiddly; *still needs matplotlib to render PNG* | ~450+ | ezdxf + matplotlib | Good but heavier |
| reportlab | Good PDF, but PNG needs poppler/ghostscript | ~300 | reportlab + system rasterizer | Medium |
| svgwrite/Pillow | svgwrite needs cairo (system); Pillow weakest text quality | ~300–400 | cairo / Pillow | Weakest |

**Artifact:** `gen_drawing.py` + `sample-44821-003-revC.png` (3307×2338, 206KB) + `.pdf`.
The PNG shows two views (front + section A-A), the bore callout **Ø25.00 +0.02/-0.00 (H7)**,
a revision table (rev C = "bore tol tightened H7"), title block, notes. No brand names.

## Sub-spike 2 — storage + event wiring → **reuse datalake bucket, presigned URLs**
Full design in `STORAGE-DESIGN.md`. Validated the put→presign→GET→delete path end-to-end
against the live `aerospace-datalake-eu-west-1-123456789012` bucket (HTTP 200, zero residue).
- **Bucket:** reuse under a `drawings/` prefix for the demo (Athena only reads `events/`;
  the reset Lambda already wipes this bucket). Dedicated versioned+Object-Lock bucket flagged
  as the production hardening TODO.
- **Event shape:** generic-producer already does `payload: newImage`, so **no producer
  change** — just add `drawingS3Key`/`drawingUri` to the `DRAWING#` item in `gen_plm.py`.
  Key scheme `drawings/{partNumber}/{drawingNumber}-{rev}.png`.
- **Access:** Cognito-authed `GET /drawings/presign?key=…` Lambda (mirrors the datalake
  query pattern); agents reach it via the existing `execute-api:Invoke` grant — no new agent
  S3 grant. New IAM: `s3:PutObject` on the ECS generator role, `s3:GetObject` on the presign
  Lambda.

## Sub-spike 3 — consumption payoff → **Claude vision, exact extraction**
Full result in `VISION-PAYOFF.md`. `read_drawing_spike.py` sent the sample PNG to Bedrock
`global.anthropic.claude-sonnet-4-6` (same model the agents use). It extracted **6/6 fields
exactly**: P/N 44821-003, rev C, Ø25.00, +0.02, -0.00, H7. A conformance agent can compare
this as-designed tolerance to an as-measured value to confirm the out-of-tolerance condition.
Alternatives (Textract; frontend viewer) noted as complementary, not prototyped.

## Go / No-Go decision
**GO** to fold drawing generation into the pipeline as a follow-up (NOT part of the
structured-event work already shipped). Recommended follow-up scope:
1. Add a small matplotlib drawing generator to the generators image (port `gen_drawing.py`),
   parameterized by part. On `DRAWING_RELEASED`, render + `s3:PutObject` to
   `drawings/{partNumber}/{drawingNumber}-{rev}.png` and set `drawingS3Key`/`drawingUri` on
   the DDB item (rides through `payload` to the event — no producer change).
2. CDK: `s3:PutObject` on the generator task role; a `GET /drawings/presign` Lambda +
   `s3:GetObject` (api-gateway-stack.ts already receives the datalake bucket name).
3. Agent tool `read_drawing` (vision extraction) on the conformance/cert agents; optional
   frontend presigned-URL viewer on the PLM page / TraceDrawer for the human side.
Effort: small-to-medium, all touchpoints identified above, no new infra service.

## Throwaway artifacts (this dir)
`gen_drawing.py`, `read_drawing_spike.py`, `sample-44821-003-revC.{png,pdf}`,
`STORAGE-DESIGN.md`, `VISION-PAYOFF.md`. The `.venv/` (matplotlib+boto3) is gitignored.
