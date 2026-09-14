import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface DigitalThreadConsumersStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  bootstrapServers: string;
  mskClusterArn: string;
  neptuneEndpoint: string;
  neptunePort: string;
  neptuneSg: ec2.ISecurityGroup;
  neptuneClusterResourceArn: string;
  offsetsTableArn: string;
  offsetsTableName: string;
  dlqTableArn?: string;
  dlqTableName?: string;
  guardrailId: string;
  guardrailVersion: string;
}

export class DigitalThreadConsumersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DigitalThreadConsumersStackProps) {
    super(scope, id, props);

    const cluster = new ecs.Cluster(this, 'ConsumerCluster', {
      clusterName: 'aerospace-digital-thread',
      vpc: props.vpc,
    });

    // MSK topic/group ARN patterns derived from the cluster ARN (see EventStack).
    const mskArnParts = cdk.Fn.split(':cluster/', props.mskClusterArn);
    const mskArnPrefix = cdk.Fn.select(0, mskArnParts);
    const mskClusterPath = cdk.Fn.select(1, mskArnParts);
    const mskTopicArn = `${mskArnPrefix}:topic/${mskClusterPath}/*`;
    const mskGroupArn = `${mskArnPrefix}:group/${mskClusterPath}/*`;

    // Shared IAM permissions
    const consumerPolicy = [
      new iam.PolicyStatement({
        actions: [
          'kafka-cluster:Connect',
          'kafka-cluster:DescribeCluster',
          'kafka-cluster:DescribeTopic',
          'kafka-cluster:ReadData',
          'kafka-cluster:WriteData',
          'kafka-cluster:AlterGroup',
          'kafka-cluster:DescribeGroup',
        ],
        resources: [props.mskClusterArn, mskTopicArn, mskGroupArn],
      }),
      new iam.PolicyStatement({
        actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
        resources: [props.mskClusterArn],
      }),
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        resources: [
          props.offsetsTableArn,
          ...(props.dlqTableArn ? [props.dlqTableArn] : []),
        ],
      }),
      new iam.PolicyStatement({
        actions: ['neptune-db:ReadDataViaQuery', 'neptune-db:WriteDataViaQuery', 'neptune-db:DeleteDataViaQuery',
        'neptune-db:GetQueryStatus', 'neptune-db:CancelQuery', 'neptune-db:GetEngineStatus'],
        resources: [props.neptuneClusterResourceArn],
      }),
      // ISA-95 L3: rdf_writer dual-writes via the Neptune query Lambda's sparql_update op
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          `arn:aws:lambda:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:function:aerospace-neptune-query`,
        ],
      }),
    ];

    // --- Fast Consumer ---
    const fastTask = new ecs.FargateTaskDefinition(this, 'FastConsumerTask', { memoryLimitMiB: 512, cpu: 256 });
    consumerPolicy.forEach((p) => fastTask.taskRole.addToPrincipalPolicy(p));

    fastTask.addContainer('fast-consumer', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '..', '..', 'consumers', 'fast-consumer'),
        { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'fast',
        logGroup: new logs.LogGroup(this, 'FastConsumerLogs', {
          logGroupName: '/aerospace-demo/fast-consumer',
          retention: logs.RetentionDays.THREE_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        BOOTSTRAP_SERVERS: props.bootstrapServers,
        NEPTUNE_ENDPOINT: props.neptuneEndpoint,
        NEPTUNE_PORT: props.neptunePort,
        OFFSETS_TABLE: props.offsetsTableName,
        DLQ_TABLE: props.dlqTableName || '',
        AWS_DEFAULT_REGION: 'eu-west-1',
        // ISA-95 L3 — dual-write to RDF + B2MML side-channel.
        RDF_DUAL_WRITE: 'true',
        NEPTUNE_QUERY_LAMBDA: 'aerospace-neptune-query',
        RDF_ABOX_GRAPH: 'https://ares.example/aerospace/digitalthread/abox',
        B2MML_ENABLED: 'false',  // archive bucket not provisioned for L3 happy-path
      },
    });

    new ecs.FargateService(this, 'FastConsumerService', {
      cluster,
      taskDefinition: fastTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.neptuneSg],
      enableExecuteCommand: true,
      circuitBreaker: { enable: true, rollback: true },
    });

    // --- Slow Consumer (Strands Agent) ---
    const slowTask = new ecs.FargateTaskDefinition(this, 'SlowConsumerTask', { memoryLimitMiB: 1024, cpu: 512 });
    consumerPolicy.forEach((p) => slowTask.taskRole.addToPrincipalPolicy(p));

    // Bedrock access for Strands agent — foundation models + cross-region inference profiles
    slowTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));
    slowTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'],
      resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`],
    }));

    slowTask.addContainer('slow-consumer', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '..', '..', 'consumers', 'slow-consumer'),
        { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'slow',
        logGroup: new logs.LogGroup(this, 'SlowConsumerLogs', {
          logGroupName: '/aerospace-demo/slow-consumer',
          retention: logs.RetentionDays.THREE_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        BOOTSTRAP_SERVERS: props.bootstrapServers,
        NEPTUNE_ENDPOINT: props.neptuneEndpoint,
        NEPTUNE_PORT: props.neptunePort,
        OFFSETS_TABLE: props.offsetsTableName,
        BEDROCK_MODEL_ID: 'global.anthropic.claude-sonnet-4-6',
        AWS_DEFAULT_REGION: 'eu-west-1',
        GUARDRAIL_ID: props.guardrailId,
        GUARDRAIL_VERSION: props.guardrailVersion,
      },
    });

    new ecs.FargateService(this, 'SlowConsumerService', {
      cluster,
      taskDefinition: slowTask,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.neptuneSg],
      circuitBreaker: { enable: true, rollback: true },
    });
  }
}
