"""Program handler — Milestone and EV metric nodes.

ISA-95 scope note: program / milestone tracking is outside ISA-95. Milestone
stays as a project extension; we link it to MaterialDefinition via `trackedBy`.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.program')

# Map milestones to the parts they track
MILESTONE_PARTS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']


def handle(event: dict):
    p = event.get('payload', {})
    if p.get('milestoneId') or p.get('milestoneName') or p.get('milestone'):
        _milestone(event)


def _milestone(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    mid = p.get('milestoneId', '') or p.get('milestone', '')

    if not mid:
        return
    if is_processed(eid, mid):
        return

    program = p.get('programId', 'ARES-1')

    batch = GraphBatch(event)
    batch.add_node('Milestone', mid, {
        'milestoneId': mid,
        'milestoneName': p.get('milestoneName', mid),
        'confidence': str(p.get('confidence', '')),
        'status': p.get('status', ''),
        'programId': program,
    })

    # Connect milestone to all tracked MaterialDefinitions
    for pn in MILESTONE_PARTS:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('MaterialDefinition', pn, 'Milestone', mid, 'trackedBy')

    batch.flush()
    mark_processed(eid, mid)
    logger.info('Milestone %s → Neptune (batch)', mid)
