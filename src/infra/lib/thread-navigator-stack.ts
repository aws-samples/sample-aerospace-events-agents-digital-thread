import * as cdk from 'aws-cdk-lib';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import * as path from 'path';

interface ThreadNavigatorStackProps extends cdk.StackProps {
  modelId?: string;
}

/**
 * Digital Thread Navigator agent on AgentCore Runtime (AGUI protocol).
 *
 * A conversational Strands agent that navigates the Neptune knowledge graph across
 * domains (via the IAM Neptune query route) and drills into the S3 + Iceberg lake
 * (Athena), streaming its answer back as graph-highlight + chart + table + prose
 * widgets over AG-UI. Same shape as the analytics runtime (AgUiStack): stable L1
 * CfnRuntime, Cognito idToken inbound auth, browser calls the runtime directly.
 */
export class ThreadNavigatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ThreadNavigatorStackProps = {}) {
    super(scope, id, props);

    // Pull from the already-deployed stacks' named exports (deploy standalone).
    const userPoolId = cdk.Fn.importValue('AerospaceUserPoolId');
    const userPoolClientId = cdk.Fn.importValue('AerospaceUserPoolClientId');
    const apiGatewayUrl = cdk.Fn.importValue('AerospaceApiGatewayUrl');
    const apiGatewayId = cdk.Fn.importValue('AerospaceApiGatewayId');

    // --- Container image (AG-UI navigator server on :8080, ARM64) ---
    const image = new ecr_assets.DockerImageAsset(this, 'NavImage', {
      directory: path.join(__dirname, '..', '..', 'agents'),
      file: 'Dockerfile.thread-navigator',
      platform: ecr_assets.Platform.LINUX_ARM64,
      exclude: ['**/.venv', '**/__pycache__', '**/*.pyc'],
    });

    // --- Execution role (mirrors what AgentCore Runtime needs) ---
    const role = new iam.Role(this, 'NavRuntimeRole', {
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
    // App permissions: Bedrock model + API Gateway IAM routes (SigV4 Neptune + Athena queries).
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

    const runtime = new CfnRuntime(this, 'ThreadNavigatorRuntime', {
      agentRuntimeName: 'aerospace_thread_navigator',
      description: 'Digital Thread Navigator — navigates the Neptune graph across domains and dives into the Athena/Iceberg lake, streamed as graph + chart + table + prose widgets.',
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
    runtime.node.addDependency(role);

    new cdk.CfnOutput(this, 'ThreadNavigatorRuntimeArn', {
      value: runtime.attrAgentRuntimeArn,
      exportName: 'AerospaceThreadNavigatorRuntimeArn',
    });
  }
}
