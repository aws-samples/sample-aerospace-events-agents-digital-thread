#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { EventStack } from '../lib/event-stack';
import { IoTCoreStack } from '../lib/iot-core-stack';
import { StorageStack } from '../lib/storage-stack';
import { EventBridgeBusStack } from '../lib/eventbridge-bus-stack';
import { MskConnectStack } from '../lib/msk-connect-stack';
import { PublisherStack } from '../lib/publisher-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { DigitalThreadConsumersStack } from '../lib/digital-thread-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';
import { AgUiStack } from '../lib/agui-stack';
import { ThreadNavigatorStack } from '../lib/thread-navigator-stack';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { GeneratorStack } from '../lib/generator-stack';
import { GatewayStack } from '../lib/gateway-stack';

const app = new cdk.App();

// Tag every taggable resource across all stacks for cost allocation + governance.
cdk.Tags.of(app).add('Project', 'aerospace-events-agents-digital-thread');
cdk.Tags.of(app).add('Environment', 'demo');
cdk.Tags.of(app).add('ManagedBy', 'cdk');

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-west-1',
};

const appStack = new AppStack(app, 'AerospaceAppStack', { env });
const storageStack = new StorageStack(app, 'AerospaceStorageStack', { env });

const eventStack = new EventStack(app, 'AerospaceEventStack', {
  env,
  qmsTable: appStack.qmsTable,
  mesTable: appStack.mesTable,
  plmTable: appStack.plmTable,
  erpTable: appStack.erpTable,
  srmTable: appStack.srmTable,
  wmsTable: appStack.wmsTable,
  dhrTable: appStack.dhrTable,
  programTable: appStack.programTable,
  inserviceTable: appStack.inserviceTable,
  firehoseStreamName: storageStack.firehoseStreamName,
  firehoseStreamArn: storageStack.firehoseStreamArn,
});

const iotCoreStack = new IoTCoreStack(app, 'AerospaceIoTCoreStack', {
  env,
  vpc: eventStack.vpc,
  lambdaSg: eventStack.lambdaSg,
  bootstrapServers: eventStack.bootstrapServers,
  mskClusterArn: eventStack.mskClusterArn,
});

const busStack = new EventBridgeBusStack(app, 'AerospaceEventBridgeBusStack', { env });

new MskConnectStack(app, 'AerospaceMskConnectStack', {
  env,
  clusterArn: eventStack.mskClusterArn,
  bootstrapServers: eventStack.bootstrapServers,
  busArn: busStack.bus.eventBusArn,
  vpc: eventStack.vpc,
  mskSgId: eventStack.mskSgId,
});

new PublisherStack(app, 'AerospacePublisherStack', {
  env,
  appsyncUrl: appStack.appsyncUrl,
  appsyncApiArn: appStack.appsyncApiArn,
  eventBus: busStack.bus,
});

// Step 7: Neptune
const neptuneStack = new NeptuneStack(app, 'AerospaceNeptuneStack', {
  env,
  vpc: eventStack.vpc,
});

// Step 6+8: API Gateway (Athena + Neptune queries)
const apiGatewayStack = new ApiGatewayStack(app, 'AerospaceApiGatewayStack', {
  env,
  userPoolId: appStack.userPoolId,
  datalakeBucketName: storageStack.datalakeBucketName,
  neptuneQueryFnArn: neptuneStack.queryFnArn,
});

// Step 7: Digital Thread consumers
new DigitalThreadConsumersStack(app, 'AerospaceDigitalThreadStack', {
  env,
  vpc: eventStack.vpc,
  bootstrapServers: eventStack.bootstrapServers,
  mskClusterArn: eventStack.mskClusterArn,
  neptuneEndpoint: neptuneStack.neptuneEndpoint,
  neptunePort: neptuneStack.neptunePort,
  neptuneSg: neptuneStack.neptuneSg,
  neptuneClusterResourceArn: neptuneStack.clusterResourceArn,
  offsetsTableArn: `arn:aws:dynamodb:eu-west-1:${process.env.CDK_DEFAULT_ACCOUNT}:table/digital-thread-offsets`,
  offsetsTableName: neptuneStack.offsetsTableName,
  dlqTableArn: `arn:aws:dynamodb:eu-west-1:${process.env.CDK_DEFAULT_ACCOUNT}:table/graph-write-dlq`,
  dlqTableName: neptuneStack.dlqTableName,
  guardrailId: appStack.guardrailId,
  guardrailVersion: 'DRAFT',
});

// Step 13: AgentCore Gateway (agent write-back to source systems)
const gatewayStack = new GatewayStack(app, 'AerospaceGatewayStack', {
  env,
  userPoolId: appStack.userPoolId,
  restApi: apiGatewayStack.restApi,
});

// Step 9: Strands Agents on AgentCore Runtime (A2A protocol + JWT auth)
// UserPool imported inside AgentCoreStack — just pass the ID
new AgentCoreStack(app, 'AerospaceAgentCoreStack', {
  env,
  eventBus: busStack.bus,
  appsyncUrl: appStack.appsyncUrl,
  appsyncApiArn: appStack.appsyncApiArn,
  apiGatewayUrl: apiGatewayStack.apiUrl,
  apiGatewayId: apiGatewayStack.apiId,
  userPoolId: appStack.userPoolId,
  gatewayUrl: gatewayStack.gatewayUrl,
  gatewayClientId: gatewayStack.gatewayClientId,
  datalakeBucketName: storageStack.datalakeBucketName,
  guardrailId: appStack.guardrailId,
  guardrailVersion: 'DRAFT',
});

// AG-UI analytics agent on AgentCore Runtime (AGUI protocol, browser-direct via Cognito idToken).
// Resolves its inputs from the already-deployed named exports (Fn.importValue). Those exports
// create no CDK dependency edge, so declare the ordering explicitly for `cdk deploy --all`.
const aguiStack = new AgUiStack(app, 'AerospaceAgUiStack', { env });
aguiStack.addDependency(appStack);
aguiStack.addDependency(apiGatewayStack);

// Digital Thread Navigator agent on AgentCore Runtime (AGUI). Same standalone pattern:
// navigates the Neptune graph across domains + dives into the Athena/Iceberg lake.
const threadNavigatorStack = new ThreadNavigatorStack(app, 'AerospaceThreadNavigatorStack', { env });
threadNavigatorStack.addDependency(appStack);
threadNavigatorStack.addDependency(apiGatewayStack);

new GeneratorStack(app, 'AerospaceGeneratorStack', {
  env,
  vpc: eventStack.vpc,
  qmsTable: appStack.qmsTable,
  mesTable: appStack.mesTable,
  plmTable: appStack.plmTable,
  erpTable: appStack.erpTable,
  srmTable: appStack.srmTable,
  wmsTable: appStack.wmsTable,
  dhrTable: appStack.dhrTable,
  programTable: appStack.programTable,
  inserviceTable: appStack.inserviceTable,
  iotEndpoint: iotCoreStack.iotEndpoint,
  datalakeBucketName: storageStack.datalakeBucketName,
});
