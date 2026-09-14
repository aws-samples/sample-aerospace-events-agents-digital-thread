import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiGatewayStackProps extends cdk.StackProps {
  userPoolId: string;
  datalakeBucketName: string;
  neptuneQueryFnArn?: string;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly restApi: apigateway.RestApi;
  public readonly apiId: string;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);
    // Browser origins allowed by CORS (comma-separated; override with `-c frontendOrigins=...`).
    const allowedOrigins: string = this.node.tryGetContext('frontendOrigins') ?? 'http://localhost:5173,http://localhost:5174';

    const userPool = cognito.UserPool.fromUserPoolId(this, 'UserPool', props.userPoolId);

    // --- Athena Query Lambda ---
    const athenaFn = new lambdaNode.NodejsFunction(this, 'AthenaQuery', {
      functionName: 'aerospace-athena-query',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'athena-query', 'index.ts'),
      projectRoot: path.join(__dirname, '..', '..'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      // 60s: text2sql = Bedrock generation + an Athena query; also fixes a latent cutoff
      // (executeQuery polls up to 60s but the timeout was 30s).
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ATHENA_WORKGROUP: 'aerospace-dashboards',
        TEXT2SQL_MODEL: 'global.anthropic.claude-sonnet-4-6',
        ALLOWED_ORIGINS: allowedOrigins,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // Text-to-SQL: generate Athena SQL from a natural-language question with Bedrock.
    athenaFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6*',
      ],
    }));

    // Athena + S3 + Glue permissions
    athenaFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
      ],
      resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/aerospace-dashboards`],
    }));
    athenaFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
      resources: [
        `arn:aws:s3:::${props.datalakeBucketName}`,
        `arn:aws:s3:::${props.datalakeBucketName}/*`,
        `arn:aws:s3:::aerospace-athena-results-${this.region}-${this.account}`,
        `arn:aws:s3:::aerospace-athena-results-${this.region}-${this.account}/*`,
      ],
    }));
    athenaFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/aerospace_events`,
        `arn:aws:glue:${this.region}:${this.account}:table/aerospace_events/*`,
      ],
    }));

    // --- Drawing Presign Lambda ---
    // Returns short-TTL presigned GET URLs for private PLM drawing PNGs.
    const drawingPresignFn = new lambdaNode.NodejsFunction(this, 'DrawingPresign', {
      functionName: 'aerospace-drawing-presign',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'drawing-presign', 'index.ts'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'drawing-presign', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        DATALAKE_BUCKET: props.datalakeBucketName,
        ALLOWED_ORIGINS: allowedOrigins,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    // Read-only, scoped to the drawings/ prefix ONLY
    drawingPresignFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${props.datalakeBucketName}/drawings/*`],
    }));

    // --- API Gateway ---
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const api = new apigateway.RestApi(this, 'AerospaceApi', {
      restApiName: 'aerospace-query-api',
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins.split(','),
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
      deployOptions: {
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      policy: new iam.PolicyDocument({
        statements: [
          // Allow AgentCore Gateway service to invoke /systems/* endpoints (IAM auth)
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com')],
            actions: ['execute-api:Invoke'],
            resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/*/*`],
          }),
          // A resource policy replaces the implicit allow, so callers are re-allowed here; every
          // method still enforces its own authorizer (Cognito for the browser, IAM for agents).
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/*/*`],
          }),
        ],
      }),
    });

    this.restApi = api;

    // Cognito authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuth', {
      cognitoUserPools: [userPool],
    });

    // POST /query/athena
    const queryResource = api.root.addResource('query');
    const athenaResource = queryResource.addResource('athena');
    // Cognito auth for browser, IAM auth for agents
    const defaultResponses = [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }];
    athenaResource.addMethod('POST', new apigateway.LambdaIntegration(athenaFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      methodResponses: defaultResponses,
    });
    // Add IAM-auth method on same resource via a second path
    const athenaIamResource = queryResource.addResource('athena-iam');
    athenaIamResource.addMethod('POST', new apigateway.LambdaIntegration(athenaFn), {
      authorizationType: apigateway.AuthorizationType.IAM,
      methodResponses: defaultResponses,
    });

    // GET /drawings/presign?key=drawings/... (Cognito auth for browser)
    const drawingsResource = api.root.addResource('drawings');
    const presignResource = drawingsResource.addResource('presign');
    presignResource.addMethod('GET', new apigateway.LambdaIntegration(drawingPresignFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      methodResponses: defaultResponses,
    });

    // POST /query/neptune (if Neptune query Lambda ARN provided)
    if (props.neptuneQueryFnArn) {
      // sameEnvironment:true is required — with a bare fromFunctionArn, CDK treats the
      // imported function as external and addPermission() is a silent no-op, so API Gateway
      // gets "Invalid permissions on Lambda function" (500) on every /query/neptune call.
      const neptuneFn = lambda.Function.fromFunctionAttributes(this, 'NeptuneQueryFn', {
        functionArn: props.neptuneQueryFnArn,
        sameEnvironment: true,
      });
      // Grant API Gateway permission to invoke the Neptune Lambda (cross-stack)
      neptuneFn.addPermission('ApiGatewayInvoke', {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: api.arnForExecuteApi(),
      });
      const neptuneResource = queryResource.addResource('neptune');
      neptuneResource.addMethod('POST', new apigateway.LambdaIntegration(neptuneFn), {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
        methodResponses: defaultResponses,
      });
      // IAM-auth path for agents
      const neptuneIamResource = queryResource.addResource('neptune-iam');
      neptuneIamResource.addMethod('POST', new apigateway.LambdaIntegration(neptuneFn), {
        authorizationType: apigateway.AuthorizationType.IAM,
        methodResponses: defaultResponses,
      });
    }

    // Seed baseline Lambda (Python — writes 9 DDB tables, pipeline takes it from there)
    const seedFn = new lambda.Function(this, 'SeedBaseline', {
      functionName: 'aerospace-seed-baseline',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'seed-baseline')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: { DATALAKE_BUCKET: props.datalakeBucketName },
    });
    seedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/qms-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/mes-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/plm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/erp-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/srm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/wms-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/dhr-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/program-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/inservice-demo`,
      ],
    }));

    // POST /hitl — HITL question list + answer
    const hitlFn = new lambdaNode.NodejsFunction(this, 'HitlQuery', {
      functionName: 'aerospace-hitl-query',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'hitl-query', 'index.ts'),
      projectRoot: path.join(__dirname, '..', '..'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      environment: {
        ALLOWED_ORIGINS: allowedOrigins,
        HITL_TABLE: 'hitl-questions',
        GENERATOR_CLUSTER: 'aerospace-demo-generator',
        NEPTUNE_QUERY_FN: 'aerospace-neptune-query',
        DATALAKE_BUCKET: props.datalakeBucketName,
        SESSION_BUCKET: `aerospace-agent-sessions-${this.region}-${this.account}`,
        SEED_FN: seedFn.functionName,
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });
    // DDB: all source system tables + control tables
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/hitl-questions`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/demo-control`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/qms-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/mes-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/plm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/erp-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/srm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/wms-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/dhr-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/program-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/inservice-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/digital-thread-offsets`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/graph-write-dlq`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/agent-trace`,
      ],
    }));
    // Lambda invoke (Neptune drop_all)
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:aws:lambda:${this.region}:${this.account}:function:aerospace-neptune-query`,
        seedFn.functionArn,
      ],
    }));
    // S3 (wipe datalake + agent sessions + Iceberg metadata write)
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket', 's3:DeleteObject', 's3:PutObject', 's3:GetObject', 's3:GetBucketLocation'],
      resources: [
        `arn:aws:s3:::${props.datalakeBucketName}`, `arn:aws:s3:::${props.datalakeBucketName}/*`,
        `arn:aws:s3:::aerospace-agent-sessions-${this.region}-${this.account}`,
        `arn:aws:s3:::aerospace-agent-sessions-${this.region}-${this.account}/*`,
        `arn:aws:s3:::aerospace-athena-results-${this.region}-${this.account}`,
        `arn:aws:s3:::aerospace-athena-results-${this.region}-${this.account}/*`,
      ],
    }));
    // ECS (pause/restart generator). ecs:ListServices has no resource-level support in
    // IAM so it stays on '*'; Update/Describe are scoped to the generator cluster's services.
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListServices'],
      resources: ['*'],
    }));
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:service/aerospace-demo-generator/*`],
    }));
    // Athena (DELETE FROM Iceberg table to clear data without breaking Firehose sync)
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution'],
      resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/aerospace-dashboards`],
    }));
    hitlFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:UpdateTable'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/aerospace_events`,
        `arn:aws:glue:${this.region}:${this.account}:table/aerospace_events/*`,
      ],
    }));

    const hitlResource = api.root.addResource('hitl');
    hitlResource.addMethod('POST', new apigateway.LambdaIntegration(hitlFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
      methodResponses: defaultResponses,
    });

    // --- Source System Writer Lambda (Gateway write-back) ---
    const writerFn = new lambda.Function(this, 'SourceSystemWriter', {
      functionName: 'aerospace-source-system-writer',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'source-system-writer')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    writerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/qms-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/mes-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/plm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/srm-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/program-demo`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/inservice-demo`,
      ],
    }));

    // 6 IAM-auth POST endpoints — one per write operation
    // Each has a request model so the OpenAPI export includes body schemas
    // (AgentCore Gateway uses the export to generate MCP tool input schemas)
    const writerIntegration = new apigateway.LambdaIntegration(writerFn);
    const systemsResource = api.root.addResource('systems');

    const agentContextSchema: apigateway.JsonSchema = {
      type: apigateway.JsonSchemaType.OBJECT,
      properties: {
        agentId: { type: apigateway.JsonSchemaType.STRING, description: 'ID of the calling agent' },
        sessionId: { type: apigateway.JsonSchemaType.STRING, description: 'Agent session ID' },
        correlationId: { type: apigateway.JsonSchemaType.STRING, description: 'Event correlation ID' },
      },
    };

    const writeEndpoints: Array<{
      domain: string; operation: string; modelName: string; description: string;
      properties: Record<string, apigateway.JsonSchema>; required: string[];
    }> = [
      {
        domain: 'qms', operation: 'update-disposition',
        modelName: 'UpdateDisposition', description: 'Update NCR disposition',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'NCR ID (e.g. NCR-1711234-456)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          payload: {
            type: apigateway.JsonSchemaType.OBJECT,
            properties: {
              disposition: { type: apigateway.JsonSchemaType.STRING, description: 'USE_AS_IS, REWORK, SCRAP, or RETURN_TO_SUPPLIER' },
            },
            required: ['disposition'],
          },
          agent_context: agentContextSchema,
        },
        required: ['entity_id', 'reason', 'payload'],
      },
      {
        domain: 'mes', operation: 'release-hold',
        modelName: 'ReleaseHold', description: 'Release a work order hold',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'Work order ID (e.g. WO-82451)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          agent_context: agentContextSchema,
        },
        required: ['entity_id', 'reason'],
      },
      {
        domain: 'srm', operation: 'update-score',
        modelName: 'UpdateScore', description: 'Update supplier quality score',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'Supplier ID (e.g. titan-forge)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          payload: {
            type: apigateway.JsonSchemaType.OBJECT,
            properties: {
              score: { type: apigateway.JsonSchemaType.NUMBER, description: 'New quality score (0-100)' },
            },
            required: ['score'],
          },
          agent_context: agentContextSchema,
        },
        required: ['entity_id', 'reason', 'payload'],
      },
      {
        domain: 'plm', operation: 'create-eco',
        modelName: 'CreateECO', description: 'Create an Engineering Change Order',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'Optional ECO ID (auto-generated if omitted)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          payload: {
            type: apigateway.JsonSchemaType.OBJECT,
            properties: {
              partNumber: { type: apigateway.JsonSchemaType.STRING, description: 'Part number affected' },
              changeType: { type: apigateway.JsonSchemaType.STRING, description: 'REVISION, DEVIATION, or CONCESSION' },
            },
            required: ['partNumber', 'changeType'],
          },
          agent_context: agentContextSchema,
        },
        required: ['reason', 'payload'],
      },
      {
        domain: 'program', operation: 'update-milestone',
        modelName: 'UpdateMilestone', description: 'Update milestone risk status',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'Milestone ID (e.g. MS-004)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          payload: {
            type: apigateway.JsonSchemaType.OBJECT,
            properties: {
              status: { type: apigateway.JsonSchemaType.STRING, description: 'ON_TRACK, AT_RISK, or DELAYED' },
            },
            required: ['status'],
          },
          agent_context: agentContextSchema,
        },
        required: ['entity_id', 'reason', 'payload'],
      },
      {
        domain: 'inservice', operation: 'log-maintenance',
        modelName: 'LogMaintenance', description: 'Log a fleet maintenance action',
        properties: {
          entity_id: { type: apigateway.JsonSchemaType.STRING, description: 'Serial number (e.g. SN-0038)' },
          reason: { type: apigateway.JsonSchemaType.STRING, description: 'Human-approved rationale' },
          payload: {
            type: apigateway.JsonSchemaType.OBJECT,
            properties: {
              actionType: { type: apigateway.JsonSchemaType.STRING, description: 'ADVISORY, INSPECTION, or SERVICE_BULLETIN' },
            },
            required: ['actionType'],
          },
          agent_context: agentContextSchema,
        },
        required: ['entity_id', 'reason', 'payload'],
      },
    ];

    for (const ep of writeEndpoints) {
      const model = api.addModel(ep.modelName, {
        contentType: 'application/json',
        modelName: ep.modelName,
        schema: {
          type: apigateway.JsonSchemaType.OBJECT,
          description: ep.description,
          properties: ep.properties,
          required: ep.required,
        },
      });
      const domainResource = systemsResource.addResource(ep.domain);
      const opResource = domainResource.addResource(ep.operation);
      opResource.addMethod('POST', writerIntegration, {
        authorizationType: apigateway.AuthorizationType.IAM,
        operationName: `${ep.domain}_${ep.operation.replace(/-/g, '_')}`,
        requestModels: { 'application/json': model },
        methodResponses: [
          { statusCode: '200' },
          { statusCode: '400' },
          { statusCode: '500' },
        ],
      });
    }

    // Gateway responses with CORS headers for error cases
    api.addGatewayResponse('Default5XX', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': `'${allowedOrigins.split(',')[0]}'` },
    });
    api.addGatewayResponse('Default4XX', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': `'${allowedOrigins.split(',')[0]}'` },
    });

    this.apiUrl = api.url;
    this.apiId = api.restApiId;

    // --- Outputs ---
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      exportName: 'AerospaceApiGatewayUrl',
    });
    new cdk.CfnOutput(this, 'ApiGatewayId', {
      value: api.restApiId,
      exportName: 'AerospaceApiGatewayId',
    });
  }
}
