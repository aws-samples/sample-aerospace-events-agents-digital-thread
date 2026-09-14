import * as cdk from 'aws-cdk-lib';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as path from 'path';

interface IoTCoreStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  lambdaSg: ec2.ISecurityGroup;
  bootstrapServers: string;
  mskClusterArn: string;
}

export class IoTCoreStack extends cdk.Stack {
  public readonly iotEndpoint: string;

  constructor(scope: Construct, id: string, props: IoTCoreStackProps) {
    super(scope, id, props);

    // --- Get IoT Core endpoint ---
    const iotEndpointCr = new cr.AwsCustomResource(this, 'IoTEndpoint', {
      onCreate: {
        service: 'Iot',
        action: 'describeEndpoint',
        parameters: { endpointType: 'iot:Data-ATS' },
        physicalResourceId: cr.PhysicalResourceId.of('IoTEndpoint'),
      },
      // iot:DescribeEndpoint has no resource-level support in IAM, so this readonly
      // lookup must use Resource '*'.
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: ['*'] }),
    });

    const endpoint = iotEndpointCr.getResponseField('endpointAddress');
    this.iotEndpoint = endpoint;

    // Store in SSM for generator and frontend
    new ssm.StringParameter(this, 'IoTEndpointParam', {
      parameterName: '/aerospace-demo/iot/endpoint',
      stringValue: endpoint,
    });

    // Debounce table — suppresses sustained-fault floods (1 Hz telemetry would
    // otherwise invoke the SCADA agents once per second). One row per machine+eventType,
    // self-expiring via TTL so the next event after the cooldown re-publishes.
    const debounceTable = new dynamodb.Table(this, 'ScadaAnomalyDebounce', {
      tableName: 'scada-anomaly-debounce',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- SCADA Event Forwarder Lambda ---
    const forwarderFn = new lambdaNode.NodejsFunction(this, 'ScadaEventForwarder', {
      functionName: 'aerospace-scada-event-forwarder',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'scada-event-forwarder', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      environment: {
        BOOTSTRAP_SERVERS: props.bootstrapServers,
        MSK_TOPIC: 'aerospace.scada.events',
        DEBOUNCE_TABLE: debounceTable.tableName,
        DEBOUNCE_SECONDS: '300',
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'scada-event-forwarder', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['kafkajs', 'aws-msk-iam-sasl-signer-js'],
        minify: true,
        sourceMap: true,
      },
    });

    debounceTable.grantWriteData(forwarderFn);

    // MSK permissions — scoped to this cluster, its topics and its consumer groups.
    const mskArnParts = cdk.Fn.split(':cluster/', props.mskClusterArn);
    const mskArnPrefix = cdk.Fn.select(0, mskArnParts);
    const mskClusterPath = cdk.Fn.select(1, mskArnParts);
    forwarderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'kafka-cluster:Connect',
        'kafka-cluster:DescribeCluster',
        'kafka-cluster:CreateTopic',
        'kafka-cluster:DescribeTopic',
        'kafka-cluster:WriteData',
        'kafka-cluster:AlterGroup',
        'kafka-cluster:DescribeGroup',
      ],
      resources: [
        props.mskClusterArn,
        `${mskArnPrefix}:topic/${mskClusterPath}/*`,
        `${mskArnPrefix}:group/${mskClusterPath}/*`,
      ],
    }));
    forwarderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kafka:DescribeClusterV2', 'kafka:GetBootstrapBrokers'],
      resources: [props.mskClusterArn],
    }));

    // Allow IoT Core to invoke the Lambda
    forwarderFn.addPermission('IoTInvoke', {
      principal: new iam.ServicePrincipal('iot.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // --- IoT Core Rules ---
    // Rule 1: Machine fault
    new iot.CfnTopicRule(this, 'MachineFaultRule', {
      ruleName: 'aerospace_machine_fault',
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic FROM 'aerospace/ares1/+/+/status' WHERE status = 'FAULT'",
        awsIotSqlVersion: '2016-03-23',
        actions: [{
          lambda: { functionArn: forwarderFn.functionArn },
        }],
      },
    });

    // Rule 2: OEE threshold breach
    new iot.CfnTopicRule(this, 'OeeBreachRule', {
      ruleName: 'aerospace_oee_breach',
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic FROM 'aerospace/ares1/+/+/oee_percent' WHERE value < 75",
        awsIotSqlVersion: '2016-03-23',
        actions: [{
          lambda: { functionArn: forwarderFn.functionArn },
        }],
      },
    });

    // Rule 3: Bearing wear (spindle vibration anomaly)
    new iot.CfnTopicRule(this, 'BearingWearRule', {
      ruleName: 'aerospace_bearing_wear',
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic FROM 'aerospace/ares1/+/cnc-mill-3/spindle_vibration_mm_s' WHERE value > 1.8",
        awsIotSqlVersion: '2016-03-23',
        actions: [{
          lambda: { functionArn: forwarderFn.functionArn },
        }],
      },
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'IoTEndpointOutput', {
      value: endpoint,
      exportName: 'AerospaceIoTEndpoint',
    });
  }
}
