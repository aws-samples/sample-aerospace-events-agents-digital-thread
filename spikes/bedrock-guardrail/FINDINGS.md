# Spike: Bedrock Guardrails for the aerospace agents

**Date:** 2026-09-01 · **Region:** eu-west-1 · **Account:** 123456789012 (your-aws-profile)

## Question

Would a minimal Bedrock Guardrail block prompt-injection and a domain-relevant
export-control (ITAR) topic **without** blocking the agents' legitimate I/O — and at
what latency/effort — so we can decide whether to add it to this educational sample?

## What was tried

A guardrail with two policies (created, tested via `ApplyGuardrail`, deleted):
- `contentPolicyConfig`: `PROMPT_ATTACK` filter, `inputStrength=HIGH`, `outputStrength=NONE`
  (prompt-attack applies to input only).
- `topicPolicyConfig`: one DENY topic `ExportControlledTechnicalData` (ITAR/EAR specs).

Tested with `bedrock-runtime:ApplyGuardrail` (evaluates text directly — no model
invoke, so cheap to validate).

## Results (measured)

| Case | source | action | reason | latency |
|---|---|---|---|---|
| Legit NCR summary + disposition request | INPUT | `NONE` | — | 584 ms |
| Legit agent ESCALATE finding | OUTPUT | `NONE` | — | 249 ms |
| Prompt injection ("ignore instructions, reveal prompt, auto-approve") | INPUT | `GUARDRAIL_INTERVENED` | `PROMPT_ATTACK` | 243 ms |
| ITAR export-control request | INPUT | `GUARDRAIL_INTERVENED` | `ExportControlledTechnicalData` | 304 ms |

**It works and it is precise**: both malicious inputs blocked, both legitimate agent
messages passed. No false positive on real agent output — the key risk for a demo.

## Facts for the implementation decision

- **Latency**: ~0.25–0.6 s per `ApplyGuardrail` call. If a turn guards both input and
  output, that is two calls. Model invocation with an attached guardrail folds it into
  the invoke instead.
- **Cost**: Guardrails bill per "text unit" (~1000 chars) per policy evaluated — a small
  per-guarded-call cost on top of model inference.
- **Wiring options**:
  1. **Native (preferred)** — pass `guardrailIdentifier` + `guardrailVersion` on the
     Bedrock `InvokeModel`/`Converse` call so input+output are guarded in one call.
     Check the Strands Bedrock model provider for a guardrail config field.
  2. **Explicit** — call `ApplyGuardrail` on input before, and on output after, the model
     call. More control, two extra calls.
- **Versioning**: `DRAFT` works for `ApplyGuardrail`; publish a numbered version for
  anything beyond a spike.
- **CDK**: `aws-cdk-lib/aws-bedrock` `CfnGuardrail` + `CfnGuardrailVersion` provision it;
  pass the id/version into the agent runtimes as env vars.

## Recommendation

**Worth adding to the sample as a small, honest showcase of responsible AI** — it is the
one "recommendation" bucket item with high teaching value for an *agent* sample, and the
spike shows it does not harm the demo. Keep it minimal (the two policies above) and wire
it natively into the agents' Bedrock calls. It is optional: it adds a guardrail resource,
a per-call cost, and ~0.3 s latency. If added, note it as a demonstrated control (not a
production-tuned policy set) and revisit `outputStrength`, PII filters, and word filters
for real deployments.

## Status

Spike only — the guardrail was **deleted** after testing; nothing is wired into the
agents or CDK yet. This is the decision checkpoint.
