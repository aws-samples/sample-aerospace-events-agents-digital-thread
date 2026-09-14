#!/usr/bin/env python3
"""
Generate a scripted scenario JSONL using a Strands agent graph.

Graph topology (per-domain nodes with incremental validation):
  PLM → ERP → SRM → MES → WMS → DHR → QMS → Program → Live → FinalValidate

Each domain node generates + appends its events. On validation failure,
only that domain retries — no full rebuild.

Usage:
  export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1
  python3 scripts/generate-scenario.py
  python3 scripts/generate-scenario.py --model global.anthropic.claude-haiku-4-5-20251001-v1:0
"""

import argparse
import json
import logging
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

LOG_FILE = os.path.join(SCRIPT_DIR, 'scenarios', 'generate.log')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(name)s %(levelname)s %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE, mode='w'),
    ],
)
logging.getLogger('strands.multiagent').setLevel(logging.DEBUG)
logger = logging.getLogger('scenario-gen')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--outline', default=os.path.join(SCRIPT_DIR, 'scenarios', 'ares1-outline.yaml'))
    parser.add_argument('--output', default=None)
    parser.add_argument('--sop', default=os.path.join(SCRIPT_DIR, 'scenarios', 'scenario-author.sop.md'))
    parser.add_argument('--model', default='global.anthropic.claude-haiku-4-5-20251001-v1:0')
    args = parser.parse_args()

    if args.output is None:
        base = os.path.splitext(os.path.basename(args.outline))[0]
        args.output = os.path.join(SCRIPT_DIR, 'scenarios', f'{base}.jsonl')

    with open(args.sop) as f:
        sop_content = f.read()
    with open(args.outline) as f:
        outline_content = f.read()

    logger.info('Output: %s', args.output)
    logger.info('Model:  %s', args.model)

    try:
        from strands import Agent
        from strands.models.bedrock import BedrockModel
        from strands.multiagent import GraphBuilder
        from strands.hooks.events import AfterToolCallEvent, BeforeToolCallEvent, AfterInvocationEvent
        from strands.hooks import HookProvider, HookRegistry
        from strands import tool
        from strands_tools import file_read
        from botocore.config import Config
    except ImportError as e:
        print(f'ERROR: {e}\nRun: pip install strands-agents strands-agents-tools')
        sys.exit(1)

    @tool
    def write_jsonl(file_path: str, content: str, append: bool = False) -> str:
        """Write or append content to a JSONL file. No confirmation required.

        Args:
            file_path: Path to the file
            content: JSONL content (one JSON object per line)
            append: If true, append to existing file. If false, overwrite.

        Returns:
            Confirmation with line count
        """
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        mode = 'a' if append else 'w'
        with open(file_path, mode) as f:
            f.write(content)
            if not content.endswith('\n'):
                f.write('\n')
        lines = sum(1 for l in content.strip().split('\n') if l.strip())
        total = sum(1 for l in open(file_path) if l.strip())
        logger.info('write_jsonl(%s): %s — +%d lines (total: %d)', 'append' if append else 'write', file_path, lines, total)
        return f'{"Appended" if append else "Written"} {lines} lines to {file_path} (total: {total})'

    class ScenarioHooks(HookProvider):
        """Log agent tool calls and completion for debugging."""
        def __init__(self, name: str):
            self.name = name

        def register_hooks(self, registry: HookRegistry) -> None:
            registry.add_callback(BeforeToolCallEvent, self.on_tool_start)
            registry.add_callback(AfterToolCallEvent, self.on_tool_end)
            registry.add_callback(AfterInvocationEvent, self.on_done)

        def on_tool_start(self, event: BeforeToolCallEvent, **kwargs):
            tool_name = event.tool_use.get('name', '?') if isinstance(event.tool_use, dict) else getattr(event.tool_use, 'name', '?')
            logger.info('[%s] Tool start: %s', self.name, tool_name)

        def on_tool_end(self, event: AfterToolCallEvent, **kwargs):
            tool_name = event.tool_use.get('name', '?') if isinstance(event.tool_use, dict) else getattr(event.tool_use, 'name', '?')
            logger.info('[%s] Tool done: %s', self.name, tool_name)

        def on_done(self, event: AfterInvocationEvent, **kwargs):
            logger.info('[%s] Agent completed', self.name)

    region = os.environ.get('AWS_REGION', 'eu-west-1')
    bedrock_config = Config(read_timeout=1000)
    max_tokens = 64000 if 'haiku' in args.model else 128000

    def make_model():
        return BedrockModel(
            model_id=args.model, region_name=region,
            max_tokens=max_tokens, boto_client_config=bedrock_config,
        )

    output = args.output

    # Clear file
    with open(output, 'w') as f:
        pass

    # ── Domain-specific prompts ──────────────────────────────────────

    parts_dir = os.path.join(os.path.dirname(output), 'parts')
    os.makedirs(parts_dir, exist_ok=True)

    common_rules = f"""
## Output
Write your events to a DEDICATED file using write_jsonl. ONE JSON object per line (JSONL format).

Your output file: {{domain_file}}

Use write_jsonl to write events. You can write all at once or in batches with append=true.
Each line is one compact JSON object:
{{"t_sec":0,"phase":"seed","domain":"plm","table":"plm-demo","item":{{"PK":"...","SK":"...","field":"value"}}}}

CRITICAL FORMAT RULES:
- ONE JSON object per line — no multiline JSON, no indentation
- Use write_jsonl with the complete file content (all lines)
- Do NOT use shell/echo — use write_jsonl tool only
- Use append=true to add events in batches if needed

## Data Rules
- Seed: phase="seed", t_sec=0, lastModifiedBy="seed-baseline"
- Live: phase="live", t_sec from outline, lastModifiedBy="gen-scenario"
- Timestamps: seed spread across 2025-12-27 to 2026-03-27, live use 2026-03-27T12:00:00.000Z + t_sec
- Numbers (not strings): unitCost, spi, cpi, bcwp, bcws, acwp, expectedValue, actualValue, deviation
- Strings: otdPercent, qualityScore, overallScore
- Every event MUST have fields: t_sec, phase, domain, table, item
- Use UNIQUE PK+SK for every event (no duplicates)
"""

    domains = [
        ('plm', 'plm-demo', """Generate PLM seed events:
- 5 parts × 3 revisions each (A, B, current) = 15 part releases
- 5 drawings × 3 revisions each = 15 drawing releases
- 30 ECOs: ECO-80001 to ECO-80030 (6 per part, spread across 90 days, different descriptions)
Total: ~60 events"""),

        ('erp', 'erp-demo', """Generate ERP seed events:
- 80 POs: PO-80001 to PO-80080 (~27 per supplier, each referencing different parts)
  - titan-forge: PO-80001..80027
  - apex-aero: PO-80028..80054
  - nordic-precision: PO-80055..80080
- 80 receipts: RCPT-80001 to RCPT-80080 (one per PO, with unique lot numbers LOT-7731 through LOT-7810)
  - IMPORTANT: each receipt MUST include poNumber field referencing its PO (e.g. RCPT-80001 references PO-80001)
  - onTime=true for all (seed is smooth history)
  - Lot numbers MUST be LOT-7731 through LOT-7810 (these same lots are used in WMS kits)
Total: ~160 events"""),

        ('srm', 'srm-demo', """Generate SRM seed events:
- 3 suppliers × 6 monthly periods (2025-10 through 2026-03) = 18 score updates
- All QUALIFIED (overall >= 80) in seed
- Use SK format: SCORE#YYYY-MM
- Use different OTD and quality scores (85-96 range) for variety
Total: ~18 events"""),

        ('mes1', 'mes-demo', """Generate MES seed events BATCH 1:
- 125 completed work orders: WO-80001 to WO-80125
- Parts: 44821-003 (25 WOs), 44821-007 (25 WOs), 44821-012 (25 WOs), 55192-001 (25 WOs), 55192-004 (25 WOs)
- Distribute across Op-40 through Op-80, cells, operators
- Each WO: METADATA (status=COMPLETED) + OP completion record, serialNumber=SN-0047
Total: ~250 events"""),

        ('mes2', 'mes-demo', """Generate MES seed events BATCH 2:
- 125 completed work orders: WO-80126 to WO-80250
- Parts: 44821-003 (25 WOs), 44821-007 (25 WOs), 44821-012 (25 WOs), 55192-001 (25 WOs), 55192-004 (25 WOs)
- Distribute across Op-40 through Op-80, cells, operators
- Each WO: METADATA (status=COMPLETED) + OP completion record, serialNumber=SN-0047
Total: ~250 events"""),

        ('wms1', 'wms-demo', """Generate WMS seed events BATCH 1:
- 125 kits: KIT-80001 to KIT-80125 (one per WO-80001..80125)
- All STAGED, no shortages
- IMPORTANT: lotNumber MUST use LOT-7731 through LOT-7810 (cycle: KIT-80001→LOT-7731, KIT-80002→LOT-7732, ..., KIT-80080→LOT-7810, KIT-80081→LOT-7731, ...)
  These MUST match the lots created in ERP receipts for graph connectivity
Total: ~125 events"""),

        ('wms2', 'wms-demo', """Generate WMS seed events BATCH 2:
- 125 kits: KIT-80126 to KIT-80250 (one per WO-80126..80250)
- All STAGED, no shortages
- IMPORTANT: lotNumber MUST use LOT-7731 through LOT-7810 (cycle), matching ERP receipt lots
Total: ~125 events"""),

        ('dhr1', 'dhr-demo', """Generate DHR seed events BATCH 1 — operation sign-offs:
- 125 sign-offs for WO-80001..80125 (use OP#Op-XX#epoch as SK, UNIQUE epoch per event)
- Each sign-off MUST include partNumber (matching the WO's part) for graph connectivity
- All reference SN-0047, spread across 90-day period
Total: ~125 events"""),

        ('dhr2', 'dhr-demo', """Generate DHR seed events BATCH 2 — sign-offs + certs + tests:
- 125 sign-offs for WO-80126..80250
- 50 certificates: CERT-80001 to CERT-80050 (12-13 per type)
  IMPORTANT: Each cert item MUST include partNumber and lotNumber fields for graph edges:
  "partNumber": one of the 5 part numbers, "lotNumber": one of LOT-7731..LOT-7810
- 50 test records: TEST-80001 to TEST-80050 (10 per type, all PASS)
  IMPORTANT: Each test item MUST include partNumber and workOrderId fields for graph edges:
  "partNumber": one of the 5 part numbers, "workOrderId": one of WO-80001..WO-80250
- All reference SN-0047
Total: ~225 events"""),

        ('qms', 'qms-demo', """Generate QMS seed events:
- 50 NCRs: NCR-80001 to NCR-80050
- Mix of severities: 35 MINOR (status=CLOSED), 8 MAJOR (status=DISPOSITIONED), 4 MINOR (status=OPEN), 2 MAJOR (status=OPEN), 1 CRITICAL (status=CLOSED)
- Distribute across all 5 defect codes
- Distribute across all 3 suppliers and 5 parts
- Use different lot numbers from LOT-7731..LOT-7810
- All reference SN-0047
Total: ~50 events"""),

        ('program', 'program-demo', """Generate Program seed events:
- 5 milestones: CDR (confidence=100), PDR (confidence=100), FAI-Complete (confidence=78), First-Flight (confidence=65), Type-Cert (confidence=55)
  - All ON_TRACK (confidence >= 70 for CDR/PDR/FAI, the others are future milestones)
- 18 EV metric updates (3 per month 2025-10 to 2026-03, SPI 0.98-1.05, CPI 0.97-1.03)
Total: ~23 events"""),
    ]

    # ── Build domain agents ──────────────────────────────────────────

    builder = GraphBuilder()
    prev_node = None

    for domain, table, instructions in domains:
        domain_file = os.path.join(parts_dir, f'seed_{domain}.jsonl')
        rules = common_rules.replace('{domain_file}', domain_file)
        prompt = f"""You are generating {domain.upper()} events for the ARES-1 scenario.

{instructions}

{rules}

## Data Model Reference (from SOP)
{sop_content[sop_content.find('### DynamoDB Table Schemas'):sop_content.find('### Smooth vs Drama')]}

Generate ALL events now. Write them to {domain_file} using write_jsonl."""

        agent = Agent(
            name=f'gen_{domain}',
            model=make_model(),
            system_prompt=prompt,
            tools=[write_jsonl, file_read],
            hooks=[ScenarioHooks(f'gen_{domain}')],
        )
        node_id = f'seed_{domain}'
        builder.add_node(agent, node_id)
        if prev_node:
            builder.add_edge(prev_node, node_id)
        prev_node = node_id

    # ── Live events node ─────────────────────────────────────────────

    live_file = os.path.join(parts_dir, 'live.jsonl')
    live_rules = common_rules.replace('{domain_file}', live_file)
    live_prompt = f"""You are generating LIVE events for the ARES-1 scenario (10-minute replay).

## Outline (live phase only)
```yaml
{outline_content[outline_content.find('live:'):]}
```

{live_rules}

## Data Model Reference (from SOP)
{sop_content[sop_content.find('### DynamoDB Table Schemas'):sop_content.find('### Smooth vs Drama')]}

Generate ALL live events from the outline above (~54 events, t_sec 0 through 600).
Drama events MUST match the outline exactly (NCR-90001 MAJOR, titan-forge CONDITIONAL, hydraulic ANOMALY).
Write them to {live_file} using write_jsonl."""

    live_agent = Agent(
        name='gen_live',
        model=make_model(),
        system_prompt=live_prompt,
        tools=[write_jsonl, file_read],
        hooks=[ScenarioHooks('gen_live')],
    )
    builder.add_node(live_agent, 'live')
    builder.add_edge(prev_node, 'live')

    builder.set_entry_point(f'seed_{domains[0][0]}')
    builder.set_execution_timeout(1200)  # 20 min for 12 nodes
    builder.set_max_node_executions(len(domains) + 1)

    graph = builder.build()

    # ── Run ──────────────────────────────────────────────────────────

    logger.info('Starting generation graph (%d domain nodes + live)', len(domains))
    result = graph('Generate all events for the ARES-1 lifecycle scenario.')

    logger.info('Graph finished — status: %s', result.status)
    for node in result.execution_order:
        logger.info('  %s: %s (%.1fs)', node.node_id, node.execution_status, node.execution_time)

    # ── Concatenate part files into final output ────────────────────
    logger.info('Concatenating part files into %s', output)
    with open(output, 'w') as out:
        # Seed files first (in dependency order), then live
        part_order = [f'seed_{d[0]}.jsonl' for d in domains] + ['live.jsonl']
        for part_name in part_order:
            part_path = os.path.join(parts_dir, part_name)
            if not os.path.exists(part_path):
                logger.warning('  Missing: %s', part_name)
                continue
            count = 0
            with open(part_path) as pf:
                for line in pf:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        json.loads(line)  # validate
                        out.write(line + '\n')
                        count += 1
                    except json.JSONDecodeError:
                        pass  # skip invalid lines
            logger.info('  %s: %d events', part_name, count)

    # ── Report ───────────────────────────────────────────────────────
    if os.path.exists(output):
        from collections import Counter
        domains_count = Counter()
        seed = live_count = errors = 0
        with open(output) as f:
            for line in f:
                try:
                    e = json.loads(line.strip())
                    if e.get('phase') == 'seed': seed += 1
                    else: live_count += 1
                    domains_count[e.get('domain', '?')] += 1
                except: errors += 1
        logger.info('Output: %s', output)
        logger.info('  Total: %d (seed=%d, live=%d, errors=%d)', seed + live_count, seed, live_count, errors)
        for d, c in domains_count.most_common():
            logger.info('    %s: %d', d, c)
    else:
        logger.warning('Output file not found')


if __name__ == '__main__':
    main()
