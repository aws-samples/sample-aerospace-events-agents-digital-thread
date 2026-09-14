"""QMS handler — OperationsPerformance (NonConformance subtype) + MaterialLot linkage.

ISA-95: NCRs are OperationsPerformance with operationsType=Quality and a
disposition requirement. The `subtype` property disambiguates from
Certificates / Tests, which also map to OperationsPerformance.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.qms')


def handle(event: dict):
    event_type = event.get('eventType', '')
    if event_type == 'NON_CONFORMANCE_RAISED':
        _ncr_raised(event)


def _ncr_raised(event: dict):
    payload = event.get('payload', {})
    event_id = event['eventId']
    ncr_id = event['entityId']

    if is_processed(event_id, ncr_id):
        logger.info('Skip duplicate: %s', ncr_id)
        return

    sn = payload.get('serialNumber', 'SN-0047')
    pn = payload.get('partNumber', '')
    supplier = payload.get('supplierId', '')
    supplier_name = payload.get('supplierName', '')
    lot = payload.get('lotNumber', '')

    batch = GraphBatch(event)

    batch.add_node('OperationsPerformance', ncr_id, {
        'ncrId': ncr_id,
        'subtype': 'NonConformance',
        'operationsType': 'Quality',
        'dispositionRequired': 'true',
        'partNumber': pn,
        'defectCode': payload.get('defectCode', ''),
        'severity': payload.get('severity', ''),
        'status': payload.get('status', ''),
        'supplierId': supplier,
        'lotNumber': lot,
        'serialNumber': sn,
        'sourceEventId': event_id,
    })

    batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
    batch.add_edge('OperationsPerformance', ncr_id, 'MaterialSublot', sn, 'appliesTo')

    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('OperationsPerformance', ncr_id, 'MaterialDefinition', pn, 'affectsMaterial')

    if supplier:
        batch.add_node('Supplier', supplier, {'supplierId': supplier, 'supplierName': supplier_name})
        batch.add_edge('OperationsPerformance', ncr_id, 'Supplier', supplier, 'attributedTo')

    if lot:
        batch.add_node('MaterialLot', lot, {'lotNumber': lot, 'partNumber': pn, 'supplierId': supplier})
        batch.add_edge('MaterialSublot', sn, 'MaterialLot', lot, 'madeFrom')
        if supplier:
            batch.add_edge('MaterialLot', lot, 'Supplier', supplier, 'suppliedBy')
        if pn:
            batch.add_edge('MaterialLot', lot, 'MaterialDefinition', pn, 'definesMaterial')

    batch.flush()
    mark_processed(event_id, ncr_id)
    logger.info('NCR %s → Neptune (batch)', ncr_id)
