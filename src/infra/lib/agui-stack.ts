import * as cdk from 'aws-cdk-lib';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';

interface AgUiStackProps extends cdk.StackProps {
  modelId?: string;
}

/**
 * AG-UI analytics agent on AgentCore Runtime (AGUI protocol).
 *
 * A conversational Strands agent over the aerospace event lake that streams its
 * answer back as chart + table + prose widgets via the AG-UI protocol. AgentCore
 * proxies InvokeAgentRuntime straight through to the container's POST /invocations
 * (SSE) on port 8080. Inbound auth is the app's Cognito user pool, so the browser
 * calls the runtime directly with the signed-in user's idToken as a Bearer token.
 *
 * Uses the stable L1 CfnRuntime (protocolConfiguration is a passthrough string, so
 * 'AGUI' is set directly) — no alpha construct, keeping the shared aws-cdk-lib
 * version untouched.
 */
export class AgUiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgUiStackProps = {}) {
    super(scope, id, props);

    // Pull from the already-deployed stacks' named exports (deploy standalone).
    const userPoolId = cdk.Fn.importValue('AerospaceUserPoolId');
    const userPoolClientId = cdk.Fn.importValue('AerospaceUserPoolClientId');
    const apiGatewayUrl = cdk.Fn.importValue('AerospaceApiGatewayUrl');
    const apiGatewayId = cdk.Fn.importValue('AerospaceApiGatewayId');

    // --- Container image (AG-UI server on :8080, ARM64) ---
    const image = new ecr_assets.DockerImageAsset(this, 'AgUiImage', {
      directory: path.join(__dirname, '..', '..', 'agents'),
      file: 'Dockerfile.agui',
      platform: ecr_assets.Platform.LINUX_ARM64,
      exclude: ['**/.venv', '**/__pycache__', '**/*.pyc'],
    });

    // --- Execution role (mirrors what AgentCore Runtime needs) ---
    const role = new iam.Role(this, 'AgUiRuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    image.repository.grantPull(role);
    // X-Ray trace/telemetry and CloudWatch PutMetricData do not support resource-level
    // permissions in IAM, so they must remain on Resource '*'.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'xray:PutTraceSegments', 'xray:PutTelemetryRecords',
        'xray:GetSamplingRules', 'xray:GetSamplingTargets',
        'cloudwatch:PutMetricData',
      ],
      resources: ['*'],
    }));
    // Log delivery, scoped to this account+region.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents',
        'logs:DescribeLogStreams', 'logs:DescribeLogGroups',
      ],
      resources: [`arn:aws:logs:${this.region}:${this.account}:*`],
    }));
    // AgentCore workload-identity token exchange, scoped to this account+region.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:GetWorkloadAccessToken',
        'bedrock-agentcore:GetWorkloadAccessTokenForJWT',
        'bedrock-agentcore:GetWorkloadAccessTokenForUserId',
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
      ],
    }));
    // App permissions: Bedrock model + API Gateway athena-iam route (SigV4 datalake queries).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`],
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'],
      resources: [`arn:aws:execute-api:${this.region}:${this.account}:${apiGatewayId}/*/POST/query/*`],
    }));

    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;

    const runtime = new CfnRuntime(this, 'AgUiAnalyticsRuntime', {
      agentRuntimeName: 'aerospace_agui_analytics',
      description: 'AG-UI analytics agent — Athena/Iceberg queries streamed as chart + table + prose widgets.',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      roleArn: role.roleArn,
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: 'AGUI',
      // idToken carries the app-client id in `aud` (Cognito ID tokens have no
      // client_id claim), so validate the audience rather than the client.
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl,
          allowedAudience: [userPoolClientId],
        },
      },
      environmentVariables: {
        API_GATEWAY_URL: apiGatewayUrl,
        MODEL_ID: props.modelId ?? 'global.anthropic.claude-sonnet-4-6',
        GUARDRAIL_ID: cdk.Fn.importValue('AerospaceGuardrailId'),
        GUARDRAIL_VERSION: 'DRAFT',
      },
    });

    // AgentCore validates ECR pull access against the execution role at create time.
    // Referencing roleArn only orders after the Role, not its inline DefaultPolicy —
    // depend on the whole role construct so the ECR grant is attached first.
    runtime.node.addDependency(role);

    // The browser POSTs the AG-UI RunAgentInput to the data-plane invoke URL for
    // this ARN (qualifier=DEFAULT, Bearer idToken, X-Amzn-Bedrock-AgentCore-Runtime-Session-Id)
    // and reads back the SSE stream.
    new cdk.CfnOutput(this, 'AgUiRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      exportName: 'AerospaceAgUiRuntimeArn',
    });
  }
}
