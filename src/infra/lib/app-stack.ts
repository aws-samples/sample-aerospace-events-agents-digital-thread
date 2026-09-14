import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';
import * as path from 'path';

export class AppStack extends cdk.Stack {
  public readonly qmsTable: dynamodb.Table;
  public readonly mesTable: dynamodb.Table;
  public readonly plmTable: dynamodb.Table;
  public readonly erpTable: dynamodb.Table;
  public readonly srmTable: dynamodb.Table;
  public readonly wmsTable: dynamodb.Table;
  public readonly dhrTable: dynamodb.Table;
  public readonly programTable: dynamodb.Table;
  public readonly inserviceTable: dynamodb.Table;
  public readonly userPoolId: string;
  public readonly appsyncApiArn: string;
  public readonly appsyncUrl: string;
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Cognito ---
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
    });

    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const authenticatedRole = new iam.Role(this, 'AuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref,
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
    });

    // IoT Core permissions for SCADA telemetry WebSocket
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iot:Connect', 'iot:Subscribe', 'iot:Receive'],
      resources: [
        `arn:aws:iot:${this.region}:${this.account}:client/*`,
        `arn:aws:iot:${this.region}:${this.account}:topicfilter/aerospace/*`,
        `arn:aws:iot:${this.region}:${this.account}:topic/aerospace/*`,
      ],
    }));
    // Allow browser to self-attach the (single) browser IoT policy to its Cognito identity.
    // The browser attaches the IoT policy to its own Cognito identity. iot:AttachPolicy only
    // supports cert/thinggroup resource types; an identity target has no ARN, so this action
    // must stay on Resource '*'. The IoT policy itself is the least-privilege boundary.
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iot:AttachPolicy'],
      resources: ['*'],
    }));

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    });

    // IoT Core policy for MQTT WebSocket (required in addition to IAM role)
    new iot.CfnPolicy(this, 'IoTBrowserPolicy', {
      policyName: 'aerospace-browser-iot-policy',
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['iot:Connect'],
            Resource: [`arn:aws:iot:${this.region}:${this.account}:client/*`],
          },
          {
            Effect: 'Allow',
            Action: ['iot:Subscribe'],
            Resource: [`arn:aws:iot:${this.region}:${this.account}:topicfilter/aerospace/*`],
          },
          {
            Effect: 'Allow',
            Action: ['iot:Receive'],
            Resource: [`arn:aws:iot:${this.region}:${this.account}:topic/aerospace/*`],
          },
        ],
      },
    });

    // --- DynamoDB ---
    this.qmsTable = new dynamodb.Table(this, 'QmsTable', {
      tableName: 'qms-demo',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Helper to create source system tables (all follow same schema)
    const makeTable = (id: string, name: string) => new dynamodb.Table(this, id, {
      tableName: name,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.mesTable = makeTable('MesTable', 'mes-demo');
    this.plmTable = makeTable('PlmTable', 'plm-demo');
    this.erpTable = makeTable('ErpTable', 'erp-demo');
    this.srmTable = makeTable('SrmTable', 'srm-demo');
    this.wmsTable = makeTable('WmsTable', 'wms-demo');
    this.dhrTable = makeTable('DhrTable', 'dhr-demo');
    this.programTable = makeTable('ProgramTable', 'program-demo');
    this.inserviceTable = makeTable('InserviceTable', 'inservice-demo');

    // Agent trace table (no stream needed — write-only audit log)
    new dynamodb.Table(this, 'AgentTraceTable', {
      tableName: 'agent-trace',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // --- AppSync ---
    const api = new appsync.GraphqlApi(this, 'QmsApi', {
      name: 'aerospace-qms-api',
      definition: appsync.Definition.fromFile(
        path.join(__dirname, '..', 'appsync', 'schema.graphql'),
      ),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: { userPool },
        },
        additionalAuthorizationModes: [
          { authorizationType: appsync.AuthorizationType.IAM },
        ],
      },
    });

    const ddbSource = api.addDynamoDbDataSource('QmsTableSource', this.qmsTable);
    const mesSource = api.addDynamoDbDataSource('MesTableSource', this.mesTable);
    const plmSource = api.addDynamoDbDataSource('PlmTableSource', this.plmTable);
    const erpSource = api.addDynamoDbDataSource('ErpTableSource', this.erpTable);
    const srmSource = api.addDynamoDbDataSource('SrmTableSource', this.srmTable);
    const wmsSource = api.addDynamoDbDataSource('WmsTableSource', this.wmsTable);
    const dhrSource = api.addDynamoDbDataSource('DhrTableSource', this.dhrTable);
    const programSource = api.addDynamoDbDataSource('ProgramTableSource', this.programTable);
    const inserviceSource = api.addDynamoDbDataSource('InserviceTableSource', this.inserviceTable);
    const noneSource = api.addNoneDataSource('NoneSource');

    // Resolvers
    const resolverDir = path.join(__dirname, '..', 'appsync', 'resolvers');

    ddbSource.createResolver('CreateNonConformanceResolver', {
      typeName: 'Mutation',
      fieldName: 'createNonConformance',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'createNonConformance.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    ddbSource.createResolver('ListNonConformancesResolver', {
      typeName: 'Query',
      fieldName: 'listNonConformances',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'listNonConformances.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    ddbSource.createResolver('GetNonConformanceResolver', {
      typeName: 'Query',
      fieldName: 'getNonConformance',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'getNonConformance.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // --- MES Work Order resolvers ---
    mesSource.createResolver('CreateWorkOrderResolver', {
      typeName: 'Mutation',
      fieldName: 'createWorkOrder',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'createWorkOrder.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    mesSource.createResolver('ListWorkOrdersResolver', {
      typeName: 'Query',
      fieldName: 'listWorkOrders',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'listWorkOrders.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    noneSource.createResolver('OnCreateWorkOrderResolver', {
      typeName: 'Subscription',
      fieldName: 'onCreateWorkOrder',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onCreateWorkOrder.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // --- Generic resolvers for remaining 7 source systems ---
    const genericCreateCode = appsync.Code.fromAsset(path.join(resolverDir, 'genericCreate.js'));
    const genericListCode = appsync.Code.fromAsset(path.join(resolverDir, 'genericList.js'));
    const genericSubCode = appsync.Code.fromAsset(path.join(resolverDir, 'genericSubscription.js'));

    const systemResolvers: Array<{ id: string; source: appsync.DynamoDbDataSource; listField: string; createField: string; subField: string }> = [
      { id: 'Plm', source: plmSource, listField: 'listPlmRecords', createField: 'createPlmRecord', subField: 'onCreatePlmRecord' },
      { id: 'Erp', source: erpSource, listField: 'listErpRecords', createField: 'createErpRecord', subField: 'onCreateErpRecord' },
      { id: 'Srm', source: srmSource, listField: 'listSrmRecords', createField: 'createSrmRecord', subField: 'onCreateSrmRecord' },
      { id: 'Wms', source: wmsSource, listField: 'listWmsRecords', createField: 'createWmsRecord', subField: 'onCreateWmsRecord' },
      { id: 'Dhr', source: dhrSource, listField: 'listDhrRecords', createField: 'createDhrRecord', subField: 'onCreateDhrRecord' },
      { id: 'Program', source: programSource, listField: 'listProgramRecords', createField: 'createProgramRecord', subField: 'onCreateProgramRecord' },
      { id: 'Inservice', source: inserviceSource, listField: 'listInserviceRecords', createField: 'createInserviceRecord', subField: 'onCreateInserviceRecord' },
    ];

    for (const sr of systemResolvers) {
      sr.source.createResolver(`${sr.id}CreateResolver`, {
        typeName: 'Mutation', fieldName: sr.createField,
        code: genericCreateCode, runtime: appsync.FunctionRuntime.JS_1_0_0,
      });
      sr.source.createResolver(`${sr.id}ListResolver`, {
        typeName: 'Query', fieldName: sr.listField,
        code: genericListCode, runtime: appsync.FunctionRuntime.JS_1_0_0,
      });
      noneSource.createResolver(`${sr.id}SubResolver`, {
        typeName: 'Subscription', fieldName: sr.subField,
        code: genericSubCode, runtime: appsync.FunctionRuntime.JS_1_0_0,
      });
    }

    noneSource.createResolver('OnCreateNonConformanceResolver', {
      typeName: 'Subscription',
      fieldName: 'onCreateNonConformance',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onCreateNonConformance.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // Dashboard event mutation (None DS — just triggers subscription)
    noneSource.createResolver('PublishDashboardEventResolver', {
      typeName: 'Mutation',
      fieldName: 'publishDashboardEvent',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'publishDashboardEvent.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    noneSource.createResolver('OnDashboardEventResolver', {
      typeName: 'Subscription',
      fieldName: 'onDashboardEvent',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onDashboardEvent.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // --- Agent Findings (stored in qms-demo table, PK=FINDING#xxx) ---
    ddbSource.createResolver('CreateAgentFindingResolver', {
      typeName: 'Mutation',
      fieldName: 'createAgentFinding',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'createAgentFinding.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    ddbSource.createResolver('ListAgentFindingsResolver', {
      typeName: 'Query',
      fieldName: 'listAgentFindings',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'listAgentFindings.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    noneSource.createResolver('OnCreateAgentFindingResolver', {
      typeName: 'Subscription',
      fieldName: 'onCreateAgentFinding',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onCreateAgentFinding.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // --- HITL Questions (stored in hitl-questions table) ---
    const hitlTable = dynamodb.Table.fromTableName(this, 'HITLTableRef', 'hitl-questions');
    const hitlSource = api.addDynamoDbDataSource('HITLTableSource', hitlTable);

    hitlSource.createResolver('CreateHITLQuestionResolver', {
      typeName: 'Mutation',
      fieldName: 'createHITLQuestion',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'createHITLQuestion.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    hitlSource.createResolver('AnswerHITLQuestionResolver', {
      typeName: 'Mutation',
      fieldName: 'answerHITLQuestion',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'answerHITLQuestion.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    hitlSource.createResolver('ListHITLQuestionsResolver', {
      typeName: 'Query',
      fieldName: 'listHITLQuestions',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'listHITLQuestions.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    noneSource.createResolver('OnCreateHITLQuestionResolver', {
      typeName: 'Subscription',
      fieldName: 'onCreateHITLQuestion',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onCreateHITLQuestion.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    noneSource.createResolver('OnAnswerHITLQuestionResolver', {
      typeName: 'Subscription',
      fieldName: 'onAnswerHITLQuestion',
      code: appsync.Code.fromAsset(path.join(resolverDir, 'onAnswerHITLQuestion.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    // Grant AppSync access to authenticated users
    api.grant(authenticatedRole, appsync.IamResource.all(), 'appsync:GraphQL');

    // --- Bedrock Guardrail (responsible-AI control shared by all agents) ---
    // Minimal, demonstrated (not production-tuned): blocks prompt-injection and an
    // ITAR/EAR export-control denied topic. Strands applies it on every model call when
    // GUARDRAIL_ID + GUARDRAIL_VERSION are set on the runtime.
    const guardrail = new bedrock.CfnGuardrail(this, 'AgentGuardrail', {
      name: 'aerospace-agent-guardrail',
      description: 'Prompt-attack filter + ITAR/EAR export-transfer denied topic for the aerospace agents.',
      blockedInputMessaging: 'This request was blocked by the aerospace agent guardrail.',
      blockedOutputsMessaging: 'This response was blocked by the aerospace agent guardrail.',
      contentPolicyConfig: {
        // LOW blocks high-confidence prompt injections only. Agent-to-agent requests and tool
        // results are legitimately imperative and score MEDIUM at HIGH strength, which silently
        // ended every multi-agent run (Strands redacts an intervened turn into the blocked reply).
        filtersConfig: [{ type: 'PROMPT_ATTACK', inputStrength: 'LOW', outputStrength: 'NONE' }],
      },
      topicPolicyConfig: {
        topicsConfig: [{
          name: 'ExportControlledTechnicalData',
          // Scoped to export/transfer/disclosure requests. The agents' normal work — reading
          // released drawings and discussing part tolerances inside the program — is not a
          // denied topic; a broader definition blocked most legitimate agent turns.
          // Bedrock caps a topic definition at 200 characters.
          definition: 'Requests to export, transfer or disclose ITAR/EAR-controlled technical data (drawings, '
            + 'specs, manufacturing detail) to a foreign person or anyone outside the authorized program.',
          examples: ['Email the wing box drawing to our partner in another country.',
            'Export the bore fitting machining tolerances to the new overseas supplier.',
            'Share the ITAR-controlled specs with a contractor who is not on the program.'],
          type: 'DENY',
        }],
      },
    });
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'AgentGuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
    });
    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailVersion = guardrailVersion.attrVersion;
    // Runtimes apply the DRAFT version, which CDK updates in place; a numbered version is an
    // immutable snapshot whose CloudFormation export cannot change while other stacks import it.
    this.exportValue(guardrailVersion.attrVersion);
    new cdk.CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId, exportName: 'AerospaceGuardrailId' });
    new cdk.CfnOutput(this, 'GuardrailVersion', { value: guardrailVersion.attrVersion, exportName: 'AerospaceGuardrailVersion' });

    this.userPoolId = userPool.userPoolId;
    this.appsyncUrl = api.graphqlUrl;
    this.appsyncApiArn = api.arn;

    // --- Stack Outputs ---
    new cdk.CfnOutput(this, 'AppSyncEndpoint', {
      value: api.graphqlUrl,
      exportName: 'AerospaceAppSyncEndpoint',
    });

    new cdk.CfnOutput(this, 'AppSyncRegion', {
      value: this.region,
      exportName: 'AerospaceAppSyncRegion',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      exportName: 'AerospaceUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      exportName: 'AerospaceUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      exportName: 'AerospaceIdentityPoolId',
    });

    new cdk.CfnOutput(this, 'QmsTableName', {
      value: this.qmsTable.tableName,
      exportName: 'AerospaceQmsTableName',
    });

    new cdk.CfnOutput(this, 'QmsTableStreamArn', {
      value: this.qmsTable.tableStreamArn!,
      exportName: 'AerospaceQmsTableStreamArn',
    });
  }
}
