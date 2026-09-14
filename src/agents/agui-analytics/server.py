"""AG-UI analytics agent — a conversational Strands agent over the aerospace
event lake that presents results as chart + table + prose *widgets* via the
AG-UI protocol (Agent User Interaction), rather than raw text/SQL.

The two render_* tools are FRONTEND tools: they return None and carry no
server-side logic. The agent decides when to show a widget and streams the
tool call (TOOL_CALL_*) over AG-UI/SSE; the browser maps the tool name to a
React component (Recharts chart / table) and paints it from the arguments.
Prose is streamed as normal TEXT_MESSAGE_* events.

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

# Reuse the existing datalake query tools (src/agents/tools/*).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), os.pardir))
from tools.query_datalake_sql import query_datalake_sql  # noqa: E402
from tools.get_datalake_schema import get_datalake_schema  # noqa: E402


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


SYSTEM_PROMPT = """You are the ARES-1 analytics agent over the aerospace event data lake \
(Amazon Athena over Iceberg; table aerospace_events.domain_events, all columns are strings).

For every question:
1. Call get_datalake_schema ONCE to ground yourself in the columns and SQL tips.
2. Write a SINGLE Athena SELECT and call query_datalake_sql(sql) to run it.
3. Present the answer as WIDGETS, then a short prose takeaway. CHOOSE the widget that fits the shape of the answer:
   - a trend over time            -> render_chart(kind='line') — or kind='area' for a volume trend; put the time buckets in categories.
   - a ranking / top-N            -> render_chart(kind='hbar').
   - a share of a total           -> render_chart(kind='pie'), or kind='donut'.
   - a single headline metric     -> render_chart(kind='stat') with value + label.
   - comparing a value across a few categories -> render_chart(kind='bar').
   - record-level detail (several columns) -> render_table.
   You may combine widgets (e.g. a 'stat' headline plus a chart). Then write a 2-3 sentence prose summary of the finding.

Only use numbers returned by query_datalake_sql — never invent data. Keep prose concise."""


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
        tools=[get_datalake_schema, query_datalake_sql, render_chart, render_table],
    )
    return StrandsAgent(
        agent=strands_agent,
        name="analytics_agent",
        description="Analytics over the aerospace event lake, presented as chart + table + prose widgets.",
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
