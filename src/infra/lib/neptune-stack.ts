import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as neptune from 'aws-cdk-lib/aws-neptune';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

interface NeptuneStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class NeptuneStack extends cdk.Stack {
  public readonly neptuneEndpoint: string;
  public readonly neptunePort: string;
  public readonly neptuneSg: ec2.ISecurityGroup;
  public readonly offsetsTableName: string;
  public readonly dlqTableName: string;
  public readonly queryFnArn: string;
  public readonly clusterResourceArn: string;

  constructor(scope: Construct, id: string, props: NeptuneStackProps) {
    super(scope, id, props);
    // Browser origins allowed by CORS (comma-separated; override with `-c frontendOrigins=...`).
    const allowedOrigins: string = this.node.tryGetContext('frontendOrigins') ?? 'http://localhost:5173,http://localhost:5174';

    // --- Security Group ---
    const neptuneSg = new ec2.SecurityGroup(this, 'NeptuneSg', {
      vpc: props.vpc,
      description: 'Neptune cluster',
      allowAllOutbound: true,
    });
    neptuneSg.addIngressRule(ec2.Peer.ipv4(props.vpc.vpcCidrBlock), ec2.Port.tcp(8182), 'VPC to Neptune');
    this.neptuneSg = neptuneSg;

    // --- Neptune Serverless Cluster ---
    const privateSubnets = props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS });

    const subnetGroup = new neptune.CfnDBSubnetGroup(this, 'NeptuneSubnetGroup', {
      dbSubnetGroupDescription: 'Neptune private subnets',
      subnetIds: privateSubnets.subnetIds,
    });

    const cluster = new neptune.CfnDBCluster(this, 'NeptuneCluster', {
      dbClusterIdentifier: 'aerospace-digital-thread',
      engineVersion: '1.3.1.0',
      serverlessScalingConfiguration: {
        minCapacity: 1,
        maxCapacity: 8,
      },
      iamAuthEnabled: true,
      vpcSecurityGroupIds: [neptuneSg.securityGroupId],
      dbSubnetGroupName: subnetGroup.ref,
      storageEncrypted: true,
      // Deletion protection stays off: the sample is torn down with `cdk destroy`.
      deletionProtection: false,
    });
    cluster.addDependency(subnetGroup);

    // Neptune Serverless still needs at least one DB instance for the endpoint to resolve
    const instance = new neptune.CfnDBInstance(this, 'NeptuneInstance', {
      dbInstanceClass: 'db.serverless',
      dbClusterIdentifier: cluster.ref,
    });
    instance.addDependency(cluster);

    this.neptuneEndpoint = cluster.attrEndpoint;
    this.neptunePort = cluster.attrPort;

    // --- Offset Tracking Table ---
    const offsetsTable = new dynamodb.Table(this, 'OffsetsTable', {
      tableName: 'digital-thread-offsets',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.offsetsTableName = offsetsTable.tableName;

    // --- Graph DLQ Table (failed Neptune writes for troubleshooting/replay) ---
    const dlqTable = new dynamodb.Table(this, 'GraphDlqTable', {
      tableName: 'graph-write-dlq',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });
    this.dlqTableName = dlqTable.tableName;

    // --- Neptune Query Lambda ---
    const queryFn = new lambdaNode.NodejsFunction(this, 'NeptuneQuery', {
      functionName: 'aerospace-neptune-query',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'neptune-query', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [neptuneSg],
      environment: {
        NEPTUNE_ENDPOINT: cluster.attrEndpoint,
        NEPTUNE_PORT: cluster.attrPort,
        ALLOWED_ORIGINS: allowedOrigins,
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'neptune-query', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@smithy/protocol-http', '@smithy/signature-v4', '@aws-crypto/sha256-js', '@aws-sdk/credential-provider-node'],
      },
    });

    // Neptune data-plane IAM auth, scoped to this cluster's resource ARN
    this.clusterResourceArn = `arn:aws:neptune-db:${this.region}:${this.account}:${cluster.attrClusterResourceId}/*`;
    queryFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['neptune-db:ReadDataViaQuery', 'neptune-db:WriteDataViaQuery', 'neptune-db:DeleteDataViaQuery',
        'neptune-db:GetQueryStatus', 'neptune-db:CancelQuery', 'neptune-db:GetEngineStatus'],
      resources: [this.clusterResourceArn],
    }));

    this.queryFnArn = queryFn.functionArn;

    // --- Outputs ---
    new cdk.CfnOutput(this, 'NeptuneEndpoint', { value: cluster.attrEndpoint, exportName: 'AerospaceNeptuneEndpoint' });
    new cdk.CfnOutput(this, 'NeptunePort', { value: cluster.attrPort, exportName: 'AerospaceNeptunePort' });
    new cdk.CfnOutput(this, 'OffsetsTableName', { value: offsetsTable.tableName, exportName: 'AerospaceOffsetsTableName' });
    new cdk.CfnOutput(this, 'NeptuneQueryFnArn', { value: queryFn.functionArn, exportName: 'AerospaceNeptuneQueryFnArn' });
  }
}
