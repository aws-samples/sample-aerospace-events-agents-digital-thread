import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Runtime, AgentRuntimeArtifact, ProtocolType, RuntimeAuthorizerConfiguration } from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'yaml';

interface AgentCoreStackProps extends cdk.StackProps {
  eventBus: events.IEventBus;
  appsyncUrl: string;
  apiGatewayUrl: string;
  apiGatewayId: string;
  appsyncApiArn: string;
  userPoolId: string;
  gatewayUrl?: string;
  gatewayClientId?: string;
  datalakeBucketName?: string;  // for read_drawing tool: s3:GetObject on drawings/*
  guardrailId: string;
  guardrailVersion: string;
}

export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    // --- Cognito M2M for agent-to-agent JWT auth ---
    const userPoolId = props.userPoolId;

    const resourceServer = new cognito.CfnUserPoolResourceServer(this, 'AgentResourceServer', {
      userPoolId,
      identifier: 'aerospace-agents',
      name: 'Aerospace Agents',
      scopes: [{ scopeName: 'invoke', scopeDescription: 'Invoke agents via A2A' }],
    });

    const machineClient = new cognito.CfnUserPoolClient(this, 'MachineClient', {
      userPoolId: userPoolId,
      clientName: 'aerospace-m2m-client',
      generateSecret: true,
      allowedOAuthFlows: ['client_credentials'],
      allowedOAuthScopes: ['aerospace-agents/invoke'],
      allowedOAuthFlowsUserPoolClient: true,
    });
    machineClient.addDependency(resourceServer);

    // Ensure Cognito domain exists for token endpoint
    const cognitoDomain = new cognito.CfnUserPoolDomain(this, 'CognitoDomain', {
      userPoolId: userPoolId,
      domain: `aerospace-agents-${this.account.substring(0, 8)}`,
    });

    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    // --- S3 bucket for agent sessions ---
    const sessionBucket = new s3.Bucket(this, 'SessionBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      bucketName: `aerospace-agent-sessions-${this.region}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ prefix: 'agents/', expiration: cdk.Duration.days(7) }],
    });

    // --- HITL Questions Table (with streams for resume trigger) ---
    const hitlTable = new dynamodb.Table(this, 'HITLTable', {
      tableName: 'hitl-questions',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Upload agent configs to S3 ---
    const configDir = path.join(__dirname, '..', '..', '..', 'config', 'agents');
    new s3deploy.BucketDeployment(this, 'AgentConfigs', {
      sources: [s3deploy.Source.asset(configDir)],
      destinationBucket: sessionBucket,
      destinationKeyPrefix: 'configs/',
      prune: false,  // don't delete other files in configs/
    });

    // --- Read agent YAML configs + build ARN registry ---
    const configFiles = fs.readdirSync(configDir).filter((f) => f.endsWith('.yaml'));
    // Metadata captured per agent for the AWS Agent Registry records (built after the loop).
    const agentMeta: Array<{ agentId: string; agentName: string; description: string; domain: string; arn: string }> = [];
    // Per-agent dead-letter queues, collected for a single fleet-wide alarm below.
    const agentDlqs: sqs.Queue[] = [];

    // --- AWS Agent Registry (managed discovery — replaces the JSON map; dual-written below) ---
    // CR Lambda manages Registry + A2A records (no native CFN type yet). Bundles boto3>=1.43.
    const registryManagerFn = new lambda.Function(this, 'RegistryManagerFn', {
      functionName: 'aerospace-registry-manager',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'registry-manager'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: ['bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output'],
        },
      }),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        // Registry is authoritative now — its integrity gates the deploy (no soft-fail).
        REGISTRY_FAIL_SOFT: 'false',
      },
    });
    registryManagerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'agent-registry:CreateRegistry', 'agent-registry:GetRegistry',
        'agent-registry:UpdateRegistry', 'agent-registry:DeleteRegistry',
        'agent-registry:CreateRegistryRecord',
        'agent-registry:GetRegistryRecord', 'agent-registry:UpdateRegistryRecord',
        'agent-registry:DeleteRegistryRecord', 'agent-registry:ListRegistryRecords',
        'agent-registry:SubmitRegistryRecordForApproval',
        'agent-registry:UpdateRegistryRecordStatus',
        // create_registry INTERNALLY provisions a workload identity on the caller's behalf;
        // without these the registry goes CREATE_FAILED ("Unable to create workload identity
        // because access was denied."). Confirmed at deploy — the service calls these for us.
        'bedrock-agentcore:CreateWorkloadIdentity', 'bedrock-agentcore:GetWorkloadIdentity',
        'bedrock-agentcore:DeleteWorkloadIdentity',
      ],
      // The registry, its records and the workload identity are created by this function at
      // runtime, so their ARNs are not known at synth time — bounded to this account+region.
      resources: [
        `arn:aws:agent-registry:${this.region}:${this.account}:*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    registryManagerFn.addToRolePolicy(new iam.PolicyStatement({
      // List actions have no resource-level support in IAM.
      actions: ['agent-registry:ListRegistries'],
      resources: ['*'],
    }));

    const registry = new cdk.CustomResource(this, 'ManagedAgentRegistry', {
      serviceToken: registryManagerFn.functionArn,
      properties: {
        Action: 'MANAGE_REGISTRY',
        RegistryName: 'aerospace-agents',
        RegistryDescription: 'Aerospace digital-thread agents — semantic A2A discovery + ARN resolution.',
        AutoApproval: 'true',
      },
    });
    const registryId = registry.getAttString('RegistryId');
    const registryArn = registry.getAttString('RegistryArn');

    for (const configFile of configFiles) {
      const configPath = path.join(configDir, configFile);
      const config = yaml.parse(fs.readFileSync(configPath, 'utf-8'));
      const agentId = config.agentId || configFile.replace('.yaml', '');

      // --- AgentCore Runtime (A2A protocol, JWT auth) ---
      const runtime = new Runtime(this, `${agentId}-Runtime`, {
        runtimeName: `aerospace_${agentId.replace(/-/g, '_')}`,
        description: config.description ?? `Aerospace agent: ${agentId}`,
        agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(
          path.join(__dirname, '..', '..', 'agents'),
          {
            platform: ecr_assets.Platform.LINUX_ARM64,
            exclude: ['.venv', '__pycache__', '*.pyc'],
          },
        ),
        protocolConfiguration: ProtocolType.A2A,
        requestHeaderConfiguration: {
          allowlistedHeaders: [
            'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id',
            'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Id',
            'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Type',
            'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Parent-Session-Id',
          ],
        },
        authorizerConfiguration: RuntimeAuthorizerConfiguration.usingJWT(
          discoveryUrl,
          [machineClient.ref],  // allowedClients
        ),
        environmentVariables: {
          AGENT_CONFIG_S3: `s3://${sessionBucket.bucketName}/configs/${configFile}`,
          SESSION_BUCKET: sessionBucket.bucketName,
          APPSYNC_URL: props.appsyncUrl,
          API_GATEWAY_URL: props.apiGatewayUrl,
          HITL_TABLE: hitlTable.tableName,
          AGENT_NAME: config.agentName ?? agentId,
          AGENT_DOMAIN: config.domain ?? 'quality',
          AGENT_ID: agentId,
          // Cognito M2M for agent-to-agent A2A calls
          COGNITO_TOKEN_URL: `https://aerospace-agents-${this.account.substring(0, 8)}.auth.${this.region}.amazoncognito.com/oauth2/token`,
          COGNITO_CLIENT_ID: machineClient.ref,
          COGNITO_USER_POOL_ID: userPoolId,
          COGNITO_SCOPE: 'aerospace-agents/invoke',
          // AgentCore Gateway for source system write-back
          GATEWAY_MCP_URL: props.gatewayUrl ?? '',
          GATEWAY_CLIENT_ID: props.gatewayClientId ?? '',
          GATEWAY_SCOPE: 'aerospace-gateway/write',
          // AWS Agent Registry — sole source for A2A discovery + ARN resolution.
          REGISTRY_ID: registryId,
          // Bedrock Guardrail (applied by Strands on every model call when both are set).
          GUARDRAIL_ID: props.guardrailId,
          GUARDRAIL_VERSION: props.guardrailVersion,
        },
      });

      agentMeta.push({
        agentId,
        agentName: config.agentName ?? agentId,
        description: (config.description ?? `Aerospace agent: ${agentId}`).trim(),
        domain: config.domain ?? 'quality',
        arn: runtime.agentRuntimeArn,
      });

      // Permissions
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        // Bedrock foundation models + cross-region inference profiles (the agents use
        // cross-region inference, so the model ARN can resolve in any region).
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }));
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`],
      }));
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['appsync:GraphQL'],
        resources: [`${props.appsyncApiArn}/*`],
      }));
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['execute-api:Invoke'],
        // Read-only query routes only; the /systems write-back routes are reached through the Gateway + HITL.
        resources: [`arn:aws:execute-api:${this.region}:${this.account}:${props.apiGatewayId}/*/POST/query/*`],
      }));
      // Cognito (get client secret for M2M JWT — agent-to-agent calls)
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`],
      }));
      // AWS Agent Registry (GA) — control-plane discovery (list/get) scoped to our registry;
      // data-plane semantic search is a separate action.
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['agent-registry:ListRegistryRecords', 'agent-registry:GetRegistryRecord'],
        resources: [registryArn, `${registryArn}/record/*`],
      }));
      runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['agent-registry:SearchDiscoverableRegistryRecords'],
        // Data-plane semantic search across the registry — no record-level resource auth,
        // so this action requires Resource '*'.
        resources: ['*'],
      }));
      hitlTable.grantReadWriteData(runtime.role);
      sessionBucket.grantReadWrite(runtime.role);

      // read_drawing tool — fetch PLM drawing PNGs from the datalake's drawings/ prefix.
      if (props.datalakeBucketName) {
        runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${props.datalakeBucketName}/drawings/*`],
        }));
      }

      // Agent trace table — tools write trace records during execution
      const traceTable = dynamodb.Table.fromTableName(this, `${agentId}-TraceTableRef`, 'agent-trace');
      traceTable.grantWriteData(runtime.role);

      runtime.addEndpoint('default');

      // --- SQS queue for new events (+ dead-letter queue for poison messages) ---
      // A message the trigger Lambda fails to process 3x lands in the DLQ instead of
      // looping. Replay is native SQS DLQ redrive (console/StartMessageMoveTask) back to
      // the source queue — no custom tooling needed. DLQ depth is alarmed below.
      const dlq = new sqs.Queue(this, `${agentId}-DLQ`, {
        queueName: `aerospace-agent-${agentId}-dlq`,
        retentionPeriod: cdk.Duration.days(14),
      });
      agentDlqs.push(dlq);
      const queue = new sqs.Queue(this, `${agentId}-Queue`, {
        queueName: `aerospace-agent-${agentId}`,
        visibilityTimeout: cdk.Duration.minutes(6),
        retentionPeriod: cdk.Duration.days(1),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });

      // --- EventBridge rule → SQS (detail-type + domain filtering) ---
      const detailTypes = config.eventSubscription?.detailTypes ?? [];
      const domains = config.eventSubscription?.domains ?? [];
      const pattern: any = {
        source: [config.eventSubscription?.source ?? 'kafka-connect.aerospace-eventbridge-sink'],
      };
      if (detailTypes.length > 0) {
        pattern.detailType = detailTypes;
      }
      if (domains.length > 0) {
        pattern.detail = { value: { domain: domains } };
      }
      new events.Rule(this, `${agentId}-Rule`, {
        eventBus: props.eventBus,
        ruleName: `agent-${agentId}-rule`,
        eventPattern: pattern,
        targets: [new targets.SqsQueue(queue)],
      });

      // --- Trigger Lambda (routes SQS + DDB Stream → AgentCore via JWT HTTP) ---
      const triggerFn = new lambda.Function(this, `${agentId}-TriggerFn`, {
        functionName: `aerospace-agent-trigger-${agentId}`,
        code: lambda.Code.fromAsset(path.join(__dirname, '..', '..', 'lambdas', 'agent-trigger')),
        handler: 'handler.handler',
        runtime: lambda.Runtime.PYTHON_3_12,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        environment: {
          AGENT_RUNTIME_ARN: runtime.agentRuntimeArn,
          COGNITO_TOKEN_URL: `https://aerospace-agents-${this.account.substring(0, 8)}.auth.${this.region}.amazoncognito.com/oauth2/token`,
          COGNITO_CLIENT_ID: machineClient.ref,
          COGNITO_SCOPE: 'aerospace-agents/invoke',
          COGNITO_USER_POOL_ID: userPoolId,
          AGENT_ID: agentId,
          AGENT_NAME: config.agentName || agentId,
        },
      });

      // Trigger Lambda needs Cognito to get M2M tokens
      triggerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPoolClient'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${userPoolId}`],
      }));
      // Write trace records
      triggerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/agent-trace`],
      }));

      // Wire SQS → trigger Lambda
      triggerFn.addEventSource(new lambdaEventSources.SqsEventSource(queue, { batchSize: 1 }));

      // Wire DynamoDB Stream → trigger Lambda (HITL resume)
      triggerFn.addEventSource(new lambdaEventSources.DynamoEventSource(hitlTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 1,
        bisectBatchOnError: true,
        retryAttempts: 2,
      }));

      // --- Outputs ---
      new cdk.CfnOutput(this, `${agentId}-RuntimeArn`, {
        value: runtime.agentRuntimeArn,
        exportName: `Aerospace${agentId}RuntimeArn`,
      });
    }

    // --- AWS Agent Registry records (one A2A record per agent) ---
    // Sole source of truth for agent-to-agent discovery + ARN resolution (the legacy
    // configs/agent-registry.json was decommissioned in Phase 3).
    for (const m of agentMeta) {
      const record = new cdk.CustomResource(this, `RegistryRecord-${m.agentId}`, {
        serviceToken: registryManagerFn.functionArn,
        properties: {
          Action: 'MANAGE_RECORD',
          RegistryId: registryId,
          RecordName: m.agentId,
          RecordDescription: m.description,
          RecordVersion: '1.0.0',
          RuntimeArn: m.arn,
          AgentName: m.agentName,
          AgentDomain: m.domain,
        },
      });
      record.node.addDependency(registry);
    }

    // Fleet-wide DLQ alarm: fires if ANY agent dead-letter queue has messages, i.e. a
    // poison event needs triage + redrive. One alarm across all agent DLQs via metric math.
    const dlqDepth = new cloudwatch.MathExpression({
      expression: agentDlqs.map((_, i) => `m${i}`).join(' + '),
      usingMetrics: Object.fromEntries(agentDlqs.map((q, i) => [
        `m${i}`, q.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Maximum' }),
      ])),
      label: 'Agent DLQ messages (all agents)',
      period: cdk.Duration.minutes(1),
    });
    new cloudwatch.Alarm(this, 'AgentDlqAlarm', {
      alarmName: 'aerospace-agent-dlq-not-empty',
      alarmDescription: 'One or more agent dead-letter queues have messages — inspect in the SQS console and redrive to source (SQS DLQ redrive).',
      metric: dlqDepth,
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, 'AgentRegistryId', { value: registryId, exportName: 'AerospaceAgentRegistryId' });
    new cdk.CfnOutput(this, 'SessionBucketName', { value: sessionBucket.bucketName, exportName: 'AerospaceSessionBucketName' });
    new cdk.CfnOutput(this, 'HITLTableName', { value: hitlTable.tableName, exportName: 'AerospaceHITLTableName' });
    new cdk.CfnOutput(this, 'MachineClientId', { value: machineClient.ref, exportName: 'AerospaceMachineClientId' });
    new cdk.CfnOutput(this, 'CognitoDomainName', { value: cognitoDomain.domain, exportName: 'AerospaceCognitoDomain' });
  }
}
