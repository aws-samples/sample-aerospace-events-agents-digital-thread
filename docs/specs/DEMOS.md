# Demo Set — Aerospace Events Agents Digital Thread

Twelve focused demos, each proving a different pillar of the architecture. Every demo is
a continuous screen recording + a markdown walkthrough with hero stills and live
evidence, under `docs/specs/<name>-demo/`. All run against the live deployed pipeline
(eu-west-1); the frontend runs locally and is driven with Playwright.

## ⭐ Start here — the Hero demo

**[The whole picture, end to end](hero-demo/README.md)** — one continuous take following a
single serial number from design to fleet across every system, with 10 AI agents driving the
process and humans deciding. The twelve demos below each zoom into one pillar of it.

| # | Demo | Proves | Trigger |
|---|------|--------|---------|
| 1 | [**Drawings as unstructured data**](drawing-demo/README.md) | Unstructured artifacts (2D drawings) linked on the graph + read by an agent with **Bedrock vision** | seeded baseline |
| 2 | [**ISA-95 normalization**](normalizer-demo/README.md) | Legacy vendor vocab → **canonical ISA-95** at the MSK boundary; one normalizer, every consumer benefits | seeded baseline |
| 3 | [**The Cascade**](cascade-demo/README.md) | The **event-driven backbone** — one defect → many systems → many agents → **A2A** handoffs → auditable **swim-lane trace** | `ncr-cluster` |
| 4 | [**Humans Decide**](hitl-demo/README.md) | **Human-in-the-loop** governance — agents prepare a disposition, pause on `ask_human`, resume on the human's decision | `single-ncr` |
| 5 | [**Live Shop Floor**](scada-demo/README.md) | Real-time **MQTT/SCADA** telemetry → IoT rule → predictive-maintenance agent (the only live-telemetry surface) | `bearing-wear` |
| 6 | [**The Digital Thread**](thread-demo/README.md) | The **Neptune knowledge graph** — full lifecycle of one serial number + the slow consumer's **certification-readiness** gaps & verdicts | seeded baseline |
| 7 | [**The Datalake**](datalake-demo/README.md) | The **S3 + Iceberg** history queried live from the frontend — **Athena over Iceberg** via API Gateway, widening 7d → 30d → 90d | seeded baseline |
| 8 | [**Datalake Analytics**](datalake-analytics-demo/README.md) | The whole lake as a page: cross-domain heatmap + business KPIs (CPI/SPI, milestones) + **text-to-SQL** — ask in plain language, **Claude writes the Athena SQL**, it runs live | seeded baseline |
| 9 | [**Agent Observability**](agent-observability-demo/README.md) | Every agent **run** across the fleet — completed or not — searchable by id/entity/agent with derived status; click a run → the **existing trace drawer**, unchanged | seeded baseline |
| 10 | [**Cross-silo write-back**](crosssilo-demo/README.md) | A Business-Applications agent **queries** the thread + lake, a **human authorizes** (HITL), then the agent **writes the disposition back to the QMS** system of record — all through the governed gateway | `ncr-cluster` |
| 12 | [**Thread navigator**](thread-navigator-demo/README.md) | A second **AG-UI** agent on the digital thread — traverses the **Neptune graph across domains**, lights the path on the live graph, reads the **PLM drawing**, dives into the lake and answers follow-ups | seeded baseline |
| 11 | [**AG-UI generative analytics**](agui-demo/README.md) | **Beyond text-to-SQL** — the analytics agent runs Athena and streams back the widgets it *chose* (chart · table · prose) as a **follow-up conversation**, over the **AG-UI protocol** on AgentCore Runtime | seeded baseline |

## How they fit together

- **1 + 2** are about *getting data in well*: heterogeneous, legacy, structured and
  unstructured sources, all normalized to one ISA-95 vocabulary on the graph.
- **3 + 4** are about *agents acting on it*: the event backbone fans work out to many
  agents that collaborate (3) but never decide regulated outcomes alone (4).
- **5** is the *real-time edge*: the MQTT telemetry path, distinct from the Kafka
  event path, with its own flood-control.
- **6** is the *whole*: everything the other demos produce, reconstructed as one
  cross-domain graph with certification readiness on top.
- **7** is the *long memory*: the same event stream fanned to S3 + Iceberg, queried
  live as 90 days of history — the operational lake doubling as the analytics store.
- **8** turns that lake into an *analytics surface*: a cross-domain heatmap, business-first
  KPIs, and a **text-to-SQL** console — plain-language questions that Claude turns into
  Athena SQL and runs live.
- **9** makes the *agents themselves* observable: every run listed and searchable, status
  derived from the action stream, reusing the trace drawer to open any one.
- **10** is the cross-silo *value* pattern end to end: a cross-domain read → a governed
  human decision (HITL) → an audited write-back to a regulated system of record (QMS).
- **11** turns analytics into a *conversation*: the agent composes each answer as
  chart/table/prose widgets over the AG-UI protocol, following up in context.
- The **[Hero demo](hero-demo/README.md)** is all of the above in one continuous take —
  digital continuity (design -> build -> fleet on one thread) plus agents driving the process
  with humans in control.

## Re-recording a demo Recording recipe, in short:
seed the baseline (or inject the scenario), run the frontend locally, drive it with a
Playwright video-recording script, transcode the `.webm` to MP4, and verify the key
frames landed. Scenarios inject via Demo Control (`inject-drama`); the trace drawer is
deep-linkable (`#/<dashboard>?trace=<correlationId>`) for deterministic capture.
