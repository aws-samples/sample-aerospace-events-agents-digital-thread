type Image = Record<string, any>;

export function deriveMESEventType(newImage: Image, oldImage: Image | null): string | null {
  const isNew = !oldImage || !oldImage.PK;

  if (isNew) {
    if (newImage.workOrderId && newImage.status === 'RELEASED') return 'WORK_ORDER_RELEASED';
    if (newImage.workOrderId && newImage.status === 'STARTED') return 'WORK_ORDER_STARTED';
    if (newImage.workOrderId && newImage.status === 'COMPLETED') return 'WORK_ORDER_COMPLETED';
    if (newImage.workOrderId && newImage.status === 'HOLD') return 'HOLD_PLACED';
    if (newImage.SK?.startsWith('OP#') && newImage.status === 'COMPLETE') return 'OPERATION_COMPLETED';
    return null;
  }

  // Status transitions
  if (newImage.workOrderId) {
    if (newImage.status === 'COMPLETED' && oldImage?.status !== 'COMPLETED') return 'WORK_ORDER_COMPLETED';
    if (newImage.status === 'HOLD' && oldImage?.status !== 'HOLD') return 'HOLD_PLACED';
    if (newImage.status !== 'HOLD' && oldImage?.status === 'HOLD') return 'HOLD_RELEASED';
    if (newImage.status === 'STARTED' && oldImage?.status === 'RELEASED') return 'WORK_ORDER_STARTED';
  }
  if (newImage.SK?.startsWith('OP#') && newImage.status === 'COMPLETE' && oldImage?.status !== 'COMPLETE') {
    return 'OPERATION_COMPLETED';
  }

  return null;
}
