import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

interface PublisherStackProps extends cdk.StackProps {
  appsyncUrl: string;
  appsyncApiArn: string;
  eventBus: events.IEventBus;
}

export class PublisherStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PublisherStackProps) {
    super(scope, id, props);

    // --- Publisher Lambda (EventBridge → AppSync mutation) ---
    const publisherFn = new lambdaNode.NodejsFunction(this, 'Publisher', {
      functionName: 'aerospace-appsync-publisher',
      entry: path.join(__dirname, '..', '..', 'lambdas', 'appsync-publisher', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        APPSYNC_ENDPOINT: props.appsyncUrl,
      },
      depsLockFilePath: path.join(__dirname, '..', '..', 'lambdas', 'appsync-publisher', 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@smithy/protocol-http', '@smithy/signature-v4', '@aws-crypto/sha256-js', '@aws-sdk/credential-provider-node'],
        minify: true,
        sourceMap: true,
      },
    });

    // AppSync GraphQL mutations on the dashboard API only.
    publisherFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appsync:GraphQL'],
      resources: [`${props.appsyncApiArn}/*`],
    }));

    // --- EventBridge rule → Publisher Lambda ---
    new events.Rule(this, 'DashboardPublisherRule', {
      eventBus: props.eventBus,
      ruleName: 'dashboard-publisher-rule',
      eventPattern: {
        source: ['kafka-connect.aerospace-eventbridge-sink'],
      },
      targets: [new targets.LambdaFunction(publisherFn)],
    });
  }
}
