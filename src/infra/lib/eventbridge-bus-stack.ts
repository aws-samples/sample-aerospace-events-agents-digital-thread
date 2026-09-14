import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Stack 1 of 2: EventBridge bus + rules.
 * Deployed before the MSK Connect stack so the bus ARN is available.
 */
export class EventBridgeBusStack extends cdk.Stack {
  public readonly bus: events.IEventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.bus = new events.EventBus(this, 'AerospaceBus', {
      eventBusName: 'aerospace-central',
    });

    // Quality dashboard rule — placeholder target: CloudWatch
    const qualityLogGroup = new logs.LogGroup(this, 'QualityRuleLogGroup', {
      logGroupName: '/aws/events/aerospace-quality-dashboard',
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new events.Rule(this, 'QualityDashboardRule', {
      eventBus: this.bus,
      ruleName: 'quality-dashboard-rule',
      eventPattern: {
        source: ['kafka-connect.aerospace-eventbridge-sink'],
        detail: { value: { domain: ['QMS', 'DHR'] } },
      },
      targets: [new targets.CloudWatchLogGroup(qualityLogGroup)],
    });

    new cdk.CfnOutput(this, 'EventBusArn', { value: this.bus.eventBusArn, exportName: 'AerospaceEventBusArn' });
    new cdk.CfnOutput(this, 'EventBusName', { value: this.bus.eventBusName, exportName: 'AerospaceEventBusName' });
  }
}
