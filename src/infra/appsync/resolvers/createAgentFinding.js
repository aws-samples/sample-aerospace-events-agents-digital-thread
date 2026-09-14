import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const input = ctx.args.input;
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: `FINDING#${input.findingId}`, SK: 'METADATA' }),
    attributeValues: util.dynamodb.toMapValues({
      findingId: input.findingId,
      agentName: input.agentName,
      domain: input.domain,
      entityId: input.entityId,
      summary: input.summary,
      action: input.action,
      evidence: input.evidence ?? '',
      sessionId: input.sessionId ?? '',
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
