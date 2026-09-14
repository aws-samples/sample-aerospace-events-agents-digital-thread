"""ERP generator — procurement document flow.

Models the canonical purchase-to-receive chain a real enterprise resource
planning system emits (vendor-neutral vocabulary, demo-sized):
  PurchaseRequisition → PurchaseOrder (issued → confirmed) → GoodsReceipt →
  SupplierInvoice (received → matched / blocked, 3-way match).

eventType is derived by the generic-producer from <PK_PREFIX>_<STATUS> with a few
overrides (PR#/INV# get long-form names; RECEIPT# → MATERIAL_RECEIVED).
"""

import time
import random
import logging
from decimal import Decimal
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

SUPPLIERS = [('titan-forge', 'Titan Forge'), ('apex-aero', 'Apex Aerostructures'), ('nordic-precision', 'Nordic Precision')]
PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']

# Vendor-neutral procurement reference data (ISA-95 L4 — procurement context).
PLANTS = ['MRD', 'ASH']                    # site ids from config/master-data/hierarchy.json
STORAGE_LOCATIONS = ['SL-RAW', 'SL-WIP', 'SL-QA']
MATERIAL_GROUPS = ['MG-FORGING', 'MG-FASTENER', 'MG-CASTING']
PURCHASING_GROUPS = ['PG-01', 'PG-02']
COST_CENTERS = ['CC-4100', 'CC-4200', 'CC-4300']
REQUISITIONERS = ['buyer-lindqvist', 'buyer-rossi', 'buyer-haddad']
INCOTERMS = ['FCA', 'DAP', 'EXW']
MOVEMENT_TYPE_GR = 'GR-101'                 # neutral goods-receipt movement code


def _now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        return
    if random.random() > 0.3 * density:
        return

    table = dynamodb.Table('erp-demo')
    now = _now()
    supplier_id, supplier_name = random.choice(SUPPLIERS)
    smooth = state.get('mode', 'DRAMA') == 'SMOOTH'

    # Weighted across the procurement chain — requisitions/POs/receipts most common,
    # invoices less so, confirmations occasional.
    action = random.choices(
        ['requisition', 'new_po', 'po_confirm', 'goods_receipt', 'invoice'],
        weights=[3, 5, 2, 4, 3],
    )[0]

    try:
        if action == 'requisition':
            pr = f'PR-{random.randint(30000, 39999)}'
            pn = random.choice(PART_NUMBERS)
            # Requisitions are created then approved — emit whichever (approval is common).
            status = random.choices(['CREATED', 'APPROVED'], weights=[4, 6])[0]
            table.put_item(Item={
                'PK': f'PR#{pr}', 'SK': 'METADATA',
                'requisitionId': pr, 'partNumber': pn,
                'quantity': random.choice([10, 25, 50, 100]),
                'requisitioner': random.choice(REQUISITIONERS),
                'costCenter': random.choice(COST_CENTERS),
                'purchasingGroup': random.choice(PURCHASING_GROUPS),
                'materialGroup': random.choice(MATERIAL_GROUPS),
                'plantId': random.choice(PLANTS),
                'status': status,
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-erp',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_erp: requisition %s %s — %s', pr, status, pn)

        elif action == 'new_po':
            po = f'PO-{random.randint(40000, 49999)}'
            pn = random.choice(PART_NUMBERS)
            qty = random.choice([10, 25, 50, 100])
            table.put_item(Item={
                'PK': f'PO#{po}', 'SK': 'METADATA',
                'poNumber': po, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn, 'quantity': qty,
                'unitCost': Decimal(str(round(random.uniform(50, 500), 2))),
                'currency': 'EUR', 'incoterms': random.choice(INCOTERMS),
                'purchasingGroup': random.choice(PURCHASING_GROUPS),
                'costCenter': random.choice(COST_CENTERS),
                'materialGroup': random.choice(MATERIAL_GROUPS),
                'plantId': random.choice(PLANTS), 'taxCode': 'V0',
                'status': 'ISSUED', 'promisedDate': '2026-04-15',
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-erp',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_erp: issued PO %s — %s x%d from %s', po, pn, qty, supplier_id)

        elif action == 'po_confirm':
            # Supplier acknowledges an existing PO. Update to CONFIRMED (no condition —
            # the PK may already exist; this is the status transition the producer diffs).
            po = f'PO-{random.randint(40000, 49999)}'
            pn = random.choice(PART_NUMBERS)
            table.put_item(Item={
                'PK': f'PO#{po}', 'SK': 'METADATA',
                'poNumber': po, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn, 'currency': 'EUR',
                'status': 'CONFIRMED', 'confirmedDate': '2026-04-12',
                'plantId': random.choice(PLANTS),
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-erp',
            })
            logger.info('gen_erp: PO %s CONFIRMED by %s', po, supplier_id)

        elif action == 'goods_receipt':
            rcpt = f'RCPT-{random.randint(60000, 69999)}'
            pn = random.choice(PART_NUMBERS)
            lot = f'LOT-{random.randint(7700, 8100)}'
            inspection_required = random.choice([True, False])
            item = {
                'PK': f'RECEIPT#{rcpt}', 'SK': 'METADATA',
                'receiptId': rcpt, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn, 'lotNumber': lot,
                'receiptQuantity': random.choice([10, 25, 50]),
                'movementType': MOVEMENT_TYPE_GR,
                'plantId': random.choice(PLANTS),
                'storageLocation': random.choice(STORAGE_LOCATIONS),
                'inspectionRequired': inspection_required,
                'onTime': True if smooth else random.random() > 0.2,
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-erp',
            }
            if inspection_required:
                item['inspectionLotId'] = f'INSP-{random.randint(50000, 59999)}'
            table.put_item(Item=item, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_erp: goods receipt %s — %s lot %s from %s', rcpt, pn, lot, supplier_id)

        elif action == 'invoice':
            inv = f'INV-{random.randint(80000, 89999)}'
            pn = random.choice(PART_NUMBERS)
            # 3-way match: most invoices match; some are blocked on price/qty mismatch.
            # In DRAMA mode a blocked invoice is a useful supplier-risk signal.
            if smooth:
                status = random.choices(['RECEIVED', 'MATCHED'], weights=[3, 7])[0]
            else:
                status = random.choices(['RECEIVED', 'MATCHED', 'BLOCKED'], weights=[3, 5, 2])[0]
            item = {
                'PK': f'INV#{inv}', 'SK': 'METADATA',
                'invoiceId': inv, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn,
                'invoiceAmount': Decimal(str(round(random.uniform(500, 25000), 2))),
                'currency': 'EUR', 'taxCode': 'V0',
                'matchType': '3-way', 'status': status,
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-erp',
            }
            if status == 'BLOCKED':
                item['blockReason'] = random.choice(['PRICE_VARIANCE', 'QUANTITY_VARIANCE'])
            table.put_item(Item=item, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_erp: invoice %s %s — %s', inv, status, supplier_id)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_erp: duplicate — skipping')
