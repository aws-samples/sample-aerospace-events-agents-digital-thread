import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const input = ctx.args.input;
  const woId = `WO-${Math.floor(Math.random() * 99999)}`;
  const now = util.time.nowISO8601();
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: `WO#${woId}`, SK: 'METADATA' }),
    attributeValues: util.dynamodb.toMapValues({
      workOrderId: woId,
      ...input,
      createdAt: now,
      updatedAt: now,
    }),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
