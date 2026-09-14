"""Digital Thread Navigator — a conversational Strands agent that NAVIGATES the
Neptune knowledge graph across domains, then DIVES into the S3 + Iceberg data lake
for detail, presenting both as AG-UI widgets.

The graph is the map: `query_graph` traverses the ISA-95 thread and `render_graph`
lights the path up on the live Thread-page canvas. The lake is the detail:
`query_datalake_sql` pulls the history/values behind a node, rendered as a chart or
table. Real node ids and part numbers found in the graph ground the SQL — the agent
never invents identifiers.

render_graph / render_chart / render_table are FRONTEND tools (return None): the
agent streams the tool call (TOOL_CALL_*) over AG-UI/SSE and the browser paints it.
Prose streams as TEXT_MESSAGE_*.

Serves the AgentCore Runtime AG-UI contract: POST /invocations (SSE) + GET /ping
on port 8080.

Run locally:
    API_GATEWAY_URL="$AerospaceApiGatewayUrl" AWS_PROFILE=your-aws-profile \
    AWS_REGION=eu-west-1 python server.py
"""

import os
import sys
from typing import Optional

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from strands import Agent, tool
from strands.models import BedrockModel

from ag_ui_strands import StrandsAgent
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder

# Reuse the existing graph + datalake query tools (src/agents/tools/*).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))
from tools.query_graph import query_graph  # noqa: E402
from tools.get_graph_schema import get_graph_schema  # noqa: E402
from tools.query_datalake_sql import query_datalake_sql  # noqa: E402
from tools.get_datalake_schema import get_datalake_schema  # noqa: E402


@tool
def render_graph(title: str, node_ids: list, caption: Optional[str] = None) -> None:
    """Highlight a set of nodes (a path or neighbourhood) on the live digital-thread
    graph for the user. FRONTEND tool — returns None; the browser lights these nodes
    up on the Thread-page canvas and zooms to fit them.

    Use this to SHOW the cross-domain path you traced before diving into detail.

    Args:
        title: short title for the widget card (e.g. 'Bore defect — cross-domain path').
        node_ids: the exact node ids to highlight, as returned by query_graph
                  (e.g. ['SN-0047', 'DWG-44821-003-001', 'NCR-...']), in thread order.
        caption: one short sentence describing what the path shows.
    """
    return None


@tool
def render_drawing(title: str, s3_key: str, caption: Optional[str] = None) -> None:
    """Display a PLM-published drawing (a 2D engineering drawing — unstructured artifact)
    inline for the user. FRONTEND tool — returns None; the browser fetches a presigned
    URL for the S3 key and renders the actual image.

    Use this when a graph node carries a `drawingS3Key` property (e.g. a
    ProductDefinitionDocument): show the real published drawing, not just its id.

    Args:
        title: short title for the widget card (e.g. 'DWG-44821-003 rev C').
        s3_key: the node's `drawingS3Key` property value, exactly as returned by query_graph.
        caption: one short sentence on what the drawing shows.
    """
    return None


@tool
def render_chart(
    title: str,
    kind: str,
    categories: Optional[list] = None,
    values: Optional[list] = None,
    series: Optional[list] = None,
    series_label: Optional[str] = None,
    value: Optional[float] = None,
    label: Optional[str] = None,
    unit: Optional[str] = None,
) -> None:
    """Render a chart or KPI inline for the user. FRONTEND tool — returns None; the UI paints it from these args.

    Pick the `kind` that fits the question:
      - 'bar'   vertical bars — compare one metric across a few categories. Needs categories + values.
      - 'hbar'  horizontal bars — rankings / top-N (long labels read better sideways). Needs categories + values.
      - 'line'  a trend along an ordered axis (usually time). Needs categories (x-axis) + values,
                or categories + series for several lines.
      - 'area'  like line but filled — good for volume/cumulative trends over time. Same args as 'line';
                multiple series stack.
      - 'pie'   share of a whole. Needs categories + values.
      - 'donut' share of a whole, as a ring. Needs categories + values.
      - 'stat'  a single headline number. Needs value + label (+ optional unit); no categories.

    Args:
        title: title shown above the widget.
        kind: one of 'bar', 'hbar', 'line', 'area', 'pie', 'donut', 'stat'.
        categories: x-axis / slice labels (strings), in display order. Omit for 'stat'.
        values: numeric values aligned 1:1 with categories (single series). Omit when using `series`.
        series: for multi-series line/area — a list of {"name": <str>, "values": [<numbers>]},
                each values array aligned 1:1 with categories.
        series_label: legend / series name for a single-series bar/hbar/line/area.
        value: the single number to show for kind='stat'.
        label: what the 'stat' number measures (e.g. 'open NCRs').
        unit: optional unit shown after a 'stat' value (e.g. '%', 'days').
    """
    return None


@tool
def render_table(title: str, columns: list, rows: list) -> None:
    """Render a data table inline for the user. FRONTEND tool — returns None; the UI paints it.

    Args:
        title: table title shown above the widget.
        columns: column header names, in display order.
        rows: list of rows; each row is a list of cell values aligned 1:1 with columns.
    """
    return None


SYSTEM_PROMPT = """You are the ARES-1 Digital Thread Navigator. You help a user explore ONE serial \
number's digital thread across domains on a Neptune knowledge graph (ISA-95:2018), and drill into the \
S3 + Iceberg data lake (Amazon Athena; table aerospace_events.domain_events, all columns strings) for the \
detail behind a node.

The GRAPH is the map; the LAKE is the detail. For each question:
1. Ground yourself: get_graph_schema once (and get_datalake_schema once only if you will query the lake).
2. NAVIGATE with query_graph (get_thread_state for a serial's thread; traverse / query_neighbors / get_node \
to follow edges across domains) to find the relevant nodes.
3. SHOW the path: render_graph(title, node_ids=[the EXACT ids query_graph returned], caption). Always do this \
once you have a path — it lights the cross-domain path up on the canvas.
4. If a node carries a `drawingS3Key` property (e.g. a ProductDefinitionDocument published by PLM), \
render_drawing(title, s3_key=<that exact value>, caption) to show the actual 2D drawing inline.
5. DIVE only if it adds detail the graph lacks: ONE Athena SELECT via query_datalake_sql on a REAL identifier \
from the graph, shown as ONE render_chart or render_table.

GROUNDING — strict; a customer's own engineers will check every figure on screen:
- Every number, id, status, date and name you state MUST appear verbatim in a tool result from THIS \
conversation. Never invent, estimate, or round.
- State each figure EXACTLY ONCE. Never re-sum, re-count, or restate a total a different way; quote the count \
a tool returned rather than deriving your own.
- Do NOT infer causation or a link across domains that no tool returned (e.g. never tie a structural part to \
fuel-system telemetry).
- Do NOT cite specific regulation clause numbers (AS9100 / FAR / etc.).
- Do NOT editorialize severity, risk, or qualification beyond the field values returned.
- If tool results look inconsistent, report only what a single query returned — never stitch a narrative that \
reconciles or combines contradictory facts.

STYLE: terse. At most ONE short sentence of prose per widget; let the widgets carry the answer. No long \
multi-domain essay."""


def build_agui_agent() -> StrandsAgent:
    model = BedrockModel(
        model_id=os.environ.get("MODEL_ID", "global.anthropic.claude-sonnet-4-6"),
        temperature=0,
        max_tokens=4096,
        region_name=os.environ.get("AWS_REGION", "eu-west-1"),
        # Bedrock Guardrail applied only when both are set (empty => no guardrail).
        guardrail_id=os.environ["GUARDRAIL_ID"],
        guardrail_version=os.environ["GUARDRAIL_VERSION"],
    )
    strands_agent = Agent(
        model=model,
        system_prompt=SYSTEM_PROMPT,
        tools=[
            get_graph_schema, query_graph,
            get_datalake_schema, query_datalake_sql,
            render_graph, render_drawing, render_chart, render_table,
        ],
    )
    return StrandsAgent(
        agent=strands_agent,
        name="thread_navigator",
        description="Navigates the Neptune digital thread across domains and dives into the lake, as graph + chart + table + prose widgets.",
    )


agui_agent = build_agui_agent()
app = FastAPI()


@app.post("/invocations")
async def invocations(input_data: dict, request: Request):
    """AG-UI endpoint: returns an SSE event stream (RUN_STARTED … TOOL_CALL_* … TEXT_MESSAGE_* … RUN_FINISHED)."""
    encoder = EventEncoder(accept=request.headers.get("accept"))

    async def event_generator():
        run_input = RunAgentInput(**input_data)
        async for event in agui_agent.run(run_input):
            yield encoder.encode(event)

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


@app.get("/ping")
async def ping():
    return JSONResponse({"status": "Healthy"})


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
