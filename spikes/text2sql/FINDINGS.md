# Spike: Bedrock (Claude) Text-to-SQL over Athena/Iceberg — FINDINGS

**Date:** 2026-07-21 · **Status:** COMPLETE · **Recommendation: GO (high confidence)** with the tuned prompt + a hallucinated-field guard.

Sibling design spikes in this folder: `FINDINGS-backend.md` (where NL->SQL lives + IAM/guardrails),
`FINDINGS-frontend.md` (NL->SQL console UX). This file is the **accuracy / failure-mode** spike.

## Question
Can Amazon Bedrock (Claude) reliably turn NL questions into VALID Amazon Athena
(Presto/Trino) SQL over the single Iceberg table `aerospace_events.domain_events`,
using schema + sample rows as grounding? Measure accuracy, find failure modes.

## Setup (ground truth)
- Models tested: `global.anthropic.claude-sonnet-4-6` (task baseline) **and** `global.anthropic.claude-sonnet-5` (both ACTIVE inference profiles in eu-west-1).
- Invoke: `bedrock-runtime` `invoke_model`, `anthropic_version=bedrock-2023-05-31`, region `eu-west-1`.
  - Sonnet 4.6: `temperature=0`, `max_tokens=1024`.
  - Sonnet 5: **no temperature** (non-default temp/top_p/top_k -> 400 error), `max_tokens=4096`
    (bumped: adaptive thinking is ON by default and the new tokenizer emits ~30% more tokens; a tight
    budget truncates to `stop_reason=max_tokens`). Response parsing picks the `type=="text"` block,
    skipping any adaptive-`thinking` block. Per the Sonnet 5 prompting guide.
- Athena workgroup `aerospace-dashboards`, DB `aerospace_events`, table `domain_events` (976 rows, 14 all-string columns, `payload` = JSON string).
- 10 representative NL questions (`questions.py`), run end-to-end: NL -> Bedrock -> SQL -> **actually executed** on Athena -> validity + rowcount + latency + correctness signals recorded.
- Real data span: `2026-04-22` .. `2026-07-31` (today 2026-07-21), so "last 30 days" / "this month" filters legitimately return rows.

## Headline result — measured over 3 runs x 10 questions per (model, prompt)

| Model | Prompt | **Semantically correct (3x stability)** | Flaky | Always-wrong |
|-------|--------|------------------------------------------|-------|--------------|
| Sonnet 4.6 | v1 (naive: schema + 3 samples) | **24/30 = 80%** | q02, q04 | q08 |
| Sonnet 4.6 | **v3 (tuned)** | **30/30 = 100%** | none | none |
| Sonnet 5   | v1 (naive) | **24/30 = 80%** | none | q07, q08 |
| Sonnet 5   | **v3 (tuned)** | **30/30 = 100%** | none | none |

**Success rate before/after prompt tuning: 80% -> 100%** — and this holds for BOTH models.

### The decisive finding: the prompt fixes it, not the model
A stronger model does **not** rescue a weak prompt. On the naive v1, Sonnet 5 still scored 80% —
it just hallucinated *different* payload field names than 4.6 did (`$.amount` / `$.cellId` instead
of 4.6's `$.productionCell`). Grounding the model with the **payload field catalog (v3)** is what
drives 100%, and it does so model-independently. Sonnet 5's only advantage here was *consistency*:
its 80% was 0 flaky / 2 always-wrong (deterministic errors), vs 4.6's flaky q02/q04 (right some runs,
wrong others). More literal instruction-following (a documented Sonnet 5 trait) shows up as more stable —
but not more correct — SQL when the prompt is under-specified.

### CRITICAL measurement lesson
`valid + non-empty` is a **lying metric**. v1's q08 (`GROUP BY $.productionCell`, a field that does
not exist) *executed fine and returned 1 non-empty row* — a single NULL-keyed bucket of 150. A naive
harness scores that "OK". Sonnet 5's q07 was worse: `SUM(CAST($.amount AS DOUBLE))` on a non-existent
field returns NULL totals with **no error and non-zero row count**. The real feature MUST NOT trust
"the query ran". This spike's scorer adds ground-truth correctness signals (all in `common.py`):
1. **Hallucinated-field check** — regex every `$.field` path in the SQL against the set of payload fields actually present in the table.
2. **NULL-group-key check** — an aggregate whose every group key is NULL grouped on a ghost field.
3. **Empty-when-data-expected** check.
4. **Non-determinism** — even `temperature=0` (4.6) varies run-to-run; only the 3x stability run exposed 4.6's flaky q02/q04. Never trust a single 10/10.

## Top 3 failure modes (v1) and how the prompt fixed them

1. **Hallucinated payload field (most dangerous — silent, always-wrong, both models).**
   "work orders per production cell" -> `$.productionCell` (4.6) / `$.cellId` (S5); real field is `$.cell`.
   "total matched invoice amount" -> `$.amount` (S5); real field is `$.invoiceAmount`. Valid SQL, NULL/empty
   results, no error. **Fix:** v3 embeds a per-event-type **payload field catalog** -> models use real names. 3/3 correct on both.

2. **Guessing case-sensitive string-literal values for scoping (4.6, flaky).**
   q02 filtered `entity_type='PROGRAM'`, q04 `entity_type='DIGITAL_TWIN'`; real values are `'Program'` /
   `'DigitalTwin'` (PascalCase) -> silent 0 rows. **Fix:** rule 5 tells the model to **scope by `event_type`/`domain`**
   (exact values enumerated in the schema) instead of inventing `entity_type` literals. Removes the guess.

3. **Wrong date idiom on a string timestamp.**
   `occurred_at` is an ISO8601 **string**. v1 mixed `from_iso8601_timestamp(...) >= NOW() - INTERVAL...`
   and fragile `substr` forms. **Fix:** rules 4/8 pin exact idioms:
   `occurred_at >= CAST(current_date - INTERVAL 'N' DAY AS VARCHAR)`,
   `CAST(date_trunc('month', current_date) AS VARCHAR)`, and "bucket a day with `substr(occurred_at,1,10)`".

Secondary modes v3 also closes: forgetting `CAST(... AS DOUBLE)` on numeric payload fields (lexical sort);
treating payload fields as top-level columns; the SUPPLIER_SCORE_UPDATED trap where score fields are
**numeric values stored as quoted strings** (still need CAST).

## The winning system prompt (deliverable — reuse this in the real feature)
Lives in `prompts.py` as `V3` = `V2` (dialect + JSON extraction + CAST + date + single-statement rules)
plus a payload field catalog and bucketing/severity/most-recent-period guidance. See prompts.py for the
verbatim text (includes 3 real sample rows). Rule summary:

1. Single SELECT/WITH only; no DDL/DML; query only domain_events.
2. Payload fields via JSON_EXTRACT_SCALAR(payload,'$.field'); never invent top-level columns.
3. CAST(... AS DOUBLE) for any numeric payload comparison/aggregation/ordering.
4. occurred_at is a STRING: last-N-days = occurred_at >= CAST(current_date - INTERVAL 'N' DAY AS VARCHAR); this-month = >= CAST(date_trunc('month', current_date) AS VARCHAR).
5. Scope with event_type / domain (enumerated exact values), NOT guessed entity_type literals.
6. Trino string funcs; single-quoted literals.
7. Aliases for aggregates; LIMIT for top-N.
+ PAYLOAD FIELD CATALOG per event_type (the load-bearing addition).
8. Daily trend -> substr(occurred_at,1,10) AS day, ORDER BY day.
9. critical -> severity='CRITICAL'; critical or major -> IN ('CRITICAL','MAJOR').
10. most recent period -> max(period) / ORDER BY period DESC.

## Invocation notes (carry into the real feature)
- **If you use Sonnet 5:** do NOT pass `temperature`/`top_p`/`top_k` (400 error); parse the `text`
  content block (adaptive thinking may prepend a `thinking` block); give generous `max_tokens`
  (>=2048; we used 4096) so thinking + SQL don't truncate. For this narrow, well-specified extraction
  task, consider `effort: low`/`medium` to cut latency — the task doesn't need deep reasoning once
  grounded. (Sonnet 5 guide: it follows tuned prompts literally; state scope explicitly.)
- **Sonnet 4.6** remains a perfectly good, cheaper choice here: with v3 it also scores 100% and is
  faster (no thinking overhead). For the demo, either model + v3 is safe.

## Latency
Bedrock generation ~1.9-2.8 s (4.6) / 1.9-4.5 s (S5 with thinking); Athena execution ~1-3 s.
End-to-end < 5 s/question — fine for an interactive demo panel.

## Recommendation — GO (high confidence)
Both Claude Sonnet 4.6 and Sonnet 5, with the **v3 grounded prompt**, produced **100% valid +
semantically correct SQL, stable across 3 runs**, for the 10 representative aerospace analytics
questions. Ship it in the demo with these non-negotiable guardrails (proven load-bearing in this spike):

1. **Read-only guardrail** — enforce single-statement SELECT/WITH; reject DDL/DML; query-only IAM + result bucket.
2. **Hallucinated-field guard** — reuse `hallucinated_fields()` to reject/repair before showing results. This is the failure "the query ran" hides; it fired on BOTH models under v1.
3. **Never render "success" on an empty / NULL-keyed / all-NULL-aggregate result** without flagging it.
4. **Keep the payload field catalog fresh** — correctness came from grounding in the *actual* field names. If payloads evolve, regenerate the catalog.

**Confidence: HIGH** for the demo's question set. Residual risk is the open-vocabulary long tail
(event types/fields outside the catalog) — mitigated by guard #2, which fails loudly instead of
returning wrong numbers.

## Files
- `common.py` — Bedrock invoke (model-configurable via `T2SQL_MODEL`/`T2SQL_MAX_TOKENS`; Sonnet-5-aware), SQL extraction, Athena runner, correctness signals.
- `prompts.py` — v1/v2/**v3** system prompts (v3 = deliverable).
- `questions.py` — the 10 NL questions.
- `run_spike.py` — single-pass runner -> `results/<version>_<model>.json`.
- `stability.py` — N-run stability harness -> `results/stability_<model>.json`.
- `results/` — raw per-question SQL + outcomes for v1/v2/v3 (Sonnet 4.6: `*.json`, Sonnet 5: `*_s5`), plus `stability*.json`.
