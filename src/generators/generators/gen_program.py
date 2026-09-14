"""Program Management generator — milestone updates and EV metrics."""

import time
import random
import logging
from decimal import Decimal
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

MILESTONES = ['CDR', 'PDR', 'FAI-Complete', 'First-Flight', 'Type-Cert']


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA', 'DESIGN'):
        return
    if random.random() > 0.5 * density:
        return

    table = dynamodb.Table('program-demo')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    period = time.strftime('%Y-%m', time.gmtime())
    action = random.choices(['milestone', 'ev_metrics'], weights=[4, 6])[0]

    try:
        mode = state.get('mode', 'DRAMA')
        if action == 'milestone':
            ms = random.choice(MILESTONES)
            confidence = random.randint(70, 98) if mode == 'SMOOTH' else random.randint(55, 98)
            table.put_item(Item={
                'PK': 'PROGRAM#ARES-1', 'SK': f'MILESTONE#{ms}#{int(time.time())}',
                'programId': 'ARES-1', 'milestoneId': ms,
                'milestoneName': ms.replace('-', ' '),
                'plannedDate': '2026-09-15', 'forecastDate': '2026-09-20',
                'confidence': confidence, 'status': 'ON_TRACK' if confidence >= 70 else 'AT_RISK',
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-program',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_program: milestone %s confidence=%d%%', ms, confidence)

        elif action == 'ev_metrics':
            if mode == 'SMOOTH':
                spi = round(random.uniform(1.0, 1.1), 2)
                cpi = round(random.uniform(1.0, 1.05), 2)
            else:
                spi = round(random.uniform(0.85, 1.1), 2)
                cpi = round(random.uniform(0.88, 1.05), 2)
            table.put_item(Item={
                'PK': 'PROGRAM#ARES-1', 'SK': f'EV#{period}#{int(time.time())}',
                'programId': 'ARES-1', 'period': period,
                'spi': Decimal(str(spi)), 'cpi': Decimal(str(cpi)),
                'bcwp': Decimal(str(random.randint(800000, 1200000))),
                'bcws': Decimal(str(random.randint(900000, 1100000))),
                'acwp': Decimal(str(random.randint(850000, 1150000))),
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-program',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_program: EV %s — SPI=%.2f CPI=%.2f', period, spi, cpi)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_program: duplicate — skipping')
