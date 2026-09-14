import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  Gateway,
  GatewayAuthorizer,
  GatewayCredentialProvider,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import {
  ApiGatewayHttpMethod,
} from '@aws-cdk/aws-bedrock-agentcore-alpha/lib/gateway/targets/target-configuration';

interface GatewayStackProps extends cdk.StackProps {
  userPoolId: string;
  restApi: apigateway.IRestApi;
}

export class GatewayStack extends cdk.Stack {
  public readonly gatewayUrl: string;
  public readonly gatewayClientId: string;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    const userPool = cognito.UserPool.fromUserPoolId(this, 'UserPool', props.userPoolId);

    // --- Gateway M2M client (Cognito client_credentials for agent→Gateway auth) ---
    const resourceServer = new cognito.CfnUserPoolResourceServer(this, 'GatewayResourceServer', {
      userPoolId: props.userPoolId,
      identifier: 'aerospace-gateway',
      name: 'Aerospace Gateway',
      scopes: [{ scopeName: 'write', scopeDescription: 'Write to source systems via Gateway' }],
    });

    const gatewayClient = new cognito.CfnUserPoolClient(this, 'GatewayMachineClient', {
      userPoolId: props.userPoolId,
      clientName: 'aerospace-gateway-m2m',
      generateSecret: true,
      allowedOAuthFlows: ['client_credentials'],
      allowedOAuthScopes: ['aerospace-gateway/write'],
      allowedOAuthFlowsUserPoolClient: true,
    });
    gatewayClient.addDependency(resourceServer);

    this.gatewayClientId = gatewayClient.ref;

    const gatewayUserPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this, 'GatewayClientRef', gatewayClient.ref,
    );

    // --- AgentCore Gateway with Cognito JWT auth ---
    const gateway = new Gateway(this, 'AerospaceGateway', {
      gatewayName: 'aerospace-source-systems',
      description: 'Agent write-back to aerospace source systems',
      authorizerConfiguration: GatewayAuthorizer.usingCognito({
        userPool,
        allowedClients: [gatewayUserPoolClient],
      }),
    });

    // Gateway execution role may invoke the /systems write-back routes only.
    gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${props.restApi.restApiId}/*/POST/systems/*`],
    }));

    // --- API Gateway target: 6 write endpoints ---
    // Uses GATEWAY_IAM_ROLE to sign requests with SigV4.
    // API Gateway resource policy allows bedrock-agentcore.amazonaws.com.
    // API Gateway methods use IAM auth.
    gateway.addApiGatewayTarget('SourceSystemWriter', {
      gatewayTargetName: 'source-system-writer',
      description: 'Write-back to aerospace source system DDB tables',
      restApi: props.restApi,
      credentialProviderConfigurations: [GatewayCredentialProvider.fromIamRole()],
      apiGatewayToolConfiguration: {
        toolFilters: [{
          filterPath: '/systems/*',
          methods: [ApiGatewayHttpMethod.POST],
        }],
        toolOverrides: [
          {
            path: '/systems/qms/update-disposition',
            method: ApiGatewayHttpMethod.POST,
            name: 'update_ncr_disposition',
            description: 'Update NCR disposition (USE_AS_IS, REWORK, SCRAP, RETURN_TO_SUPPLIER). Body: {entity_id, reason, payload: {disposition}, agent_context: {agentId, sessionId, correlationId}}',
          },
          {
            path: '/systems/mes/release-hold',
            method: ApiGatewayHttpMethod.POST,
            name: 'release_work_order_hold',
            description: 'Release a hold on a work order. Body: {entity_id, reason, agent_context: {agentId, sessionId, correlationId}}',
          },
          {
            path: '/systems/srm/update-score',
            method: ApiGatewayHttpMethod.POST,
            name: 'update_supplier_score',
            description: 'Update supplier quality score. Body: {entity_id, reason, payload: {score}, agent_context: {agentId, sessionId, correlationId}}',
          },
          {
            path: '/systems/plm/create-eco',
            method: ApiGatewayHttpMethod.POST,
            name: 'create_engineering_change',
            description: 'Create an Engineering Change Order. Body: {entity_id, reason, payload: {partNumber, changeType}, agent_context: {agentId, sessionId, correlationId}}',
          },
          {
            path: '/systems/program/update-milestone',
            method: ApiGatewayHttpMethod.POST,
            name: 'update_milestone_status',
            description: 'Update milestone risk status. Body: {entity_id, reason, payload: {status}, agent_context: {agentId, sessionId, correlationId}}',
          },
          {
            path: '/systems/inservice/log-maintenance',
            method: ApiGatewayHttpMethod.POST,
            name: 'log_maintenance_action',
            description: 'Log a fleet maintenance action. Body: {entity_id, reason, payload: {actionType}, agent_context: {agentId, sessionId, correlationId}}',
          },
        ],
      },
    });

    this.gatewayUrl = gateway.gatewayUrl ?? '';

    new cdk.CfnOutput(this, 'GatewayId', { value: gateway.gatewayId });
    new cdk.CfnOutput(this, 'GatewayUrl', { value: this.gatewayUrl, exportName: 'AerospaceGatewayUrl' });
    new cdk.CfnOutput(this, 'GatewayArn', { value: gateway.gatewayArn });
    new cdk.CfnOutput(this, 'GatewayClientId', { value: this.gatewayClientId, exportName: 'AerospaceGatewayClientId' });
  }
}