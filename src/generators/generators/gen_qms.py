"""QMS NCR generator — creates non-conformance reports at ~30% probability per tick."""

import uuid
import time
import random
import logging
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']
DEFECT_CODES = ['BORE_DIAMETER_OOT', 'SURFACE_FINISH_OOT', 'POSITION_OOT', 'CRACK_DETECTED', 'MATERIAL_INCLUSION']
SUPPLIERS = [
    ('titan-forge', 'Titan Forge'),
    ('apex-aero', 'Apex Aerostructures'),
    ('nordic-precision', 'Nordic Precision'),
]
LOT_NUMBERS = ['LOT-7731', 'LOT-7732', 'LOT-7840', 'LOT-7901', 'LOT-8002']
OPERATIONS = ['Op-40', 'Op-50', 'Op-60', 'Op-70', 'Op-80']


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    """Generate a QMS NCR if in production/QA phase."""
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        logger.debug('gen_qms: skipping — phase=%s', phase)
        return

    if random.random() > 0.3 * density:
        logger.debug('gen_qms: skipping — probability check')
        return

    ncr_id = f'NCR-{int(time.time())}-{random.randint(100, 999)}'
    supplier_id, supplier_name = random.choice(SUPPLIERS)
    mode = state.get('mode', 'DRAMA')
    if mode == 'SMOOTH':
        severity = 'MINOR'
    else:
        severity = random.choices(['MINOR', 'MAJOR', 'CRITICAL'], weights=[6, 3, 1])[0]

    item = {
        'PK': f'NCR#{ncr_id}',
        'SK': 'METADATA',
        'ncrId': ncr_id,
        'partNumber': random.choice(PART_NUMBERS),
        'serialNumber': f'SN-0047',
        'workOrderId': f'WO-{random.randint(80000, 89999)}',
        'operationNumber': random.choice(OPERATIONS),
        'defectCode': random.choice(DEFECT_CODES),
        'severity': severity,
        'supplierId': supplier_id,
        'supplierName': supplier_name,
        'lotNumber': random.choice(LOT_NUMBERS),
        'status': 'OPEN',
        'raisedBy': 'gen-qms',
        'correlationId': str(uuid.uuid4()),
        'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
        'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
    }

    try:
        table = dynamodb.Table('qms-demo')
        table.put_item(
            Item=item,
            ConditionExpression=Attr('PK').not_exists(),
        )
        logger.info('gen_qms: created NCR %s [%s] %s from %s',
                     ncr_id, severity, item['defectCode'], supplier_id)
    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_qms: NCR %s already exists — skipping', ncr_id)
