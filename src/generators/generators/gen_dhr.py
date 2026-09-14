"""DHR generator — creates operation sign-offs, cert linkages, test records."""

import time
import random
import logging
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

OPERATIONS = ['Op-40', 'Op-50', 'Op-60', 'Op-70', 'Op-80']
CERT_TYPES = ['MATERIAL_CERT', 'PROCESS_CERT', 'NDT_CERT', 'HEAT_TREAT_CERT']
TEST_TYPES = ['DIMENSIONAL', 'NDT_UT', 'NDT_FPI', 'HARDNESS', 'SURFACE_ROUGHNESS']
OPERATORS = ['op-garcia', 'op-mueller', 'op-tanaka', 'op-singh', 'op-johansson']
PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        return
    if random.random() > 0.35 * density:
        return

    table = dynamodb.Table('dhr-demo')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    sn = 'SN-0047'
    action = random.choices(['op_signoff', 'cert_link', 'test_record'], weights=[4, 3, 3])[0]

    try:
        if action == 'op_signoff':
            op = random.choice(OPERATIONS)
            table.put_item(Item={
                'PK': f'SN#{sn}', 'SK': f'OP#{op}#{int(time.time())}',
                'serialNumber': sn, 'partNumber': random.choice(PART_NUMBERS),
                'operationNumber': op, 'status': 'SIGNED',
                'completedBy': random.choice(OPERATORS), 'signedBy': random.choice(OPERATORS),
                'completedAt': now, 'createdAt': now, 'updatedAt': now,
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_dhr: signed %s on %s', op, sn)

        elif action == 'cert_link':
            cert = random.choice(CERT_TYPES)
            cert_num = f'CERT-{random.randint(1000, 9999)}'
            # Inspectors issue certs (matches personnel master data)
            inspector = random.choice(['insp-bauer', 'insp-meyer', 'insp-dubois', 'insp-park', 'insp-hassan'])
            table.put_item(Item={
                'PK': f'SN#{sn}', 'SK': f'CERT#{cert}#{cert_num}',
                'serialNumber': sn, 'certType': cert, 'certNumber': cert_num,
                'linked': True, 'issueDate': now,
                'issuedBy': inspector, 'signedBy': inspector,
                'createdAt': now, 'updatedAt': now,
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_dhr: linked cert %s (%s) to %s by %s', cert_num, cert, sn, inspector)

        elif action == 'test_record':
            test_type = random.choice(TEST_TYPES)
            test_id = f'TEST-{random.randint(5000, 5999)}'
            if state.get('mode', 'DRAMA') == 'SMOOTH':
                result = 'PASS'
            else:
                result = random.choices(['PASS', 'FAIL', 'CONDITIONAL'], weights=[8, 1, 1])[0]
            table.put_item(Item={
                'PK': f'SN#{sn}', 'SK': f'TEST#{test_id}',
                'serialNumber': sn, 'testId': test_id, 'testType': test_type,
                'result': result, 'recordedBy': random.choice(OPERATORS),
                'createdAt': now, 'updatedAt': now,
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_dhr: test %s (%s) → %s on %s', test_id, test_type, result, sn)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_dhr: duplicate — skipping')
