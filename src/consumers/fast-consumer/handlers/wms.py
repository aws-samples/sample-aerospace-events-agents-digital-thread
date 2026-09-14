"""WMS handler — Kit (MaterialSublot) + MaterialLot linkage.

ISA-95: a Kit is a MaterialSublot that aggregates other lots/sublots. We carry
`subtype=Kit` and `aggregateRole=Kit` to disambiguate from serialized sublots.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.wms')


def handle(event: dict):
    et = event.get('eventType', '')
    if et in ('KIT_STAGED', 'KIT_SHORTAGE_DETECTED', 'KIT_SHORT'):
        _kit_event(event)


def _kit_event(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    kit = p.get('kitId', event['entityId'])

    if is_processed(eid, kit):
        return

    batch = GraphBatch(event)
    batch.add_node('MaterialSublot', kit, {
        'kitId': kit,
        'subtype': 'Kit',
        'aggregateRole': 'Kit',
        'status': p.get('status', ''),
        'shortage': str(p.get('shortage', False)),
    })

    wo = p.get('workOrderId', '')
    lot = p.get('lotNumber', '')

    if wo:
        batch.add_edge('MaterialSublot', kit, 'JobResponse', wo, 'consumedBy')
    if lot:
        batch.add_node('MaterialLot', lot, {
            'lotNumber': lot,
            'partNumber': p.get('partNumber', ''),
        })
        batch.add_edge('MaterialSublot', kit, 'MaterialLot', lot, 'madeFrom')

    batch.flush()
    mark_processed(eid, kit)
    logger.info('Kit %s → Neptune (batch)', kit)
