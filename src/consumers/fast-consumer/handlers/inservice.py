"""InService handler — DigitalTwin, FleetAnomaly.

ISA-95 scope note: in-service / fleet telemetry is outside ISA-95. DigitalTwin
and FleetAnomaly stay as project extensions; we link them to MaterialSublot via
`instantiatedAs` / `observedOn`.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.inservice')


def handle(event: dict):
    p = event.get('payload', {})
    status = p.get('status', 'NORMAL')
    if status == 'ANOMALY':
        _anomaly(event)
    else:
        _telemetry(event)


def _telemetry(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    sn = p.get('serialNumber', '')

    if not sn or is_processed(eid, f'dt-{sn}'):
        return

    batch = GraphBatch(event)
    batch.add_node('DigitalTwin', sn, {
        'serialNumber': sn,
        'flightHours': str(p.get('flightHours', '')),
        'lastStatus': 'NORMAL',
    })
    batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
    batch.add_edge('MaterialSublot', sn, 'DigitalTwin', sn, 'instantiatedAs')
    batch.flush()

    mark_processed(eid, f'dt-{sn}')
    logger.info('DigitalTwin %s → Neptune (batch)', sn)


def _anomaly(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    sn = p.get('serialNumber', '')
    anomaly_id = f'anomaly-{eid[:8]}'

    if not sn or is_processed(eid, anomaly_id):
        return

    batch = GraphBatch(event)
    batch.add_node('DigitalTwin', sn, {
        'serialNumber': sn,
        'flightHours': str(p.get('flightHours', '')),
        'lastStatus': 'ANOMALY',
    })
    batch.add_node('FleetAnomaly', anomaly_id, {
        'anomalyId': anomaly_id,
        'parameter': p.get('parameter', ''),
        'deviation': str(p.get('deviation', '')),
        'status': 'ANOMALY',
        'serialNumber': sn,
    })
    batch.add_node('MaterialSublot', sn, {'serialNumber': sn, 'subtype': 'Serialized'})
    batch.add_edge('MaterialSublot', sn, 'DigitalTwin', sn, 'instantiatedAs')
    batch.add_edge('FleetAnomaly', anomaly_id, 'DigitalTwin', sn, 'observedOn')
    batch.flush()

    mark_processed(eid, anomaly_id)
    logger.info('FleetAnomaly %s on %s → Neptune (batch)', anomaly_id, sn)
