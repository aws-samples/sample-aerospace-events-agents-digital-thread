"""ERP handler — procurement document graph (ISA-95 Level 4) + ISA-95 material refs.

Events arriving here are ALREADY ISA-95-normalized by the event-normalizer Lambda:
the envelope carries `isaClass` / `isaScope`, and material references use canonical
field names (`materialDefinitionId`, `materialLotId`) alongside the original vendor
fields (kept for traceability).

ISA-95 scope: procurement objects (PurchaseRequisition, PurchaseOrder, GoodsReceipt,
SupplierInvoice, Supplier) are Level 4 and lie outside ISA-95's Level 3 scope — we
keep those labels (tagged isaScope=L4 via the node's `isaClass`/`isaScope` props) but
the MaterialDefinition / MaterialLot they reference DO use ISA-95 vocabulary.
"""

import logging
from graph_writer import GraphBatch, is_processed, mark_processed

logger = logging.getLogger('handler.erp')


def handle(event: dict):
    et = event.get('eventType', '')
    if et in ('PURCHASE_REQUISITION_CREATED', 'PURCHASE_REQUISITION_APPROVED'):
        _requisition(event)
    elif et in ('PO_ISSUED', 'PO_CONFIRMED'):
        _po(event)
    elif et in ('MATERIAL_RECEIVED', 'RECEIPT_CREATED'):
        _material_received(event)
    elif et in ('SUPPLIER_INVOICE_RECEIVED', 'INVOICE_MATCHED', 'INVOICE_BLOCKED'):
        _invoice(event)


def _isa(event: dict, props: dict) -> dict:
    """Stamp ISA-95 scope metadata onto a node's properties for graph compliance."""
    return {
        **props,
        'isaClass': event.get('isaClass', ''),
        'isaScope': event.get('isaScope', ''),
    }


def _material_id(p: dict) -> str:
    """Canonical MaterialDefinition id (normalizer adds it; fall back to vendor field)."""
    return p.get('materialDefinitionId') or p.get('partNumber', '')


def _requisition(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    pr = p.get('requisitionId', event['entityId'])
    if is_processed(eid, pr):
        return

    batch = GraphBatch(event)
    batch.add_node('PurchaseRequisition', pr, _isa(event, {
        'requisitionId': pr,
        'quantity': str(p.get('quantity', '')),
        'status': p.get('status', ''),
        'plantId': p.get('plantId', ''),
    }))
    md = _material_id(p)
    if md:
        batch.add_node('MaterialDefinition', md, {'partNumber': md})
        batch.add_edge('PurchaseRequisition', pr, 'MaterialDefinition', md, 'ordersMaterial')
    batch.flush()
    mark_processed(eid, pr)
    logger.info('PurchaseRequisition %s → Neptune', pr)


def _po(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    po = p.get('poNumber', event['entityId'])
    if is_processed(eid, po):
        return

    batch = GraphBatch(event)
    batch.add_node('PurchaseOrder', po, _isa(event, {
        'poNumber': po,
        'quantity': str(p.get('quantity', '')),
        'status': p.get('status', 'ISSUED'),
        'currency': p.get('currency', ''),
        'incoterms': p.get('incoterms', ''),
        'plantId': p.get('plantId', ''),
    }))

    supplier = p.get('supplierId', '')
    if supplier:
        batch.add_node('Supplier', supplier, {
            'supplierId': supplier,
            'supplierName': p.get('supplierName', ''),
        })
        batch.add_edge('PurchaseOrder', po, 'Supplier', supplier, 'orderedFrom')

    md = _material_id(p)
    if md:
        batch.add_node('MaterialDefinition', md, {'partNumber': md})
        batch.add_edge('PurchaseOrder', po, 'MaterialDefinition', md, 'ordersMaterial')

    batch.flush()
    mark_processed(eid, po)
    logger.info('PurchaseOrder %s (%s) → Neptune', po, p.get('status', ''))


def _material_received(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    lot = p.get('materialLotId') or p.get('lotNumber', '')
    receipt_id = p.get('receiptId', event['entityId'])
    if not lot or is_processed(eid, receipt_id):
        return

    supplier = p.get('supplierId', '')
    md = _material_id(p)

    batch = GraphBatch(event)
    # GoodsReceipt (L4) records the movement; the MaterialLot it produced is ISA-95.
    batch.add_node('GoodsReceipt', receipt_id, _isa(event, {
        'receiptId': receipt_id,
        'movementType': p.get('movementType', ''),
        'plantId': p.get('plantId', ''),
        'storageLocation': p.get('storageLocation', ''),
        'inspectionLotId': p.get('inspectionLotId', ''),
    }))
    batch.add_node('MaterialLot', lot, {
        'lotNumber': lot,
        'partNumber': md,
        'supplierId': supplier,
        'receivedAt': p.get('createdAt', ''),
    })
    batch.add_edge('GoodsReceipt', receipt_id, 'MaterialLot', lot, 'receivedMaterial')

    if supplier:
        batch.add_node('Supplier', supplier, {
            'supplierId': supplier,
            'supplierName': p.get('supplierName', ''),
        })
        batch.add_edge('MaterialLot', lot, 'Supplier', supplier, 'suppliedBy')

    if md:
        batch.add_node('MaterialDefinition', md, {'partNumber': md})
        batch.add_edge('MaterialLot', lot, 'MaterialDefinition', md, 'definesMaterial')

    batch.flush()
    mark_processed(eid, receipt_id)
    logger.info('GoodsReceipt %s → MaterialLot %s → Neptune', receipt_id, lot)


def _invoice(event: dict):
    p = event.get('payload', {})
    eid = event['eventId']
    inv = p.get('invoiceId', event['entityId'])
    if is_processed(eid, inv):
        return

    batch = GraphBatch(event)
    batch.add_node('SupplierInvoice', inv, _isa(event, {
        'invoiceId': inv,
        'status': p.get('status', ''),
        'currency': p.get('currency', ''),
        'matchType': p.get('matchType', ''),
        'blockReason': p.get('blockReason', ''),
    }))
    supplier = p.get('supplierId', '')
    if supplier:
        batch.add_node('Supplier', supplier, {
            'supplierId': supplier,
            'supplierName': p.get('supplierName', ''),
        })
        batch.add_edge('SupplierInvoice', inv, 'Supplier', supplier, 'invoicedBy')
    batch.flush()
    mark_processed(eid, inv)
    logger.info('SupplierInvoice %s (%s) → Neptune', inv, p.get('status', ''))
