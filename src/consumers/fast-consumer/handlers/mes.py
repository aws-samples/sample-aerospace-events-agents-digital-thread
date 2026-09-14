"""MES handler — JobResponse + Equipment, operation tracking. Uses batch writes.

ISA-95: every event currently emitted is post-execution status, so we map to
JobResponse. Plan/actual split (separate JobOrder nodes) is L2 work.
"""

import logging
from graph_writer import GraphBatch, update_node, is_processed, mark_processed

logger = logging.getLogger('handler.mes')

CELL_MACHINE = {
    'cell-1': 'cnc-mill-1',
    'cell-2': 'cnc-mill-2',
    'cell-3': 'cnc-mill-3',
    'cell-4': 'lathe-1',
    'cell-5': 'drill-press-1',
}

# ISA-95 hierarchy: cellId → WorkCenter ID. Mirrors config/master-data/hierarchy.json.
# Kept as a static dict so handlers don't need a runtime lookup against the graph.
CELL_WORKCENTER = {
    'cell-1': 'CELL-1',
    'cell-2': 'CELL-2',
    'cell-3': 'CELL-3',
    'cell-4': 'CELL-4',
    'cell-5': 'CELL-5',
}


def handle(event: dict):
    et = event.get('eventType', '')
    if et == 'WORK_ORDER_RELEASED':
        _wo_released(event)
    elif et in ('WORK_ORDER_STARTED', 'WO_STARTED'):
        _wo_started(event)
    elif et in ('OPERATION_COMPLETED', 'WORK_ORDER_COMPLETED', 'WO_COMPLETED'):
        _op_completed(event)
    elif et in ('HOLD_PLACED', 'HOLD_RELEASED', 'WO_HOLD'):
        _hold_placed(event)


def _wo_released(event: dict):
    """ISA-95 L2: WORK_ORDER_RELEASED → JobOrder node (the planned intent)."""
    p = event.get('payload', {})
    eid = event['eventId']
    wo = p.get('workOrderId', event['entityId'])

    # Distinct dedup key per phase so RELEASED + STARTED both register
    if is_processed(eid, f'order-{wo}'):
        return

    pn = p.get('partNumber', '')
    sn = p.get('serialNumber', '')
    op_num = p.get('operationNumber', '')

    operator = p.get('assignedOperator', '')

    batch = GraphBatch(event)
    batch.add_node('JobOrder', wo, {
        'workOrderId': wo,
        'isaClass': 'JobOrder',
        'status': 'RELEASED',
        'cell': p.get('cell', ''),
        'operationNumber': op_num,
        'operationName': p.get('operationName', ''),
        'requestedOperator': operator,
        'scheduledStart': p.get('scheduledStart', ''),
    })
    # ISA-95 L2: promote operator string → Person node + assignedTo edge
    if operator:
        batch.add_node('Person', operator, {'id': operator})
        batch.add_edge('JobOrder', wo, 'Person', operator, 'assignedTo')
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('JobOrder', wo, 'MaterialDefinition', pn, 'producesMaterial')
    if sn:
        batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
        batch.add_edge('JobOrder', wo, 'MaterialSublot', sn, 'produces')
    # ISA-95 L2: requestsSegment → ProcessSegment (recipe step from master data)
    if pn and op_num:
        seg_id = f'SEG-{pn}-{op_num}'
        batch.add_edge('JobOrder', wo, 'ProcessSegment', seg_id, 'requestsSegment')
    batch.flush()

    mark_processed(eid, f'order-{wo}')
    logger.info('JobOrder %s RELEASED → Neptune', wo)


def _wo_started(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    wo = p.get('workOrderId', event['entityId'])

    if is_processed(eid, wo):
        return

    cell = p.get('cell', '')
    machine = CELL_MACHINE.get(cell, '')
    pn = p.get('partNumber', '')
    sn = p.get('serialNumber', '')

    batch = GraphBatch(event)

    operator = p.get('assignedOperator', '')

    batch.add_node('JobResponse', wo, {
        'workOrderId': wo,
        'isaClass': 'JobResponse',
        'status': 'STARTED',
        'cell': cell,
        'operationNumber': p.get('operationNumber', ''),
        'operationName': p.get('operationName', ''),
        'assignedOperator': operator,
    })

    # ISA-95 L2: JobOrder → requestsExecution → JobResponse (link plan to actual)
    batch.add_node('JobOrder', wo, {'workOrderId': wo, 'isaClass': 'JobOrder'})
    batch.add_edge('JobOrder', wo, 'JobResponse', wo, 'requestsExecution')

    # ISA-95 L2: actual operator on the JobResponse
    if operator:
        batch.add_node('Person', operator, {'id': operator})
        batch.add_edge('JobResponse', wo, 'Person', operator, 'assignedTo')

    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('JobResponse', wo, 'MaterialDefinition', pn, 'producesMaterial')
    if sn:
        batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
        batch.add_edge('JobResponse', wo, 'MaterialSublot', sn, 'produces')
    if machine:
        batch.add_node('Equipment', machine, {'machineId': machine, 'cellId': cell})
        batch.add_edge('JobResponse', wo, 'Equipment', machine, 'equipmentActual')
        wc = CELL_WORKCENTER.get(cell, '')
        if wc:
            batch.add_edge('Equipment', machine, 'WorkCenter', wc, 'locatedIn')

    batch.flush()
    mark_processed(eid, wo)
    logger.info('WO %s STARTED → Neptune (batch)', wo)


def _op_completed(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    wo = p.get('workOrderId', event['entityId'])

    if is_processed(eid, wo):
        return

    batch = GraphBatch(event)
    batch.add_node('JobResponse', wo, {
        'workOrderId': wo,
        'isaClass': 'JobResponse',
        'status': 'COMPLETE',
        'operationNumber': p.get('operationNumber', ''),
        'cycleTimeMs': str(p.get('cycleTimeMs', '')),
    })

    # Ensure JobResponse connects to MaterialDefinition, MaterialSublot, Equipment even on OP_COMPLETE
    pn = p.get('partNumber', '')
    sn = p.get('serialNumber', '')
    cell = p.get('cell', '')
    machine = CELL_MACHINE.get(cell, '')

    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('JobResponse', wo, 'MaterialDefinition', pn, 'producesMaterial')
    if sn:
        batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
        batch.add_edge('JobResponse', wo, 'MaterialSublot', sn, 'produces')
    if machine:
        batch.add_node('Equipment', machine, {'machineId': machine, 'cellId': cell})
        batch.add_edge('JobResponse', wo, 'Equipment', machine, 'equipmentActual')
        wc = CELL_WORKCENTER.get(cell, '')
        if wc:
            batch.add_edge('Equipment', machine, 'WorkCenter', wc, 'locatedIn')

    # ISA-95 L2: JobResponse → executedSegment → ProcessSegment (proves which
    # recipe step actually ran; powers query_plan_vs_actual)
    op_num = p.get('operationNumber', '')
    if pn and op_num:
        seg_id = f'SEG-{pn}-{op_num}'
        batch.add_edge('JobResponse', wo, 'ProcessSegment', seg_id, 'executedSegment')

    batch.flush()
    mark_processed(eid, wo)
    logger.info('WO %s OP_COMPLETE → Neptune', wo)


def _hold_placed(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    wo = p.get('workOrderId', event['entityId'])

    if is_processed(eid, wo):
        return

    update_node('JobResponse', wo, {
        'status': 'HOLD',
        'holdReason': p.get('holdReason', ''),
    })

    mark_processed(eid, wo)
    logger.info('WO %s HOLD → Neptune', wo)
