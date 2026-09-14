"""In-Service / Digital Twin generator — fleet readings and anomalies."""

import time
import random
import logging
from decimal import Decimal
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

SERIAL_NUMBERS = ['SN-0038', 'SN-0039', 'SN-0041', 'SN-0044', 'SN-0047']
PARAMETERS = [
    ('hydraulic_pressure_psi', 2800, 3200, 'psi'),
    ('cabin_pressure_diff_psi', 8.0, 9.0, 'psi'),
    ('engine_vibration_ips', 0.1, 0.8, 'ips'),
    ('fuel_flow_pph', 800, 1200, 'pph'),
]


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA', 'INSERVICE'):
        return
    if random.random() > 0.3 * density:
        return

    table = dynamodb.Table('inservice-demo')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    ts = int(time.time())
    sn = random.choice(SERIAL_NUMBERS)
    param, low, high, unit = random.choice(PARAMETERS)

    # Occasionally inject anomaly (deviation outside range)
    mode = state.get('mode', 'DRAMA')
    is_anomaly = False if mode == 'SMOOTH' else random.random() < 0.1
    if is_anomaly:
        value = round(high * random.uniform(1.05, 1.2), 2)
    else:
        value = round(random.uniform(low, high), 2)

    deviation = round(abs(value - (low + high) / 2) / ((high - low) / 2) * 100, 1)

    try:
        table.put_item(Item={
            'PK': f'DT#{sn}', 'SK': f'READING#{ts}#{param}',
            'serialNumber': sn, 'parameter': param,
            'expectedValue': Decimal(str((low + high) / 2)),
            'actualValue': Decimal(str(value)),
            'deviation': Decimal(str(deviation)), 'unit': unit,
            'status': 'ANOMALY' if is_anomaly else 'NORMAL',
            'flightHours': random.randint(1000, 8000),
            'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-inservice',
        }, ConditionExpression=Attr('PK').not_exists())
        status = 'ANOMALY' if is_anomaly else 'NORMAL'
        logger.info('gen_inservice: %s %s=%.1f%s [%s] dev=%.1f%%', sn, param, value, unit, status, deviation)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_inservice: duplicate — skipping')
