"""WMS generator — creates kit staging records."""

import time
import random
import logging
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']
LOCATIONS = ['STAGE-A1', 'STAGE-A2', 'STAGE-B1', 'STAGE-B2', 'STAGE-C1']


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        return
    if random.random() > 0.35 * density:
        return

    table = dynamodb.Table('wms-demo')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    kit_id = f'KIT-{random.randint(10000, 19999)}'
    wo_id = f'WO-{random.randint(80000, 99999)}'
    pn = random.choice(PART_NUMBERS)
    req_qty = random.choice([1, 2, 4, 5, 10])
    mode = state.get('mode', 'DRAMA')
    is_short = False if mode == 'SMOOTH' else random.random() < 0.15
    staged_qty = random.randint(0, req_qty - 1) if is_short else req_qty

    try:
        table.put_item(Item={
            'PK': f'KIT#{kit_id}', 'SK': 'METADATA',
            'kitId': kit_id, 'workOrderId': wo_id, 'partNumber': pn,
            'status': 'SHORT' if is_short else 'STAGED',
            'requiredQty': req_qty, 'stagedQty': staged_qty,
            'shortage': is_short, 'locationId': random.choice(LOCATIONS),
            'lotNumber': f'LOT-{random.randint(7700, 8100)}',
            'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-wms',
        }, ConditionExpression=Attr('PK').not_exists())
        status = 'SHORT' if is_short else 'STAGED'
        logger.info('gen_wms: kit %s [%s] %s for %s', kit_id, status, pn, wo_id)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_wms: %s already exists — skipping', kit_id)
