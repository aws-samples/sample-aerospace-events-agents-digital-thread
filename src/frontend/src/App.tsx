import { useState, useEffect } from 'react';
import { getCurrentUser } from 'aws-amplify/auth';
import { Layout } from './components/ui/Layout';
import { LoginPage } from './components/auth/LoginPage';
import { QMSPage } from './pages/systems/QMSPage';
import { MESPage } from './pages/systems/MESPage';
import { PLMPage } from './pages/systems/PLMPage';
import { ERPPage } from './pages/systems/ERPPage';
import { SRMPage } from './pages/systems/SRMPage';
import { WMSPage } from './pages/systems/WMSPage';
import { DHRPage } from './pages/systems/DHRPage';
import { ProgramPage } from './pages/systems/ProgramPage';
import { InServicePage } from './pages/systems/InServicePage';
import { QualityDashboard } from './pages/dashboards/QualityDashboard';
import { ShopFloorDashboard } from './pages/dashboards/ShopFloorDashboard';
import { SupplyChainDashboard } from './pages/dashboards/SupplyChainDashboard';
import { ProgramDashboard } from './pages/dashboards/ProgramDashboard';
import { InServiceDashboard } from './pages/dashboards/InServiceDashboard';
import { DigitalThreadPage } from './pages/DigitalThreadPage';
import { DatalakePage } from './pages/DatalakePage';
import { AgentObservabilityPage } from './pages/AgentObservabilityPage';
import { DemoControlPage } from './pages/DemoControlPage';
import { InteractiveArchPage } from './pages/InteractiveArchPage';
import { FlowArchPage } from './pages/FlowArchPage';
import { EventProvider } from './context/EventProvider';

function useHashRoute() {
  const [route, setRoute] = useState(window.location.hash || '#/dashboard/quality');
  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}

function Router() {
  const route = useHashRoute();

  switch (route) {
    case '#/dashboard/quality':
      return <QualityDashboard />;
    case '#/dashboard/shop-floor':
      return <ShopFloorDashboard />;
    case '#/dashboard/supply-chain':
      return <SupplyChainDashboard />;
    case '#/dashboard/program':
      return <ProgramDashboard />;
    case '#/dashboard/in-service':
      return <InServiceDashboard />;
    case '#/digital-thread':
      return <DigitalThreadPage />;
    case '#/datalake':
      return <DatalakePage />;
    case '#/agent-observability':
      return <AgentObservabilityPage />;
    case '#/systems/qms':
      return <QMSPage />;
    case '#/systems/mes':
      return <MESPage />;
    case '#/systems/plm':
      return <PLMPage />;
    case '#/systems/erp':
      return <ERPPage />;
    case '#/systems/srm':
      return <SRMPage />;
    case '#/systems/wms':
      return <WMSPage />;
    case '#/systems/dhr':
      return <DHRPage />;
    case '#/systems/program':
      return <ProgramPage />;
    case '#/systems/inservice':
      return <InServicePage />;
    case '#/demo-control':
      return <DemoControlPage />;
    case '#/architecture':
      return <InteractiveArchPage />;
    case '#/flow':
      return <FlowArchPage />;
    case '#/architecture-static':
      return <iframe src="/architecture.html" className="w-full h-[calc(100vh-48px)] border-0" />;
    default:
      return <QualityDashboard />;
  }
}

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    getCurrentUser()
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-surface-app flex items-center justify-center">
        <div className="inline-block w-5 h-5 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onSignedIn={() => setAuthenticated(true)} />;
  }

  return (
    <EventProvider>
      <Layout>
        <Router />
      </Layout>
    </EventProvider>
  );
}
