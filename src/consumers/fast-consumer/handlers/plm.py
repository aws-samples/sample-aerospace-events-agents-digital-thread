"""PLM handler — ISA-95 MaterialDefinition + ProductDefinitionDocument, plus the
engineering-change workflow (project extensions).

Events arriving here are ALREADY ISA-95-normalized by the event-normalizer Lambda:
the envelope carries `isaClass` / `isaScope`, design objects map to ISA-95
(Part → MaterialDefinition, Drawing → ProductDefinitionDocument), and canonical
fields are added (`materialRevision`, `documentRevision`) alongside vendor fields.

ISA-95 scope: MaterialDefinition / ProductDefinitionDocument are Level 3 ISA-95.
Engineering-change objects (ChangeRequest, EngineeringChangeOrder, ChangeNotice,
BillOfMaterials) have no native ISA-95 class — kept as project extensions and
tagged isaScope='extension' on the node.
"""

import logging
from graph_writer import GraphBatch, upsert_node, is_processed, mark_processed

logger = logging.getLogger('handler.plm')


def handle(event: dict):
    et = event.get('eventType', '')
    if et.startswith('PART_'):
        _part(event)
    elif et.startswith('DRAWING_'):
        _drawing(event)
    elif et in ('CHANGE_REQUEST_SUBMITTED', 'CHANGE_REQUEST_EVALUATED'):
        _change_request(event)
    elif et.startswith('ECO_'):
        _eco(event)
    elif et == 'CHANGE_NOTICE_ISSUED':
        _change_notice(event)
    elif et == 'BOM_REVISED':
        _bom_revised(event)


def _isa(event: dict, props: dict) -> dict:
    return {
        **props,
        'isaClass': event.get('isaClass', ''),
        'isaScope': event.get('isaScope', ''),
    }


def _part(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    pn = p.get('partNumber', event['entityId'])
    # Maturity transitions update the same MaterialDefinition — dedup by (eid, pn).
    if is_processed(eid, pn):
        return

    upsert_node('MaterialDefinition', pn, _isa(event, {
        'partNumber': pn,
        'description': p.get('description', ''),
        'revision': p.get('materialRevision') or p.get('revision', ''),
        'maturityState': p.get('maturityState', ''),
        'lifecycleState': p.get('lifecycleState', ''),
        'effectivity': p.get('effectivity', ''),
        'status': p.get('status', ''),
    }))
    mark_processed(eid, pn)
    logger.info('MaterialDefinition %s → %s → Neptune', pn, p.get('maturityState', ''))


def _drawing(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    dwg = p.get('drawingNumber', event['entityId'])
    if is_processed(eid, dwg):
        return

    pn = p.get('partNumber', '')
    batch = GraphBatch(event)
    batch.add_node('ProductDefinitionDocument', dwg, _isa(event, {
        'drawingNumber': dwg,
        'revisionLetter': p.get('documentRevision') or p.get('revisionLetter', ''),
        'maturityState': p.get('maturityState', ''),
        'status': p.get('status', ''),
        'drawingS3Key': p.get('drawingS3Key', ''),
        'drawingUri': p.get('drawingUri', ''),
    }))
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('MaterialDefinition', pn, 'ProductDefinitionDocument', dwg, 'hasDocument')
    batch.flush()
    mark_processed(eid, dwg)
    logger.info('ProductDefinitionDocument %s → %s → Neptune', dwg, p.get('maturityState', ''))


def _change_request(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    ecr = p.get('ecrId', event['entityId'])
    if is_processed(eid, ecr):
        return

    pn = p.get('partNumber', '')
    batch = GraphBatch(event)
    batch.add_node('ChangeRequest', ecr, _isa(event, {
        'ecrId': ecr,
        'reason': p.get('reason', ''),
        'status': p.get('status', ''),
    }))
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('ChangeRequest', ecr, 'MaterialDefinition', pn, 'requestsChangeTo')
    batch.flush()
    mark_processed(eid, ecr)
    logger.info('ChangeRequest %s (%s) → Neptune', ecr, p.get('status', ''))


def _eco(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    eco = p.get('ecoId', event['entityId'])
    # ECO transitions through its lifecycle on the same node — dedup by (eid, eco).
    if is_processed(eid, eco):
        return

    pn = p.get('partNumber', '')
    batch = GraphBatch(event)
    batch.add_node('EngineeringChangeOrder', eco, _isa(event, {
        'ecoId': eco,
        'description': p.get('description', ''),
        'status': p.get('status', ''),
        'effectivity': p.get('effectivity', ''),
    }))
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('MaterialDefinition', pn, 'EngineeringChangeOrder', eco, 'changedBy')
    ecr = p.get('ecrId', '')
    if ecr:
        batch.add_node('ChangeRequest', ecr, {'ecrId': ecr})
        batch.add_edge('EngineeringChangeOrder', eco, 'ChangeRequest', ecr, 'originatesFrom')
    batch.flush()
    mark_processed(eid, eco)
    logger.info('EngineeringChangeOrder %s → %s → Neptune', eco, p.get('status', ''))


def _change_notice(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    ecn = p.get('ecnId', event['entityId'])
    if is_processed(eid, ecn):
        return

    batch = GraphBatch(event)
    batch.add_node('ChangeNotice', ecn, _isa(event, {
        'ecnId': ecn,
        'newRevision': p.get('newRevision', ''),
        'effectivity': p.get('effectivity', ''),
        'status': p.get('status', 'ISSUED'),
    }))
    eco = p.get('ecoId', '')
    if eco:
        batch.add_node('EngineeringChangeOrder', eco, {'ecoId': eco})
        batch.add_edge('ChangeNotice', ecn, 'EngineeringChangeOrder', eco, 'releases')
    pn = p.get('partNumber', '')
    if pn:
        batch.add_node('MaterialDefinition', pn, {'partNumber': pn})
        batch.add_edge('ChangeNotice', ecn, 'MaterialDefinition', pn, 'effectiveOn')
    batch.flush()
    mark_processed(eid, ecn)
    logger.info('ChangeNotice %s ISSUED → Neptune', ecn)


def _bom_revised(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    bom = p.get('bomId', event['entityId'])
    if is_processed(eid, bom):
        return

    parent = p.get('parentPart') or p.get('partNumber', '')
    batch = GraphBatch(event)
    batch.add_node('BillOfMaterials', bom, _isa(event, {
        'bomId': bom,
        'revision': p.get('revision', ''),
        'reason': p.get('reason', ''),
        'status': p.get('status', 'REVISED'),
    }))
    if parent:
        batch.add_node('MaterialDefinition', parent, {'partNumber': parent})
        batch.add_edge('BillOfMaterials', bom, 'MaterialDefinition', parent, 'billOf')
    # Each changed component is itself a MaterialDefinition consumed by the parent.
    for child in (p.get('changedComponents') or []):
        batch.add_node('MaterialDefinition', child, {'partNumber': child})
        batch.add_edge('BillOfMaterials', bom, 'MaterialDefinition', child, 'includesComponent')
    batch.flush()
    mark_processed(eid, bom)
    logger.info('BillOfMaterials %s REVISED → Neptune', bom)
