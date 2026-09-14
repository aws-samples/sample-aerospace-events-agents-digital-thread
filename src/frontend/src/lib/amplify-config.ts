import { Amplify } from 'aws-amplify';

export function configureAmplify() {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: import.meta.env.VITE_USER_POOL_ID,
        userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
        identityPoolId: import.meta.env.VITE_IDENTITY_POOL_ID,
      },
    },
    API: {
      GraphQL: {
        endpoint: import.meta.env.VITE_APPSYNC_ENDPOINT,
        region: import.meta.env.VITE_AWS_REGION,
        defaultAuthMode: 'userPool' as const,
      },
    },
  });

}
