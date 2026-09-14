"""SRM handler — Supplier score updates."""

import logging
from graph_writer import upsert_node, is_processed, mark_processed

logger = logging.getLogger('handler.srm')


def handle(event: dict):
    et = event.get('eventType', '')
    if et.startswith('SUPPLIER_'):
        _supplier_score(event)


def _supplier_score(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    supplier = p.get('supplierId', event['entityId'])

    if is_processed(eid, supplier):
        return

    upsert_node('Supplier', supplier, {
        'supplierId': supplier,
        'supplierName': p.get('supplierName', ''),
        'otdPercent': str(p.get('otdPercent', '')),
        'qualityScore': str(p.get('qualityScore', '')),
        'qualificationStatus': p.get('qualificationStatus', ''),
    })

    mark_processed(eid, supplier)
    logger.info('Supplier %s score → Neptune', supplier)
