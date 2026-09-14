"""DHR handler — OperationsPerformance (Certificate / Test subtypes), op signoff.

ISA-95: Certificates and TestRecords are both Quality OperationsPerformance
records. We use a `subtype` property (and `performanceType`) to keep them
distinguishable for visualization and querying.

L2: signers/completers/recorders promoted to Person nodes with `signedBy`
edges. Wires DHR records to the personnel master data seeded in Phase A.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.dhr')


def _link_person(batch: GraphBatch, src_label: str, src_id: str, person_id: str, edge: str = 'signedBy'):
    """Helper: ensure a Person node exists and link via the given edge."""
    if not person_id:
        return
    batch.add_node('Person', person_id, {'id': person_id})
    batch.add_edge(src_label, src_id, 'Person', person_id, edge)


def handle(event: dict):
    p = event.get('payload', {})
    et = event.get('eventType', '')
    if et == 'CERT_LINKED' or p.get('certNumber') or p.get('certType'):
        _cert_linked(event)
    elif et == 'TEST_RECORDED' or p.get('testId') or p.get('testType'):
        _test_recorded(event)
    elif et == 'OPERATION_SIGNED' or (p.get('operationNumber') and p.get('status') == 'SIGNED'):
        _op_signed(event)


def _cert_linked(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    cert = p.get('certNumber', event['entityId'])

    if is_processed(eid, cert):
        return

    sn = p.get('serialNumber', '')
    issued_by = p.get('issuedBy', '') or p.get('signedBy', '')
    batch = GraphBatch(event)
    batch.add_node('OperationsPerformance', cert, {
        'certNumber': cert,
        'subtype': 'Certificate',
        'operationsType': 'Quality',
        'performanceType': 'Certificate',
        'certType': p.get('certType', ''),
        'linked': 'true',
        'issuedBy': issued_by,
    })
    if sn:
        batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
        batch.add_edge('MaterialSublot', sn, 'OperationsPerformance', cert, 'testsAppliedTo')
    _link_person(batch, 'OperationsPerformance', cert, issued_by, 'signedBy')
    pn = p.get('partNumber', '')
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('OperationsPerformance', cert, 'MaterialDefinition', pn, 'certifies')
    lot = p.get('lotNumber', '')
    if lot:
        batch.add_node('MaterialLot', lot, {'lotNumber': lot})
        batch.add_edge('OperationsPerformance', cert, 'MaterialLot', lot, 'certifies')
    batch.flush()

    mark_processed(eid, cert)
    logger.info('Cert %s → Neptune (batch)', cert)


def _test_recorded(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    test = p.get('testId', event['entityId'])

    if is_processed(eid, test):
        return

    sn = p.get('serialNumber', '')
    recorded_by = p.get('recordedBy', '')
    batch = GraphBatch(event)
    batch.add_node('OperationsPerformance', test, {
        'testId': test,
        'subtype': 'Test',
        'operationsType': 'Quality',
        'performanceType': 'Test',
        'testType': p.get('testType', ''),
        'result': p.get('result', ''),
        'recordedBy': recorded_by,
    })
    if sn:
        batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
        batch.add_edge('MaterialSublot', sn, 'OperationsPerformance', test, 'testsAppliedTo')
    _link_person(batch, 'OperationsPerformance', test, recorded_by, 'signedBy')
    pn = p.get('partNumber', '')
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('OperationsPerformance', test, 'MaterialDefinition', pn, 'testsAppliedTo')
    wo = p.get('workOrderId', '')
    if wo:
        batch.add_node('JobResponse', wo, {'workOrderId': wo, 'isaClass': 'JobResponse'})
        batch.add_edge('OperationsPerformance', test, 'JobResponse', wo, 'executedDuring')
    batch.flush()

    mark_processed(eid, test)
    logger.info('Test %s → Neptune (batch)', test)


def _op_signed(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    sn = p.get('serialNumber', '')
    op = p.get('operationNumber', event['entityId'])
    signed_by = p.get('signedBy', '')
    completed_by = p.get('completedBy', '')

    if not sn or is_processed(eid, f'{sn}-{op}'):
        return

    batch = GraphBatch(event)
    batch.add_node('MaterialSublot', sn, {
        'serialNumber': sn,
        'subtype': 'Serialized',
        'lastSignedOperation': op,
        'lastSignedBy': signed_by,
    })
    # Inspector who signed the operation off (acceptance authority).
    _link_person(batch, 'MaterialSublot', sn, signed_by, 'signedBy')
    # Operator who actually performed the work — distinct edge so queries can
    # tell "who did the work" from "who signed for it".
    if completed_by and completed_by != signed_by:
        _link_person(batch, 'MaterialSublot', sn, completed_by, 'completedBy')
    batch.flush()

    mark_processed(eid, f'{sn}-{op}')
    logger.info('Op %s signed on %s by %s → Neptune', op, sn, signed_by or '?')
