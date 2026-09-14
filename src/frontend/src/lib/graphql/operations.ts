const NCR_FIELDS = `
  ncrId
  partNumber
  serialNumber
  workOrderId
  operationNumber
  defectCode
  severity
  supplierId
  supplierName
  lotNumber
  status
  raisedBy
  correlationId
  createdAt
  updatedAt
`;

export const createNonConformance = /* GraphQL */ `
  mutation CreateNonConformance($input: CreateNonConformanceInput!) {
    createNonConformance(input: $input) {
      ${NCR_FIELDS}
    }
  }
`;

export const listNonConformances = /* GraphQL */ `
  query ListNonConformances($limit: Int, $nextToken: String) {
    listNonConformances(limit: $limit, nextToken: $nextToken) {
      items { ${NCR_FIELDS} }
      nextToken
    }
  }
`;

export const onCreateNonConformance = /* GraphQL */ `
  subscription OnCreateNonConformance {
    onCreateNonConformance {
      ${NCR_FIELDS}
    }
  }
`;

// --- MES Work Orders ---

const WO_FIELDS = `
  workOrderId
  partNumber
  serialNumber
  status
  cell
  assignedOperator
  operationNumber
  operationName
  holdReason
  cycleTimeMs
  scheduledStart
  actualEnd
  createdAt
  updatedAt
`;

export const createWorkOrder = /* GraphQL */ `
  mutation CreateWorkOrder($input: CreateWorkOrderInput!) {
    createWorkOrder(input: $input) {
      ${WO_FIELDS}
    }
  }
`;

export const listWorkOrders = /* GraphQL */ `
  query ListWorkOrders($limit: Int, $nextToken: String) {
    listWorkOrders(limit: $limit, nextToken: $nextToken) {
      items { ${WO_FIELDS} }
      nextToken
    }
  }
`;

export const onCreateWorkOrder = /* GraphQL */ `
  subscription OnCreateWorkOrder {
    onCreateWorkOrder {
      ${WO_FIELDS}
    }
  }
`;

// --- Generic Source System Records (PLM, ERP, SRM, WMS, DHR, Program, InService) ---

const SOURCE_FIELDS = `
  PK SK status createdAt updatedAt
  partNumber description revision revisionLetter drawingNumber ecoId
  poNumber receiptId supplierId supplierName quantity lotNumber
  kitId workOrderId requiredQty stagedQty locationId
  serialNumber operationNumber certType testType result
  programId milestoneId milestoneName confidence spi cpi
  parameter actualValue deviation unit flightHours
  qualificationStatus otdPercent qualityScore overallScore period
  requisitionId invoiceId ecrId ecnId bomId
  costCenter purchasingGroup materialGroup currency incoterms plantId storageLocation taxCode
  movementType matchType blockReason maturityState lifecycleState effectivity reason
  drawingUri drawingS3Key drawingS3Bucket
`;

function makeSourceOps(domain: string, listName: string, createName: string, subName: string) {
  return {
    list: /* GraphQL */ `query List${domain}($limit: Int, $nextToken: String) { ${listName}(limit: $limit, nextToken: $nextToken) { items { ${SOURCE_FIELDS} } nextToken } }`,
    create: /* GraphQL */ `mutation Create${domain}($input: CreateSourceRecordInput!) { ${createName}(input: $input) { ${SOURCE_FIELDS} } }`,
    sub: /* GraphQL */ `subscription OnCreate${domain} { ${subName} { ${SOURCE_FIELDS} } }`,
  };
}

export const plmOps = makeSourceOps('Plm', 'listPlmRecords', 'createPlmRecord', 'onCreatePlmRecord');
export const erpOps = makeSourceOps('Erp', 'listErpRecords', 'createErpRecord', 'onCreateErpRecord');
export const srmOps = makeSourceOps('Srm', 'listSrmRecords', 'createSrmRecord', 'onCreateSrmRecord');
export const wmsOps = makeSourceOps('Wms', 'listWmsRecords', 'createWmsRecord', 'onCreateWmsRecord');
export const dhrOps = makeSourceOps('Dhr', 'listDhrRecords', 'createDhrRecord', 'onCreateDhrRecord');
export const programOps = makeSourceOps('Program', 'listProgramRecords', 'createProgramRecord', 'onCreateProgramRecord');
export const inserviceOps = makeSourceOps('Inservice', 'listInserviceRecords', 'createInserviceRecord', 'onCreateInserviceRecord');

// Dashboard events (from EventBridge → publisher Lambda → AppSync)
export const onDashboardEvent = /* GraphQL */ `
  subscription OnDashboardEvent($channel: String) {
    onDashboardEvent(channel: $channel) {
      eventId
      eventType
      domain
      entityId
      occurredAt
      channel
      payload
    }
  }
`;

// --- Agent Findings ---

const FINDING_FIELDS = `
  findingId
  agentName
  domain
  entityId
  summary
  action
  evidence
  sessionId
  correlationId
  sourceEventId
  createdAt
`;

export const listAgentFindings = /* GraphQL */ `
  query ListAgentFindings($domain: String, $limit: Int, $nextToken: String) {
    listAgentFindings(domain: $domain, limit: $limit, nextToken: $nextToken) {
      items { ${FINDING_FIELDS} }
      nextToken
    }
  }
`;

export const onCreateAgentFinding = /* GraphQL */ `
  subscription OnCreateAgentFinding($domain: String) {
    onCreateAgentFinding(domain: $domain) {
      ${FINDING_FIELDS}
    }
  }
`;

// --- HITL Questions ---

const HITL_FIELDS = `
  taskId
  sessionId
  agentName
  domainId
  question
  options
  evidence
  priority
  status
  answer
  correlationId
  sourceEventId
  createdAt
  answeredAt
`;

export const listHITLQuestions = /* GraphQL */ `
  query ListHITLQuestions($status: String, $domainId: String, $limit: Int, $nextToken: String) {
    listHITLQuestions(status: $status, domainId: $domainId, limit: $limit, nextToken: $nextToken) {
      items { ${HITL_FIELDS} }
      nextToken
    }
  }
`;

export const answerHITLQuestion = /* GraphQL */ `
  mutation AnswerHITLQuestion($input: AnswerHITLQuestionInput!) {
    answerHITLQuestion(input: $input) {
      ${HITL_FIELDS}
    }
  }
`;

export const onCreateHITLQuestion = /* GraphQL */ `
  subscription OnCreateHITLQuestion {
    onCreateHITLQuestion {
      ${HITL_FIELDS}
    }
  }
`;

export const onAnswerHITLQuestion = /* GraphQL */ `
  subscription OnAnswerHITLQuestion {
    onAnswerHITLQuestion {
      ${HITL_FIELDS}
    }
  }
`;
