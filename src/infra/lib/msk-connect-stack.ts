import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kafkaconnect from 'aws-cdk-lib/aws-kafkaconnect';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/**
 * Stack 2 of 2: MSK Connect connector.
 */
export interface MskConnectStackProps extends cdk.StackProps {
  clusterArn: string;
  bootstrapServers: string;
  busArn: string;
  vpc: ec2.IVpc;
  mskSgId: string;
}

export class MskConnectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MskConnectStackProps) {
    super(scope, id, props);

    // S3 bucket for plugin JAR (ZIP)
    const pluginBucket = new s3.Bucket(this, 'PluginBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload the connector ZIP to S3
    const deployment = new s3deploy.BucketDeployment(this, 'DeployPlugin', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', '..', '.build', 'plugins'), {
        exclude: ['*.jar'],
      })],
      destinationBucket: pluginBucket,
      destinationKeyPrefix: 'plugins/',
    });

    // Custom Plugin (ZIP format)
    const customPlugin = new kafkaconnect.CfnCustomPlugin(this, 'EbSinkPlugin', {
      name: `eb-sink-plugin-${cdk.Aws.STACK_NAME}`,
      contentType: 'ZIP',
      location: {
        s3Location: {
          bucketArn: pluginBucket.bucketArn,
          fileKey: 'plugins/kafka-eventbridge-sink.zip',
        },
      },
    });
    customPlugin.node.addDependency(deployment);

    // CloudWatch log group
    const logGroup = new logs.LogGroup(this, 'ConnectorLogGroup', {
      logGroupName: '/msk-connect/aerospace-eventbridge-sink',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // IAM role for the connector
    const connectorRole = new iam.Role(this, 'ConnectorRole', {
      assumedBy: new iam.ServicePrincipal('kafkaconnect.amazonaws.com'),
    });

    connectorRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'kafka-cluster:Connect',
        'kafka-cluster:DescribeTopic',
        'kafka-cluster:CreateTopic',
        'kafka-cluster:ReadData',
        'kafka-cluster:WriteData',
        'kafka-cluster:DescribeGroup',
        'kafka-cluster:AlterGroup',
        'kafka-cluster:DescribeClusterDynamicConfiguration',
      ],
      resources: [
        props.clusterArn,
        `arn:aws:kafka:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:topic/*`,
        `arn:aws:kafka:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:group/*`,
      ],
    }));

    connectorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:GetBucketLocation'],
      resources: [pluginBucket.bucketArn, `${pluginBucket.bucketArn}/*`],
    }));

    connectorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [props.busArn],
    }));

    connectorRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [logGroup.logGroupArn, `${logGroup.logGroupArn}:*`],
    }));

    // Private subnets for the connector
    const privateSubnets = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    });

    // MSK Connect connector
    const connector = new kafkaconnect.CfnConnector(this, 'EbSinkConnector', {
      connectorName: 'aerospace-eventbridge-sink',
      kafkaCluster: {
        apacheKafkaCluster: {
          bootstrapServers: props.bootstrapServers,
          vpc: {
            securityGroups: [props.mskSgId],
            subnets: privateSubnets.subnetIds,
          },
        },
      },
      kafkaClusterClientAuthentication: { authenticationType: 'IAM' },
      kafkaClusterEncryptionInTransit: { encryptionType: 'TLS' },
      kafkaConnectVersion: '3.7.x',
      plugins: [{
        customPlugin: {
          customPluginArn: customPlugin.attrCustomPluginArn,
          revision: customPlugin.attrRevision,
        },
      }],
      serviceExecutionRoleArn: connectorRole.roleArn,
      capacity: {
        provisionedCapacity: { workerCount: 1, mcuCount: 1 },
      },
      connectorConfiguration: {
        'connector.class': 'software.amazon.event.kafkaconnector.EventBridgeSinkConnector',
        'topics': [
          'aerospace.qms.events',
          'aerospace.mes.events',
          'aerospace.plm.events',
          'aerospace.erp.events',
          'aerospace.srm.events',
          'aerospace.wms.events',
          'aerospace.dhr.events',
          'aerospace.program.events',
          'aerospace.inservice.events',
          'aerospace.scada.events',
        ].join(','),
        'tasks.max': '1',
        'aws.eventbridge.connector.id': 'aerospace-eventbridge-sink',
        'aws.eventbridge.eventbus.arn': props.busArn,
        'aws.eventbridge.region': cdk.Aws.REGION,
        'aws.eventbridge.detail.types.mapper.class': 'software.amazon.event.kafkaconnector.mapping.JsonPathDetailTypeMapper',
        'aws.eventbridge.detail.types.jsonpathmapper.fieldref': '$.eventType',
        'key.converter': 'org.apache.kafka.connect.storage.StringConverter',
        'value.converter': 'org.apache.kafka.connect.json.JsonConverter',
        'value.converter.schemas.enable': 'false',
      },
      logDelivery: {
        workerLogDelivery: {
          cloudWatchLogs: {
            enabled: true,
            logGroup: logGroup.logGroupName,
          },
        },
      },
    });
    connector.node.addDependency(customPlugin);
  }
}
