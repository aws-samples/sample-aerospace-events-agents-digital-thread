"""SCADA handler — Equipment status updates from IoT→MSK events.

ISA-95: Machine → Equipment (level=WorkUnit). Equipment is linked to its
WorkCenter via `locatedIn` using the static cell→WorkCenter map (L2).
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.scada')

# Mirrors config/master-data/hierarchy.json — cellId → WorkCenter ID.
CELL_WORKCENTER = {
    'cell-1': 'CELL-1',
    'cell-2': 'CELL-2',
    'cell-3': 'CELL-3',
    'cell-4': 'CELL-4',
    'cell-5': 'CELL-5',
}


def handle(event: dict):
    p = event.get('payload', {})
    eid = event.get('eventId', '')
    machine = p.get('machineId', '')

    if not machine or not eid:
        return
    if is_processed(eid, machine):
        return

    cell = p.get('cellId', '')
    props = {
        'machineId': machine,
        'cellId': cell,
        'status': p.get('status', 'NORMAL'),
    }

    metric = p.get('metric', '')
    value = p.get('value', '')
    if metric == 'oee_percent':
        props['lastOee'] = str(value)
    elif metric == 'spindle_vibration_mm_s':
        props['lastVibration'] = str(value)
    elif metric == 'temperature_c':
        props['lastTemperature'] = str(value)

    batch = GraphBatch(event)
    batch.add_node('Equipment', machine, props)
    wc = CELL_WORKCENTER.get(cell, '')
    if wc:
        batch.add_edge('Equipment', machine, 'WorkCenter', wc, 'locatedIn')
    batch.flush()

    mark_processed(eid, machine)
    logger.info('Machine %s → Neptune', machine)
