import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface GeneratorStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  qmsTable: dynamodb.ITable;
  mesTable: dynamodb.ITable;
  plmTable: dynamodb.ITable;
  erpTable: dynamodb.ITable;
  srmTable: dynamodb.ITable;
  wmsTable: dynamodb.ITable;
  dhrTable: dynamodb.ITable;
  programTable: dynamodb.ITable;
  inserviceTable: dynamodb.ITable;
  iotEndpoint: string;
  datalakeBucketName: string;  // PLM drawings stored under drawings/ prefix
}

export class GeneratorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GeneratorStackProps) {
    super(scope, id, props);

    // --- Demo Control Table ---
    const controlTable = new dynamodb.Table(this, 'DemoControlTable', {
      tableName: 'demo-control',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- ECS Cluster ---
    const cluster = new ecs.Cluster(this, 'GeneratorCluster', {
      clusterName: 'aerospace-demo-generator',
      vpc: props.vpc,
    });

    // --- Task Definition ---
    const taskDef = new ecs.FargateTaskDefinition(this, 'GeneratorTask', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // DynamoDB permissions
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:PutItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        props.qmsTable.tableArn,
        props.mesTable.tableArn,
        props.plmTable.tableArn,
        props.erpTable.tableArn,
        props.srmTable.tableArn,
        props.wmsTable.tableArn,
        props.dhrTable.tableArn,
        props.programTable.tableArn,
        props.inserviceTable.tableArn,
        controlTable.tableArn,
      ],
    }));

    // IoT Core publish permission for SCADA telemetry
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['iot:Publish'],
      resources: [`arn:aws:iot:${this.region}:${this.account}:topic/aerospace/*`],
    }));

    // Container
    taskDef.addContainer('generator', {
      image: ecs.ContainerImage.fromAsset(
        path.join(__dirname, '..', '..', 'generators'),
        { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 },
      ),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'generator',
        logGroup: new logs.LogGroup(this, 'GeneratorLogs', {
          logGroupName: '/aerospace-demo/generator',
          retention: logs.RetentionDays.THREE_DAYS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      }),
      environment: {
        DEMO_CONTROL_TABLE: controlTable.tableName,
        IOT_ENDPOINT: props.iotEndpoint,
        AWS_DEFAULT_REGION: 'eu-west-1',
        DRAWINGS_BUCKET: props.datalakeBucketName,
        GENERATOR_CLUSTER: cluster.clusterName,
      },
    });

    // PLM drawings: write generated 2D drawing PNGs under the datalake's drawings/ prefix.
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`arn:aws:s3:::${props.datalakeBucketName}/drawings/*`],
    }));

    // Auto-stop: the generator scales its OWN service to 0 after autoStopHours.
    // ecs:ListServices has no resource-level support in IAM so it stays on '*';
    // Update/Describe are scoped to services in this cluster.
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:ListServices'],
      resources: ['*'],
    }));
    taskDef.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
      resources: [`arn:aws:ecs:${this.region}:${this.account}:service/${cluster.clusterName}/*`],
    }));

    // --- Fargate Service ---
    new ecs.FargateService(this, 'GeneratorService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DemoControlTableName', {
      value: controlTable.tableName,
      exportName: 'DemoControlTableName',
    });

    new cdk.CfnOutput(this, 'GeneratorClusterName', {
      value: cluster.clusterName,
      exportName: 'GeneratorClusterName',
    });
  }
}
