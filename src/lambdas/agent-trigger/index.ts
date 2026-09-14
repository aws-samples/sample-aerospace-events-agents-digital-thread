/**
 * Shared Agent Trigger Lambda
 *
 * Two event sources:
 * 1. SQS (from EventBridge) → new event → invoke AgentCore Runtime with new sessionId
 * 2. DynamoDB Stream (hitl-questions) → answer received → resume with existing sessionId
 *
 * Uses bedrock-agentcore:InvokeAgentRuntime (SigV4 IAM auth).
 */

import { SQSEvent, DynamoDBStreamEvent } from 'aws-lambda';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';

const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN || '';
const client = new BedrockAgentCoreClient({});

async function invokeAgent(sessionId: string, prompt: string, source: string) {
  if (!AGENT_RUNTIME_ARN) {
    console.error('AGENT_RUNTIME_ARN not set');
    return;
  }

  // Session ID must be 33+ characters for AgentCore
  const fullSessionId = sessionId.length >= 33 ? sessionId : sessionId + '-' + randomUUID().slice(0, 33 - sessionId.length - 1);

  console.log(`Invoking AgentCore — session=${fullSessionId.slice(0, 8)}, source=${source}`);

  try {
    const response = await client.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_RUNTIME_ARN,
      runtimeSessionId: fullSessionId,
      payload: JSON.stringify({
        prompt,
        sessionId: fullSessionId,
        source,
      }),
      qualifier: 'DEFAULT',
    }));

    const result = response.response ? new TextDecoder().decode(response.response) : '';
    console.log(`AgentCore response: ${result.slice(0, 200)}`);
  } catch (err) {
    console.error('AgentCore invocation error:', err);
  }
}

// --- SQS handler: new event from EventBridge ---
async function handleNewEvent(sqsBody: string) {
  const body = JSON.parse(sqsBody);
  const event = body.detail?.value ?? body;

  const sessionId = randomUUID();
  const eventType = event.eventType ?? 'unknown';
  const entityId = event.entityId ?? 'unknown';

  const prompt = `You received this aerospace event. Analyze it and take appropriate action.

Event Type: ${eventType}
Entity ID: ${entityId}
Domain: ${event.domain || 'QMS'}
Occurred At: ${event.occurredAt || 'unknown'}

Payload:
${JSON.stringify(event.payload || event, null, 2)}

Analyze this event following your instructions.`;

  console.log(`New event: ${eventType}:${entityId} → session ${sessionId.slice(0, 8)}`);
  await invokeAgent(sessionId, prompt, 'eventbridge');
}

// --- DynamoDB Stream handler: HITL answer → resume ---
async function handleHITLAnswer(record: any) {
  if (record.eventName !== 'MODIFY') return;

  const newImage = unmarshall(record.dynamodb.NewImage as any);
  const oldImage = record.dynamodb.OldImage ? unmarshall(record.dynamodb.OldImage as any) : {};

  if (oldImage.status !== 'PENDING' || newImage.status !== 'ANSWERED') return;

  const sessionId = newImage.sessionId as string;
  const answer = (newImage.answer as string) || 'No answer provided';
  const question = (newImage.question as string) || '';

  if (!sessionId) {
    console.warn('No sessionId in HITL record — cannot resume');
    return;
  }

  const prompt = `The human operator has responded to your question.

Your question was: "${question}"

Human's answer: "${answer}"

Continue processing based on the human's decision. Publish your final findings.`;

  console.log(`HITL resume: session ${sessionId.slice(0, 8)} — answer: ${answer.slice(0, 80)}`);
  await invokeAgent(sessionId, prompt, 'hitl_resume');
}

export const handler = async (event: SQSEvent | DynamoDBStreamEvent): Promise<void> => {
  for (const record of (event as any).Records ?? []) {
    if (record.eventSource === 'aws:sqs') {
      await handleNewEvent(record.body);
    } else if (record.eventSource === 'aws:dynamodb') {
      await handleHITLAnswer(record);
    }
  }
};
