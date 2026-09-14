import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const limit = ctx.args.limit ?? 50;
  const req = {
    operation: 'Scan',
    limit,
    filter: {
      expression: 'begins_with(PK, :pk) AND SK = :sk',
      expressionValues: util.dynamodb.toMapValues({ ':pk': 'WO#', ':sk': 'METADATA' }),
    },
  };
  if (ctx.args.nextToken) {
    req.nextToken = ctx.args.nextToken;
  }
  return req;
}

export function response(ctx) {
  if (ctx.error) {
    util.error(ctx.error.message, ctx.error.type);
  }
  return { items: ctx.result.items ?? [], nextToken: ctx.result.nextToken ?? null };
}
