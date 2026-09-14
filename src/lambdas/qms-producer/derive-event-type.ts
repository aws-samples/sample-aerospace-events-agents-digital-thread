type Image = Record<string, any>;

export function deriveQMSEventType(newImage: Image, oldImage: Image | null): string | null {
  const isNew = !oldImage || !oldImage.PK;

  // New records
  if (isNew) {
    if (newImage.ncrId && newImage.status === 'OPEN') return 'NON_CONFORMANCE_RAISED';
    if (newImage.capaId && newImage.status === 'OPEN') return 'CAPA_OPENED';
    if (newImage.mrbId && newImage.status === 'OPEN') return 'MRB_CONVENED';
    if (newImage.faiId) return 'FAI_SUBMITTED';
    if (newImage.inspectionId && newImage.result) return 'INSPECTION_COMPLETED';
    return null;
  }

  // Status transitions
  if (newImage.ncrId) {
    if (newImage.status === 'CLOSED' && oldImage?.status !== 'CLOSED') return 'NCR_CLOSED';
    if (newImage.disposition && !oldImage?.disposition) return 'NCR_DISPOSITIONED';
  }
  if (newImage.capaId) {
    if (newImage.status === 'APPROVED' && oldImage?.status !== 'APPROVED') return 'CAPA_APPROVED';
    if (newImage.status === 'CLOSED' && oldImage?.status !== 'CLOSED') return 'CAPA_CLOSED';
  }
  if (newImage.faiId && newImage.status === 'APPROVED' && oldImage?.status !== 'APPROVED') {
    return 'FAI_APPROVED';
  }
  if (newImage.mrbId && newImage.disposition && !oldImage?.disposition) {
    return 'MRB_DISPOSITIONED';
  }

  return null;
}
