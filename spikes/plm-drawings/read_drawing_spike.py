"""Throwaway spike: prove Bedrock Claude vision can read a generated 2D engineering
drawing and extract the toleranced bore dimension — the unstructured-data payoff.

Closes the loop: drawing (unstructured) → structured tolerance → correlate to the
demo's BORE_DIAMETER_OOT defect on P/N 44821-003.
"""

import base64
import json
import sys

import boto3

REGION = 'eu-west-1'
MODEL_ID = 'global.anthropic.claude-sonnet-4-6'  # same inference profile the agents use
IMG = 'spikes/plm-drawings/sample-44821-003-revC.png'

PROMPT = (
    "This is a 2D mechanical engineering drawing. Read it and extract the following as "
    "strict JSON with these keys: partNumber, revision, boreNominalDiameterMm (number), "
    "boreToleranceUpperMm (number), boreToleranceLowerMm (number), fitClass. "
    "Use only what is shown on the drawing. Respond with JSON only, no prose."
)


def main():
    with open(IMG, 'rb') as f:
        img_b64 = base64.standard_b64encode(f.read()).decode()

    client = boto3.client('bedrock-runtime', region_name=REGION)
    resp = client.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            'anthropic_version': 'bedrock-2023-05-31',
            'max_tokens': 1024,
            'messages': [{
                'role': 'user',
                'content': [
                    {'type': 'image', 'source': {
                        'type': 'base64', 'media_type': 'image/png', 'data': img_b64}},
                    {'type': 'text', 'text': PROMPT},
                ],
            }],
        }),
    )
    body = json.loads(resp['body'].read())
    text = body['content'][0]['text']
    print('=== MODEL OUTPUT ===')
    print(text)
    return text


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
