import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const input = ctx.args.input;
  return {
    operation: 'UpdateItem',
    key: util.dynamodb.toMapValues({ PK: `HITL#${input.taskId}`, SK: 'QUESTION' }),
    update: {
      expression: 'SET #s = :status, answer = :answer, answeredAt = :answeredAt',
      expressionNames: { '#s': 'status' },
      expressionValues: util.dynamodb.toMapValues({
        ':status': input.status,
        ':answer': input.answer,
        ':answeredAt': input.answeredAt,
      }),
    },
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
