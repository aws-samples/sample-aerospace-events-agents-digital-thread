import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const input = ctx.args.input;
  const pk = input.PK;
  const sk = input.SK || 'METADATA';
  const now = util.time.nowISO8601();
  const values = { ...input, createdAt: now, updatedAt: now };
  delete values.PK;
  delete values.SK;
  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: pk, SK: sk }),
    attributeValues: util.dynamodb.toMapValues(values),
  };
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return ctx.result;
}
