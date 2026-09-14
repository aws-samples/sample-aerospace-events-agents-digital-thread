"""
Certification Readiness Agent — Strands agent that assesses whether
an event satisfies, partially satisfies, or creates gaps in
certification requirements.

This is the "agent as infrastructure" pattern — runs inline in the
consumer pipeline, produces structured outputs, never initiates actions.
"""

import json
import logging
import os

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.hooks import (
    HookProvider, HookRegistry,
    BeforeInvocationEvent, AfterInvocationEvent,
)

logger = logging.getLogger(__name__)

MODEL_ID = os.environ.get('BEDROCK_MODEL_ID', 'global.anthropic.claude-sonnet-4-6')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')

SYSTEM_PROMPT = """You are the Certification Readiness Agent for the ARES-1 aerospace program.
You assess whether events satisfy, partially satisfy, or create gaps in certification requirements.

For each event you receive, analyze it against DO-178C, AS9100, and FAR-21 requirements and produce a structured JSON assessment.

Rules:
- confidence < 0.7 must produce verdict_type "PARTIAL"
- NEVER produce "SATISFIES" with confidence < 0.85
- A NON_CONFORMANCE_RAISED on a flight-critical part (P/N 44821-003, 55192-001) ALWAYS produces a THREAD_GAP
- severity CRITICAL always produces gap_type OPEN_NCR with severity HIGH
- severity MAJOR produces gap_type OPEN_NCR with severity MEDIUM

Always respond with ONLY a JSON object (no markdown, no explanation):
{
  "verdict_type": "SATISFIES" | "PARTIAL" | "INSUFFICIENT" | "THREAD_GAP",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation",
  "completeness_delta": -1.0 to 1.0,
  "gaps_opened": [
    {
      "gap_type": "OPEN_NCR" | "MISSING_EVIDENCE" | "INCOMPLETE_TEST",
      "description": "what is missing",
      "severity": "HIGH" | "MEDIUM" | "LOW"
    }
  ],
  "gaps_closed": []
}
"""


class CertAgentHooks(HookProvider):
    """Logs agent lifecycle events for the cert readiness agent."""

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.on_start)
        registry.add_callback(AfterInvocationEvent, self.on_end)

    def on_start(self, event: BeforeInvocationEvent) -> None:
        logger.info('=== Cert Readiness Agent invocation started ===')

    def on_end(self, event: AfterInvocationEvent) -> None:
        logger.info('=== Cert Readiness Agent invocation completed ===')


def assess_cert_readiness(event: dict) -> dict | None:
    """Invoke the Strands Cert Readiness Agent on an event."""
    try:
        model = BedrockModel(
            model_id=MODEL_ID,
            region_name=REGION,
            # Bedrock Guardrail applied only when both are set (empty => no guardrail).
            guardrail_id=os.environ['GUARDRAIL_ID'],
            guardrail_version=os.environ['GUARDRAIL_VERSION'],
        )

        agent = Agent(
            model=model,
            system_prompt=SYSTEM_PROMPT,
            hooks=[CertAgentHooks()],
        )

        prompt = f"""Assess this aerospace event for certification readiness:

Event Type: {event.get('eventType')}
Entity ID: {event.get('entityId')}
Domain: {event.get('domain')}
Payload: {json.dumps(event.get('payload', {}), indent=2)}

Respond with ONLY the JSON assessment object."""

        result = agent(prompt)
        response_text = str(result)

        # Parse JSON from response
        # Try to find JSON in the response
        start = response_text.find('{')
        end = response_text.rfind('}') + 1
        if start >= 0 and end > start:
            verdict = json.loads(response_text[start:end])
            logger.info('Agent verdict: %s (confidence=%.2f)',
                        verdict.get('verdict_type'), verdict.get('confidence', 0))
            return verdict

        logger.warning('Agent response did not contain valid JSON: %s', response_text[:200])
        return None

    except Exception as e:
        logger.error('Cert readiness agent error: %s', e)
        # Fallback: produce a gap for any NCR on a critical part
        payload = event.get('payload', {})
        pn = payload.get('partNumber', '')
        severity = payload.get('severity', 'MINOR')

        if pn in ('44821-003', '55192-001'):
            gap_severity = 'HIGH' if severity == 'CRITICAL' else 'MEDIUM'
            return {
                'verdict_type': 'THREAD_GAP',
                'confidence': 0.6,
                'reasoning': f'Fallback: NCR on flight-critical part {pn} (agent error: {e})',
                'completeness_delta': -0.1,
                'gaps_opened': [{
                    'gap_type': 'OPEN_NCR',
                    'description': f'Open NCR on {pn}: {payload.get("defectCode", "unknown")}',
                    'severity': gap_severity,
                }],
                'gaps_closed': [],
            }
        return None
