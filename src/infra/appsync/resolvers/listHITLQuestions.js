import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const limit = ctx.args.limit ?? 50;
  const status = ctx.args.status ?? 'PENDING';
  const domainId = ctx.args.domainId;

  if (domainId) {
    const req = {
      operation: 'Scan',
      limit,
      filter: {
        expression: 'begins_with(PK, :pk) AND #s = :status AND domainId = :domainId',
        expressionNames: { '#s': 'status' },
        expressionValues: util.dynamodb.toMapValues({ ':pk': 'HITL#', ':status': status, ':domainId': domainId }),
      },
    };
    if (ctx.args.nextToken) {
      req.nextToken = ctx.args.nextToken;
    }
    return req;
  }

  const req = {
    operation: 'Scan',
    limit,
    filter: {
      expression: 'begins_with(PK, :pk) AND #s = :status',
      expressionNames: { '#s': 'status' },
      expressionValues: util.dynamodb.toMapValues({ ':pk': 'HITL#', ':status': status }),
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
