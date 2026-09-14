# Sub-spike 3 — Vision payoff: Claude reads the drawing

**Question:** can a multimodal model read a generated 2D engineering drawing and extract
the toleranced bore dimension, closing the loop from unstructured artifact → structured
insight that correlates to the `BORE_DIAMETER_OOT` defect?

**Verdict: YES — exact extraction.**

## What was run
`read_drawing_spike.py` base64-encodes `sample-44821-003-revC.png` and calls Bedrock
`invoke_model` with `global.anthropic.claude-sonnet-4-6` (the same inference profile the
agents use), an image content block + a prompt asking for strict JSON.

**Prompt:** *"This is a 2D mechanical engineering drawing. Read it and extract … partNumber,
revision, boreNominalDiameterMm, boreToleranceUpperMm, boreToleranceLowerMm, fitClass.
Use only what is shown on the drawing. Respond with JSON only."*

**Actual model output:**
```json
{
  "partNumber": "44821-003",
  "revision": "C",
  "boreNominalDiameterMm": 25.00,
  "boreToleranceUpperMm": 0.02,
  "boreToleranceLowerMm": 0.00,
  "fitClass": "H7"
}
```

**Correctness:** 6/6 fields correct. The drawing shows Ø25.00 +0.02/-0.00 (H7) on P/N
44821-003 rev C — the model read all of it, including the signed tolerance band and the
ISO fit class.

## Why this matters (the demo payoff)
The Conformance/Quality agent can call a `read_drawing` tool to pull the **as-designed**
tolerance straight from the drawing, then compare it to the **as-measured** bore diameter
on the NCR. That turns an unstructured engineering artifact into a structured,
machine-checkable conformance assertion — "measured Ø25.04 exceeds drawing max Ø25.02 →
out of tolerance, confirmed against rev C." It demonstrates the platform reasoning over
*both* structured events and unstructured documents.

## How a `read_drawing` agent tool would plug in
Mirror the existing tool pattern in `src/agents/tools/` (e.g. `query_graph.py`):
```python
@tool
def read_drawing(part_number: str) -> str:
    """Fetch the released drawing for a part and extract its dimensions/tolerances."""
    # 1. resolve drawingS3Key from the graph/event (PLM DRAWING_RELEASED carries it)
    # 2. s3.get_object → bytes  (agent runtime role needs s3:GetObject on drawings/*,
    #    OR call the presign endpoint like the datalake tools do)
    # 3. bedrock-runtime invoke_model (vision) with the image + extraction prompt
    # 4. return structured JSON (nominal, tolerance band, fit class)
```
Add to the conformance/cert agents' tool allowlists. Same Bedrock client the agents
already use; the only new IAM is image retrieval (S3 GetObject or the presign call).

## Alternatives not prototyped
- **Textract** — preferable if drawings were scanned raster with dense text tables or we
  needed deterministic OCR with bounding boxes / form-field extraction at scale. For
  born-digital drawings with a handful of callouts, the vision model is simpler and reads
  geometry/context better.
- **Frontend presigned-URL viewer** — preferable for the human-in-the-loop side: render
  the actual drawing in the PLM page / TraceDrawer so a reviewer sees what the agent saw.
  Complementary, not either/or — ship the viewer for humans + the vision tool for agents.
