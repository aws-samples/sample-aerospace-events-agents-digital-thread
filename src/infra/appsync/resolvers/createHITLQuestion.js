import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const input = ctx.args.input;
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: `HITL#${input.taskId}`, SK: 'QUESTION' }),
    attributeValues: util.dynamodb.toMapValues({
      taskId: input.taskId,
      sessionId: input.sessionId,
      agentName: input.agentName,
      domainId: input.domainId,
      question: input.question,
      options: input.options,
      evidence: input.evidence ?? '',
      priority: input.priority,
      status: input.status,
      correlationId: input.correlationId ?? '',
      sourceEventId: input.sourceEventId ?? '',
      createdAt: input.createdAt,
    }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
