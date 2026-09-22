import SitesDashboard from './SitesDashboard';

export const dynamic = 'force-dynamic';

/**
 * /webwow — sites dashboard (multi-site). Everything is client-rendered and
 * session-gated by the sites API; this server component only mounts the client tree.
 */
export default function WebwowSitesPage() {
  return <SitesDashboard />;
}
