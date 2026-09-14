import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as msk from 'aws-cdk-lib/aws-msk';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { ManagedKafkaEventSource, DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface EventStackProps extends cdk.StackProps {
  qmsTable: dynamodb.ITable;
  mesTable: dynamodb.ITable;
  plmTable: dynamodb.ITable;
  erpTable: dynamodb.ITable;
  srmTable: dynamodb.ITable;
  wmsTable: dynamodb.ITable;
  dhrTable: dynamodb.ITable;
  programTable: dynamodb.ITable;
  inserviceTable: dynamodb.ITable;
  firehoseStreamName?: string;
  firehoseStreamArn?: string;
}

export class EventStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly mskClusterArn: string;
  public readonly mskSgId: string;
  public readonly lambdaSg: ec2.ISecurityGroup;
  public readonly bootstrapServers: string;

  constructor(scope: Construct, id: string, props: EventStackProps) {
    super(scope, id, props);

    // --- VPC ---
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
    this.vpc = vpc;

    // VPC flow logs -> CloudWatch (network observability). Short retention + DESTROY
    // so the demo tears down cleanly.
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
      logGroupName: '/aerospace-demo/vpc-flow-logs',
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    vpc.addFlowLog('VpcFlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // Security groups
    const mskSg = new ec2.SecurityGroup(this, 'MskSg', {
      vpc,
      description: 'MSK Serverless cluster',
      allowAllOutbound: true,
    });

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'Lambda functions accessing MSK',
      allowAllOutbound: true,
    });

    // Lambda → MSK on IAM auth port (9098)
    mskSg.addIngressRule(lambdaSg, ec2.Port.tcp(9098), 'Lambda to MSK IAM');
    // Intra-SG only: brokers and the MSK Connect workers (which run in this SG) talk on all ports.
    mskSg.addIngressRule(mskSg, ec2.Port.allTcp(), 'MSK self all ports');
    // Everything else in the VPC (ECS consumers, generators) reaches MSK on the IAM port only.
    mskSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9098), 'VPC to MSK IAM');

    // --- MSK Provisioned (required for MSK Connect compatibility) ---
    const privateSubnets = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    const mskConfig = new msk.CfnConfiguration(this, 'MskConfig', {
      name: `aerospace-central-config-v2-${cdk.Aws.STACK_NAME}`,
      serverProperties: [
        'auto.create.topics.enable=true',
        'num.partitions=3',
        'default.replication.factor=2',
        'min.insync.replicas=1',
      ].join('\n'),
      kafkaVersionsList: ['3.6.0'],
    });

    const cluster = new msk.CfnCluster(this, 'MskCluster', {
      clusterName: 'aerospace-central',
      kafkaVersion: '3.6.0',
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        instanceType: 'kafka.t3.small',
        clientSubnets: privateSubnets.subnetIds,
        securityGroups: [mskSg.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: 10 } },
      },
      clientAuthentication: {
        sasl: { iam: { enabled: true } },
        unauthenticated: { enabled: false },
      },
      encryptionInfo: {
        encryptionInTransit: { clientBroker: 'TLS', inCluster: true },
      },
      configurationInfo: {
        arn: mskConfig.attrArn,
        revision: 1,
      },
    });
    this.mskClusterArn = cluster.attrArn;

    // Least-privilege MSK IAM. Derive topic/group ARN patterns from the cluster ARN
    // (arn:...:cluster/<name>/<uuid> -> :topic/<name>/<uuid>/* and :group/<name>/<uuid>/*)
    // so producers/consumers receive scoped kafka-cluster actions on the cluster, its
    // topics, and its consumer groups instead of Action '*' on Resource '*'.
    const mskArnParts = cdk.Fn.split(':cluster/', cluster.attrArn);
    const mskArnPrefix = cdk.Fn.select(0, mskArnParts);
    const mskClusterPath = cdk.Fn.select(1, mskArnParts);
    const mskTopicArn = `${mskArnPrefix}:topic/${mskClusterPath}/*`;
    const mskGroupArn = `${mskArnPrefix}:group/${mskClusterPath}/*`;
    const mskAccessStatement = () => new iam.PolicyStatement({
      actions: [
        'kafka-cluster:Connect',
        'kafka-cluster:DescribeCluster',
        'kafka-cluster:CreateTopic',
        'kafka-cluster:DescribeTopic',
        'kafka-cluster:WriteData',
        'kafka-cluster:ReadData',
        'kafka-cluster:AlterGroup',
        'kafka-cluster:DescribeGroup',
      ],
      resources: [cluster.attrArn, mskTopicArn, mskGroupArn],
    });

    // Get bootstrap brokers via custom resource
    const bootstrapBrokers = new cr.AwsCustomResource(this, 'BootstrapBrokers', {
      onCreate: {
        service: 'Kafka',
        action: 'getBootstrapBrokers',
        parameters: { ClusterArn: cluster.attrArn },
        physicalResourceId: cr.PhysicalResourceId.of('BootstrapBrokers'),
      },
      onUpdate: {
        service: 'Kafka',
        action: 'getBootstrapBrokers',
        parameters: { ClusterArn: cluster.attrArn },
        physicalResourceId: cr.PhysicalResourceId.of('BootstrapBrokers'),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [cluster.attrArn],
      }),
    });
    bootstrapBrokers.node.addDependency(cluster);

    const bootstrapServers = bootstrapBrokers.getResponseField('BootstrapBrokerStringSaslIam');
    this.mskSgId = mskSg.securityGroupId;
    this.lambdaSg = lambdaSg;
    this.bootstrapServers = bootstrapServers;

    // --- Lambda Producer (DynamoDB Stream → MSK) ---
    const producerFn = new lambdaNode.NodejsFunction(this, 'QmsProducer', {
      functionName: 'aerospace-qms-producer',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'qms-producer', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        BOOTSTRAP_SERVERS: bootstrapServers,
        MSK_TOPIC: 'aerospace.qms.events',
        DOMAIN: 'QMS',
        SOURCE_SYSTEM: 'qms-demo',
        ENTITY_TYPE: 'NonConformance',
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'qms-producer', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['kafkajs', 'aws-msk-iam-sasl-signer-js'],
        minify: true,
        sourceMap: true,
      },
    });

    // MSK IAM — scoped to this cluster, its topics and its consumer groups
    producerFn.addToRolePolicy(mskAccessStatement());
    producerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
      resources: [cluster.attrArn],
    }));

    // Wire DynamoDB Stream → QMS Producer Lambda
    producerFn.addEventSource(new DynamoEventSource(props.qmsTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(1),
      bisectBatchOnError: true,
      reportBatchItemFailures: true,
      retryAttempts: 3,
    }));

    // --- MES Producer (DynamoDB Stream → MSK) ---
    const mesProducerFn = new lambdaNode.NodejsFunction(this, 'MesProducer', {
      functionName: 'aerospace-mes-producer',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'mes-producer', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        BOOTSTRAP_SERVERS: bootstrapServers,
        MSK_TOPIC: 'aerospace.mes.events',
        DOMAIN: 'MES',
        SOURCE_SYSTEM: 'mes-demo',
        ENTITY_TYPE: 'WorkOrder',
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'mes-producer', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['kafkajs', 'aws-msk-iam-sasl-signer-js'],
        minify: true,
        sourceMap: true,
      },
    });
    mesProducerFn.addToRolePolicy(mskAccessStatement());
    mesProducerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
      resources: [cluster.attrArn],
    }));
    mesProducerFn.addEventSource(new DynamoEventSource(props.mesTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      maxBatchingWindow: cdk.Duration.seconds(1),
      bisectBatchOnError: true,
      reportBatchItemFailures: true,
      retryAttempts: 3,
    }));

    // --- Generic Producers for remaining domains (DynamoDB Stream → MSK) ---
    const genericProducerEntry = path.join(__dirname, '..', '..', 'lambdas', 'generic-producer', 'index.ts');
    const genericProducerLock = path.join(__dirname, '..', '..', 'lambdas', 'generic-producer', 'package-lock.json');
    const genericBundling = {
      externalModules: ['@aws-sdk/*'],
      nodeModules: ['kafkajs', 'aws-msk-iam-sasl-signer-js'],
      minify: true,
      sourceMap: true,
    };

    const domainProducers: Array<{ id: string; name: string; topic: string; domain: string; source: string; entity: string; table: dynamodb.ITable }> = [
      // ERP/PLM are the "legacy" apps: they publish NATIVE vendor vocab to RAW topics.
      // The event-normalizer Lambda maps raw → ISA-95 canonical and republishes to
      // aerospace.{erp,plm}.events (consumed by graph + datalake + agents).
      { id: 'Plm', name: 'plm', topic: 'aerospace.plm.raw', domain: 'PLM', source: 'plm-demo', entity: 'Part', table: props.plmTable },
      { id: 'Erp', name: 'erp', topic: 'aerospace.erp.raw', domain: 'ERP', source: 'erp-demo', entity: 'PurchaseOrder', table: props.erpTable },
      { id: 'Srm', name: 'srm', topic: 'aerospace.srm.events', domain: 'SRM', source: 'srm-demo', entity: 'Supplier', table: props.srmTable },
      { id: 'Wms', name: 'wms', topic: 'aerospace.wms.events', domain: 'WMS', source: 'wms-demo', entity: 'Kit', table: props.wmsTable },
      { id: 'Dhr', name: 'dhr', topic: 'aerospace.dhr.events', domain: 'DHR', source: 'dhr-demo', entity: 'SerialRecord', table: props.dhrTable },
      { id: 'Program', name: 'program', topic: 'aerospace.program.events', domain: 'PROGRAM', source: 'program-demo', entity: 'Program', table: props.programTable },
      { id: 'Inservice', name: 'inservice', topic: 'aerospace.inservice.events', domain: 'INSERVICE', source: 'inservice-demo', entity: 'DigitalTwin', table: props.inserviceTable },
    ];

    for (const dp of domainProducers) {
      const fn = new lambdaNode.NodejsFunction(this, `${dp.id}Producer`, {
        functionName: `aerospace-${dp.name}-producer`,
        entry: genericProducerEntry,
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [lambdaSg],
        environment: {
          BOOTSTRAP_SERVERS: bootstrapServers,
          MSK_TOPIC: dp.topic,
          DOMAIN: dp.domain,
          SOURCE_SYSTEM: dp.source,
          ENTITY_TYPE: dp.entity,
        },
        depsLockFilePath: genericProducerLock,
        bundling: genericBundling,
      });
      fn.addToRolePolicy(mskAccessStatement());
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
        resources: [cluster.attrArn],
      }));
      fn.addEventSource(new DynamoEventSource(dp.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(1),
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 3,
      }));
    }

    // --- Event Normalizer (MSK raw → ISA-95 canonical, ERP/PLM) ---
    // The "legacy" ERP/PLM apps publish native vendor vocab to aerospace.{erp,plm}.raw.
    // This Lambda maps to ISA-95 and republishes to aerospace.{erp,plm}.events, which
    // the graph, datalake, and agents all consume — making all three ISA-95-compliant.
    const normalizerFn = new lambdaNode.NodejsFunction(this, 'EventNormalizer', {
      functionName: 'aerospace-event-normalizer',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'event-normalizer', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        BOOTSTRAP_SERVERS: bootstrapServers,
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'event-normalizer', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['kafkajs', 'aws-msk-iam-sasl-signer-js'],
        minify: true,
        sourceMap: true,
      },
    });
    normalizerFn.addToRolePolicy(mskAccessStatement());
    normalizerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
      resources: [cluster.attrArn],
    }));
    // Consume the raw legacy topics; republish (via kafkajs) to canonical topics.
    for (const rawTopic of ['aerospace.erp.raw', 'aerospace.plm.raw']) {
      normalizerFn.addEventSource(new ManagedKafkaEventSource({
        clusterArn: cluster.attrArn,
        topic: rawTopic,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
      }));
    }

    // --- Lambda Consumer (MSK → CloudWatch logs) ---
    const consumerFn = new lambdaNode.NodejsFunction(this, 'MskConsumer', {
      functionName: 'aerospace-msk-consumer',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'msk-consumer', 'index.ts'),
      projectRoot: path.join(__dirname, '..', '..'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSg],
      environment: {
        ...(props.firehoseStreamName ? { FIREHOSE_STREAM_NAME: props.firehoseStreamName } : {}),
      },
      bundling: { externalModules: ['@aws-sdk/*'] },
    });

    // Firehose write permission
    if (props.firehoseStreamArn) {
      consumerFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'],
        resources: [props.firehoseStreamArn],
      }));
    }

    // MSK event sources for consumer — all domain topics → Firehose → Iceberg
    const allTopics = [
      'aerospace.qms.events', 'aerospace.mes.events', 'aerospace.plm.events',
      'aerospace.erp.events', 'aerospace.srm.events', 'aerospace.wms.events',
      'aerospace.dhr.events', 'aerospace.program.events', 'aerospace.inservice.events',
    ];
    for (const topic of allTopics) {
      consumerFn.addEventSource(new ManagedKafkaEventSource({
        clusterArn: cluster.attrArn,
        topic,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
      }));
    }

    // MSK IAM — scoped to this cluster, its topics and its consumer groups
    consumerFn.addToRolePolicy(mskAccessStatement());
    consumerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
      resources: [cluster.attrArn],
    }));

    // VPC ENI lifecycle for the event-source mapping is granted by CDK automatically
    // (AWSLambdaVPCAccessExecutionRole is attached when `vpc` is set on the function),
    // so no manual ec2:*NetworkInterface statement on Resource '*' is needed here.

    // --- Outputs ---
    new cdk.CfnOutput(this, 'MskClusterArn', {
      value: cluster.attrArn,
      exportName: 'AerospaceMskClusterArn',
    });

    new cdk.CfnOutput(this, 'BootstrapServers', {
      value: bootstrapServers,
      exportName: 'AerospaceBootstrapServers',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      exportName: 'AerospaceVpcId',
    });
  }
}
