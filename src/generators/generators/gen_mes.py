"""MES generator — creates work orders and operation records."""

import uuid
import time
import random
import logging
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

CELLS = ['cell-3', 'cell-4', 'cell-5']
OPERATORS = ['op-garcia', 'op-mueller', 'op-tanaka', 'op-singh', 'op-johansson']
PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']
OPERATIONS = [
    ('Op-40', 'Rough Machine'),
    ('Op-50', 'Finish Machine'),
    ('Op-60', 'Deburr'),
    ('Op-70', 'Inspect'),
    ('Op-80', 'Surface Treat'),
]


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    """Generate MES work order / operation records."""
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        return

    if random.random() > 0.4 * density:
        return

    table = dynamodb.Table('mes-demo')
    wo_id = f'WO-{random.randint(80000, 99999)}'
    sn = 'SN-0047'
    part = random.choice(PART_NUMBERS)
    cell = random.choice(CELLS)
    operator = random.choice(OPERATORS)
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())

    # Decide what to generate: new WO, operation completion, or hold
    mode = state.get('mode', 'DRAMA')
    if mode == 'SMOOTH':
        action = random.choices(['new_wo', 'op_complete'], weights=[5, 3])[0]
    else:
        action = random.choices(['new_wo', 'op_complete', 'hold'], weights=[5, 3, 2])[0]

    try:
        if action == 'new_wo':
            op_num, op_name = random.choice(OPERATIONS)
            base = {
                'PK': f'WO#{wo_id}',
                'SK': 'METADATA',
                'workOrderId': wo_id,
                'partNumber': part,
                'serialNumber': sn,
                'cell': cell,
                'assignedOperator': operator,
                'operationNumber': op_num,
                'operationName': op_name,
                'scheduledStart': now,
                'createdAt': now,
                'updatedAt': now,
                'lastModifiedBy': 'gen-mes',
            }
            # ISA-95 L2 source-side split: WO is RELEASED first (planned),
            # then STARTED (executed). Two DDB writes ⇒ two MSK events ⇒
            # JobOrder + JobResponse nodes in Neptune.
            released = dict(base, status='RELEASED')
            table.put_item(Item=released, ConditionExpression=Attr('PK').not_exists())
            started = dict(base, status='STARTED')
            table.put_item(Item=started)  # update to STARTED (no condition)
            logger.info('gen_mes: WO %s RELEASED→STARTED [%s] %s in %s', wo_id, op_num, part, cell)

        elif action == 'op_complete':
            op_num, op_name = random.choice(OPERATIONS)
            cycle_time = random.randint(180000, 600000)
            item = {
                'PK': f'WO#{wo_id}',
                'SK': f'OP#{op_num}',
                'workOrderId': wo_id,
                'partNumber': part,
                'serialNumber': sn,
                'operationNumber': op_num,
                'operationName': op_name,
                'status': 'COMPLETE',
                'cell': cell,
                'assignedOperator': operator,
                'cycleTimeMs': cycle_time,
                'actualEnd': now,
                'createdAt': now,
                'updatedAt': now,
                'lastModifiedBy': 'gen-mes',
            }
            table.put_item(Item=item, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_mes: completed %s on %s (cycle=%dms)', op_num, wo_id, cycle_time)

        elif action == 'hold':
            hold_reasons = [
                'NCR pending disposition',
                'Material traceability review',
                'Tooling calibration due',
                'Operator certification expired',
            ]
            item = {
                'PK': f'WO#{wo_id}',
                'SK': 'METADATA',
                'workOrderId': wo_id,
                'partNumber': part,
                'serialNumber': sn,
                'status': 'HOLD',
                'cell': cell,
                'holdReason': random.choice(hold_reasons),
                'holdPlacedBy': 'gen-mes',
                'createdAt': now,
                'updatedAt': now,
                'lastModifiedBy': 'gen-mes',
            }
            table.put_item(Item=item, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_mes: placed HOLD on %s', wo_id)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_mes: %s already exists — skipping', wo_id)