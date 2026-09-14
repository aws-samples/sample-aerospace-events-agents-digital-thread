"""SCADA telemetry loop — publishes 1 Hz MQTT to IoT Core for 5 machines."""

import json
import math
import time
import logging
import os

import boto3

logger = logging.getLogger(__name__)

IOT_ENDPOINT = os.environ.get('IOT_ENDPOINT', '')
PROGRAM_ID = 'ares1'

# Machine definitions: (machineId, cellId, metrics)
MACHINES = [
    ('cnc-mill-3', 'cell-3', ['spindle_vibration_mm_s', 'oee_percent', 'status']),
    ('cnc-mill-4', 'cell-3', ['spindle_vibration_mm_s', 'oee_percent', 'status']),
    ('lathe-1', 'cell-4', ['temperature_c', 'oee_percent', 'status']),
    ('drill-press-1', 'cell-4', ['cycle_time_ms', 'oee_percent', 'status']),
    ('drill-press-2', 'cell-4', ['cycle_time_ms', 'oee_percent', 'status']),
]

# Thresholds
THRESHOLDS = {
    'spindle_vibration_mm_s': 1.8,
    'oee_percent': 75,
    'temperature_c': 85,
    'cycle_time_ms': 5000,
}

UNITS = {
    'spindle_vibration_mm_s': 'mm/s',
    'oee_percent': '%',
    'temperature_c': '°C',
    'cycle_time_ms': 'ms',
}


def _generate_value(metric: str, t: float, bearing_wear: float | None = None) -> float:
    """Generate realistic sensor values with sinusoidal drift."""
    if metric == 'spindle_vibration_mm_s':
        if bearing_wear is not None:
            return bearing_wear
        # Normal: 0.2–0.8 mm/s with slow drift
        base = 0.5 + 0.3 * math.sin(t / 120)
        noise = 0.05 * math.sin(t * 7.3)
        return round(max(0.1, base + noise), 3)

    if metric == 'oee_percent':
        # Normal: 78–88% with drift
        base = 83 + 5 * math.sin(t / 300)
        noise = 2 * math.sin(t * 3.7)
        return round(max(50, min(100, base + noise)), 1)

    if metric == 'temperature_c':
        # Normal: 55–75°C
        base = 65 + 10 * math.sin(t / 200)
        noise = 2 * math.sin(t * 5.1)
        return round(base + noise, 1)

    if metric == 'cycle_time_ms':
        # Normal: 2500–4000ms
        base = 3250 + 750 * math.sin(t / 180)
        noise = 100 * math.sin(t * 4.2)
        return round(base + noise)

    return 0


def _get_iot_client():
    """Create IoT Data client."""
    if not IOT_ENDPOINT:
        logger.warning('IOT_ENDPOINT not set — SCADA telemetry disabled')
        return None
    return boto3.client(
        'iot-data',
        endpoint_url=f'https://{IOT_ENDPOINT}',
        region_name=os.environ.get('AWS_REGION', 'eu-west-1'),
    )


async def scada_loop(dynamodb) -> None:
    """1 Hz MQTT publish loop for all machines. Runs independently of scheduler."""
    import asyncio

    iot_client = _get_iot_client()
    if not iot_client:
        logger.error('SCADA loop cannot start — no IoT endpoint')
        return

    logger.info('SCADA loop started — %d machines, endpoint=%s', len(MACHINES), IOT_ENDPOINT)
    start_time = time.time()

    while True:
        t = time.time() - start_time

        # Check for bearing wear injection and mode from demo-control
        bearing_wear = None
        mode = 'DRAMA'
        try:
            table = dynamodb.Table(os.environ.get('DEMO_CONTROL_TABLE', 'demo-control'))
            resp = table.get_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'STATE'})
            item = resp.get('Item', {})
            mode = item.get('mode', 'DRAMA')
            if item.get('bearingWearActive'):
                bearing_wear = float(item.get('bearingWearValue', 2.1))
        except Exception:
            pass

        now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())

        for machine_id, cell_id, metrics in MACHINES:
            for metric in metrics:
                if metric == 'status':
                    payload = {
                        'machineId': machine_id,
                        'cellId': cell_id,
                        'programId': PROGRAM_ID,
                        'metric': 'status',
                        'value': 'RUNNING',
                        'status': 'RUNNING',
                        'timestamp': now,
                    }
                else:
                    bw = bearing_wear if (metric == 'spindle_vibration_mm_s' and machine_id == 'cnc-mill-3') else None
                    value = _generate_value(metric, t, bw)
                    threshold = THRESHOLDS.get(metric)
                    status = 'NORMAL'
                    if mode == 'SMOOTH' and threshold:
                        # Clamp values to stay within safe range
                        if metric == 'oee_percent':
                            value = max(value, threshold + 1)
                        else:
                            value = min(value, threshold - 0.1)
                    elif threshold:
                        if metric == 'oee_percent' and value < threshold:
                            status = 'ANOMALY'
                        elif metric != 'oee_percent' and value > threshold:
                            status = 'ANOMALY'

                    payload = {
                        'machineId': machine_id,
                        'cellId': cell_id,
                        'programId': PROGRAM_ID,
                        'metric': metric,
                        'value': value,
                        'unit': UNITS.get(metric, ''),
                        'threshold': threshold,
                        'status': status,
                        'timestamp': now,
                    }

                topic = f'aerospace/{PROGRAM_ID}/{cell_id}/{machine_id}/{metric}'
                try:
                    iot_client.publish(
                        topic=topic,
                        qos=0,
                        payload=json.dumps(payload),
                    )
                except Exception as e:
                    logger.error('MQTT publish failed: %s — %s', topic, e)

        await asyncio.sleep(1.0)
