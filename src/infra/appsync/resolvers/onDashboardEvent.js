import { extensions } from '@aws-appsync/utils';

export function request(ctx) {
  return { payload: null };
}

export function response(ctx) {
  if (ctx.args.channel) {
    extensions.setSubscriptionFilter({
      filterGroup: [{ filters: [{ fieldName: 'channel', operator: 'eq', value: ctx.args.channel }] }],
    });
  }
  return null;
}
