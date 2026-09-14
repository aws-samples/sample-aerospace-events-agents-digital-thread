# Frontend

React 19 + TypeScript + Vite app for the ARES-1 demo. It runs locally against the CDK-deployed backend:

```bash
../../scripts/generate-env.sh   # writes .env.local from the CDK stack outputs
npm ci && npm run dev           # http://localhost:5173
```

Sign in with the Cognito demo user described in the repository README.
