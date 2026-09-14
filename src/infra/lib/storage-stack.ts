import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';

export class StorageStack extends cdk.Stack {
  public readonly firehoseStreamName: string;
  public readonly firehoseStreamArn: string;
  public readonly datalakeBucketName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- S3 Buckets ---
    const datalakeBucket = new s3.Bucket(this, 'DatalakeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      bucketName: `aerospace-datalake-${this.region}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Committed, deterministic PLM drawings → datalake drawings/ prefix. Makes the
    // demo reproducible: both the CLI seed and the Demo Control "Seed Baseline"
    // Lambda just write DRAWING# records that reference these already-deployed PNGs.
    new s3deploy.BucketDeployment(this, 'SeedDrawings', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', '..', 'config', 'drawings'))],
      destinationBucket: datalakeBucket,
      destinationKeyPrefix: 'drawings/',
      prune: false,  // never touch events/ (Iceberg) or live-generated drawings
    });

    const athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      bucketName: `aerospace-athena-results-${this.region}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    // --- Glue Database + Iceberg Table ---
    const glueDb = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: this.account,
      databaseInput: { name: 'aerospace_events' },
    });

    const glueTable = new glue.CfnTable(this, 'DomainEventsTable', {
      catalogId: this.account,
      databaseName: 'aerospace_events',
      openTableFormatInput: {
        icebergInput: { metadataOperation: 'CREATE', version: '2' },
      },
      tableInput: {
        name: 'domain_events',
        tableType: 'EXTERNAL_TABLE',
        parameters: { 'format': 'parquet' },
        storageDescriptor: {
          location: `s3://${datalakeBucket.bucketName}/events/`,
          columns: [
            { name: 'event_id', type: 'string' },
            { name: 'event_type', type: 'string' },
            { name: 'event_version', type: 'string' },
            { name: 'domain', type: 'string' },
            { name: 'source_system', type: 'string' },
            { name: 'occurred_at', type: 'string' },
            { name: 'correlation_id', type: 'string' },
            { name: 'entity_id', type: 'string' },
            { name: 'entity_type', type: 'string' },
            { name: 'payload', type: 'string' },
            { name: 'diff', type: 'string' },
            { name: 'actor_user_id', type: 'string' },
            { name: 'actor_system', type: 'string' },
            { name: 'schema_version', type: 'string' },
          ],
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe' },
        },
      },
    });
    glueTable.addDependency(glueDb);

    // --- Athena Workgroup ---
    new athena.CfnWorkGroup(this, 'AthenaWorkgroup', {
      name: 'aerospace-dashboards',
      state: 'ENABLED',
      recursiveDeleteOption: true,  // query history must not block `cdk destroy`
      workGroupConfiguration: {
        resultConfiguration: { outputLocation: `s3://${athenaResultsBucket.bucketName}/results/` },
        engineVersion: { selectedEngineVersion: 'Athena engine version 3' },
      },
    });

    // --- Firehose Transformer Lambda ---
    const transformerFn = new lambdaNode.NodejsFunction(this, 'FirehoseTransformer', {
      functionName: 'aerospace-firehose-transformer',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'firehose-transformer', 'index.ts'),
      projectRoot: path.join(__dirname, '..', '..'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
    });

    // --- Firehose IAM Role ---
    const firehoseRole = new iam.Role(this, 'FirehoseRole', {
      assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });
    datalakeBucket.grantReadWrite(firehoseRole);
    transformerFn.grantInvoke(firehoseRole);

    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTableVersion', 'glue:GetTableVersions', 'glue:GetDatabase', 'glue:UpdateTable'],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/aerospace_events`,
        `arn:aws:glue:${this.region}:${this.account}:table/aerospace_events/*`,
      ],
    }));

    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogGroup', {
      logGroupName: '/aws/firehose/aerospace-events',
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    firehoseLogGroup.grantWrite(firehoseRole);

    // --- DirectPut Firehose → S3 Iceberg ---
    // MSK consumer Lambda will forward events to this Firehose
    const stream = new firehose.CfnDeliveryStream(this, 'EventsFirehose', {
      deliveryStreamName: 'aerospace-events-to-iceberg',
      deliveryStreamType: 'DirectPut',
      icebergDestinationConfiguration: {
        roleArn: firehoseRole.roleArn,
        catalogConfiguration: {
          catalogArn: `arn:aws:glue:${this.region}:${this.account}:catalog`,
        },
        s3Configuration: {
          bucketArn: datalakeBucket.bucketArn,
          roleArn: firehoseRole.roleArn,
          bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
          cloudWatchLoggingOptions: {
            enabled: true,
            logGroupName: firehoseLogGroup.logGroupName,
            logStreamName: 's3-delivery',
          },
        },
        processingConfiguration: {
          enabled: true,
          processors: [{
            type: 'Lambda',
            parameters: [{ parameterName: 'LambdaArn', parameterValue: transformerFn.functionArn }],
          }],
        },
        destinationTableConfigurationList: [{
          destinationDatabaseName: 'aerospace_events',
          destinationTableName: 'domain_events',
          uniqueKeys: ['event_id'],
        }],
        bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
      },
    });
    stream.node.addDependency(firehoseRole);
    stream.node.addDependency(glueTable);

    this.firehoseStreamName = 'aerospace-events-to-iceberg';
    this.datalakeBucketName = datalakeBucket.bucketName;
    this.firehoseStreamArn = stream.attrArn;

    // --- Outputs ---
    new cdk.CfnOutput(this, 'DatalakeBucketName', { value: datalakeBucket.bucketName, exportName: 'AerospaceDatalakeBucketName' });
    new cdk.CfnOutput(this, 'AthenaWorkgroupName', { value: 'aerospace-dashboards', exportName: 'AerospaceAthenaWorkgroupName' });
    new cdk.CfnOutput(this, 'FirehoseStreamName', { value: this.firehoseStreamName, exportName: 'AerospaceFirehoseStreamName' });
  }
}
