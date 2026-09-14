import { util } from '@aws-appsync/utils';

export function request(ctx) {
  const id = util.autoId();
  const now = util.time.nowISO8601();
  const input = ctx.args.input;

  return {
    operation: 'PutItem',
    key: util.dynamodb.toMapValues({ PK: `NCR#${id}`, SK: 'METADATA' }),
    attributeValues: util.dynamodb.toMapValues({
      ncrId: id,
      partNumber: input.partNumber,
      serialNumber: input.serialNumber,
      workOrderId: input.workOrderId,
      operationNumber: input.operationNumber,
      defectCode: input.defectCode,
      severity: input.severity,
      disposition: input.disposition,
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      lotNumber: input.lotNumber,
      status: input.status ?? 'OPEN',
      raisedBy: input.raisedBy,
      correlationId: id,
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
