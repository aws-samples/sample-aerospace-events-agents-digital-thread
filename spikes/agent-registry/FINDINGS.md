# Spike: AWS Agent Registry (preview) — can it replace our JSON agent-registry?

**Date:** 2026-06-01 · **Region:** eu-west-1 · **Account:** 123456789012 (your-aws-profile)
**Verdict:** ✅ GO. Every risky assumption confirmed against the live API. One required change: bump botocore.

## Questions probed & answers

| # | Question | Answer |
|---|----------|--------|
| 1 | Is the preview enabled on our account/region? | **YES** — `list_registries()` → `[]` (not AccessDenied). Create/get/delete all succeed. |
| 2 | Does our SDK have the API? | **NO** — installed botocore `1.42.59` exposes **zero** registry ops. Latest public botocore `1.43.18` exposes all 12 control-plane ops + `SearchRegistryRecords` (data plane). **→ bump boto3/botocore to ≥1.43.0.** |
| 3 | Is A2A a first-class descriptor type? | **YES** — `descriptorType` enum = `['MCP','A2A','CUSTOM','AGENT_SKILLS']`. |
| 4 | Can a record carry our runtime ARN / agent card? | **YES** — `descriptors.a2a.agentCard.inlineContent` holds the full A2A agent-card JSON, including `url` (the runtime invocation endpoint). Recovered byte-intact via `get_registry_record`. |
| 5 | Which agentCard `schemaVersion` is accepted? | **`0.3.0`** (and `0.3`). **`0.2.x`, `1.0`, date strings all REJECTED** with `ValidationException: Schema version '0.2' is not supported`. A2A protocol 0.3.x only. |
| 6 | Does the approval workflow work? | **YES** — records land in `DRAFT`; `submit_registry_record_for_approval` → `APPROVED`. (Even with `approvalConfiguration.autoApproval=True`, an explicit submit was still needed to flip DRAFT→APPROVED in the spike.) |
| 7 | Does semantic search actually work? | **YES (headline win)** — `search_registry_records(searchQuery="supplier quality issues")` matched the conformance agent by **meaning**, not substring. `"non conformance detection"` also matched. Replaces our `search_agents` substring match. |

## Exact API shapes (botocore 1.43.18)

Control plane (`bedrock-agentcore-control`):
`CreateRegistry, GetRegistry, UpdateRegistry, DeleteRegistry, ListRegistries,
CreateRegistryRecord, GetRegistryRecord, UpdateRegistryRecord, DeleteRegistryRecord,
ListRegistryRecords, SubmitRegistryRecordForApproval, UpdateRegistryRecordStatus`

Data plane (`bedrock-agentcore`): `SearchRegistryRecords`

```python
ctrl.create_registry(name=..., description=..., approvalConfiguration={"autoApproval": True})
# -> {"registryArn": ".../registry/<id>"}   (id = arn.split('/')[-1]); poll get_registry until status in (READY, ACTIVE)

ctrl.create_registry_record(
    registryId=<id>, name="agent1-conformance", description=...,
    descriptorType="A2A", recordVersion="1.0.0",
    descriptors={"a2a": {"agentCard": {"schemaVersion": "0.3.0", "inlineContent": json.dumps(agent_card)}}})
# -> {"recordArn": ".../record/<rid>"}; lands DRAFT
ctrl.submit_registry_record_for_approval(registryId=<id>, recordId=<rid>)   # -> APPROVED

g = ctrl.get_registry_record(registryId=<id>, recordId=<rid>)
card = json.loads(g["descriptors"]["a2a"]["agentCard"]["inlineContent"])   # card["url"] = runtime endpoint

data.search_registry_records(registryIds=[<id>], searchQuery="supplier quality issues", maxResults=5)
# -> {"registryRecords": [{"name": "agent1-conformance", ...}]}
```

Also available (not used yet): `synchronizationType="URL"` + `synchronizationConfiguration.fromUrl.url`
— the registry can **auto-ingest** an agent card by pointing at the runtime's `.well-known/agent-card.json`
(with OAUTH/IAM credential provider). Future simplification: skip manual card construction.

## Implications for the migration plan

- **Phase 1 must bump `boto3/botocore>=1.43.0`** in every agent/consumer/Lambda requirements file and in the
  agent Docker images. The CDK Custom Resource Lambda must use a runtime/layer with botocore ≥1.43.0.
- Store each agent as an **A2A record** with `schemaVersion=0.3.0`, `agentCard.inlineContent` = the same card
  shape `call_agent.py` already fetches from `.well-known/agent-card.json`. `card["url"]` replaces the
  name→ARN map entirely — no separate ARN field needed.
- `search_agents` (substring) → `search_registry_records` (semantic). `list_agents` → `list_registry_records`
  filtered to APPROVED. `call_agent` resolves the target's card from the record instead of S3 JSON.
- Records need an explicit `submit_registry_record_for_approval` step after create.

## Phase 1 functional test (registry_client.py against live API)

Exercised the real agent-side client against a throwaway registry with 2 A2A records:
- `enabled()`, `list_agent_ids()`, `list_agent_ids(exclude=…)`, `resolve_url(name)` → all exact.
- `resolve_url('nonexistent')` → `None` (correct).
- `resolve_url` recovered the full runtime endpoint URL from `agentCard.inlineContent`.
- **Semantic search caveat:** with only 2 records + ~12s settle, `search("supplier on-time
  delivery problems")` returned `agent1-conformance` (whose description contains "supplier
  quality trends") rather than `agent4-supplier-risk`. Not a client bug — a ranking nuance
  with sparse data / short descriptions / indexing lag. Revisit at full scale (10 rich
  descriptions, longer settle) before relying on search ordering in the demo.

## Throwaway artifacts (deleted)
- `spike_registry.py`, `spike_schema.py` (in job tmp) — created/searched/deleted two throwaway registries.
- venv `/tmp/btc-probe` with botocore 1.43.18 (used to prove the API; not committed).
- No residual AWS resources — both spike registries deleted at end of each run.
