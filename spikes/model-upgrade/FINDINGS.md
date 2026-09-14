# Spike: Upgrade agents from Claude Sonnet 4.6 → newer model

**Date:** 2026-07-21 · **Account:** 123456789012 (your-aws-profile) · **Region:** eu-west-1
**Question:** Can we move the 10 Strands agents off `global.anthropic.claude-sonnet-4-6` to "Sonnet 5"?

## TL;DR — GO
Claude **Sonnet 5 is available AND accessible in eu-west-1 right now.**
- Newest Sonnet: `global.anthropic.claude-sonnet-5` (also `eu.anthropic.claude-sonnet-5`) — ACTIVE.
- Access already granted (smoke tests below succeeded, no AccessDenied).
- Pure string change to one model id across ~11 locations. No request-format / IAM / SDK change. Trivial rollback.

## Available (all ACTIVE, accessible)
| Tier | Global profile id |
|------|-------------------|
| Sonnet 5 (newest) | `global.anthropic.claude-sonnet-5` |
| Sonnet 4.6 (current) | `global.anthropic.claude-sonnet-4-6` |
| Opus 4.8 (newest opus) | `global.anthropic.claude-opus-4-8` |
| Haiku 4.5 | `global.anthropic.claude-haiku-4-5-20251001-v1:0` |

Recommended target: **`global.anthropic.claude-sonnet-5`** (same "global." tier, drop-in).

## Access verified by smoke test (maxTokens:1, all OK)
- `global.anthropic.claude-sonnet-5` via Converse → OK
- `global.anthropic.claude-sonnet-5` via native invoke_model (anthropic_version bedrock-2023-05-31, read_drawing.py shape) → OK
- `global.anthropic.claude-sonnet-4-6` (control) → OK; `global.anthropic.claude-opus-4-8` → OK

## Files pinning the model id (operative)
- `config/agents/agent{1..10}-*.yaml` line ~8 `modelId:` — 10 agent YAMLs (source of truth)
- `src/infra/lib/digital-thread-stack.ts:131` — `BEDROCK_MODEL_ID` env (slow consumer)
- `src/agents/tools/read_drawing.py:34` — `MODEL_ID` (hardcoded, MUST change)
- `src/agents/server.py:49`, `src/agents/runtime/main.py:110`, `src/consumers/slow-consumer/cert_readiness_agent.py:23` — fallback defaults

## Caveats
- Request format: none (Strands BedrockModel + native invoke both work vs Sonnet 5, verified).
- IAM: none — all 3 stacks grant `bedrock:InvokeModel*` on `resources:['*']`.
- Strands SDK: `strands-agents>=0.1.0` open pin — id passes through.
- Deploy surface: YAMLs baked into agent container + env in CDK → requires rebuild+redeploy of the agentcore/agent stack AND digital-thread (slow-consumer) stack, not just a file edit.
- Behavioral: re-run hero trigger (ncr-cluster → BORE_DIAMETER_OOT on 44821-003) after swap to confirm tool-call/JSON + read_drawing parsing.

## Effort & rollback
~15 min edit + one rebuild/redeploy of 2 stacks + one demo smoke run. Rollback = revert string, redeploy (both ids ACTIVE simultaneously).
