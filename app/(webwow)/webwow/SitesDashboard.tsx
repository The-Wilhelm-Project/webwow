'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/useAuthStore';
import { extractRoleFromUser, resolveRole } from '@/lib/roles';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { BrandMark } from './components/BrandMark';
import { DeleteSiteDialog } from './components/DeleteSiteDialog';
import { LoginForm } from './components/LoginForm';
import { NewSiteDialog } from './components/NewSiteDialog';
import { SiteCard } from './components/SiteCard';
import { SiteSettingsDialog } from './components/SiteSettingsDialog';
import {
  SITE_NAME_MAX_LENGTH,
  downloadBlob,
  errorMessage,
  initialsOf,
  isSitesApiError,
  sitesApi,
  slugProblem,
  slugifyClient,
  type SiteJson,
  type SitesListResult,
} from './components/sites-api';

/** Sort: most recently opened/updated first. */
function sortSites(sites: SiteJson[]): SiteJson[] {
  const stamp = (s: SiteJson) => Math.max(Date.parse(s.last_opened_at ?? '') || 0, Date.parse(s.updated_at) || 0);
  return [...sites].sort((a, b) => stamp(b) - stamp(a) || a.name.localeCompare(b.name));
}

function matchesQuery(site: SiteJson, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return site.name.toLowerCase().includes(q) || site.slug.includes(q) || site.domains.some((d) => d.includes(q));
}

function FullScreen({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-white/70 p-6">{children}</div>;
}

/**
 * `/webwow` — Webflow-like "All sites" dashboard (client-gated; the API routes are
 * session-gated by the proxy and role-checked in `_shared.ts`).
 */
export default function SitesDashboard() {
  const user = useAuthStore((s) => s.user);
  const initialized = useAuthStore((s) => s.initialized);

  useEffect(() => {
    void useAuthStore.getState().initialize();
  }, []);

  if (!initialized) {
    return (
      <FullScreen>
        <Spinner className="size-5" />
      </FullScreen>
    );
  }

  if (!user) {
    return <LoginForm />;
  }

  if (user.app_metadata?.webwow_editor_site) {
    return <EditorNotice />;
  }

  return <Dashboard />;
}

function EditorNotice() {
  const signOut = async () => {
    await useAuthStore.getState().signOut();
    window.location.reload();
  };
  return (
    <FullScreen>
      <div className="max-w-sm text-center flex flex-col items-center gap-4">
        <BrandMark className="size-7 text-white" />
        <h1 className="text-base font-medium text-white">You are signed in as a site editor</h1>
        <p className="text-xs text-white/60">
          Editor sessions can change the content of one site only. The sites dashboard needs a regular Webwow account.
        </p>
        <div className="flex gap-2">
          <Button
            asChild
            size="sm"
          >
            <Link href="/ycode/collections">Open the CMS</Link>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={signOut}
          >
            Sign out
          </Button>
        </div>
      </div>
    </FullScreen>
  );
}

function Dashboard() {
  const user = useAuthStore((s) => s.user);
  const role = resolveRole(extractRoleFromUser(user));
  const canAdmin = role === 'owner' || role === 'admin';
  const isOwner = role === 'owner';

  const [data, setData] = useState<SitesListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<{ id: string; label: string } | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [settingsSite, setSettingsSite] = useState<SiteJson | null>(null);
  const [deleteSite, setDeleteSite] = useState<SiteJson | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<SiteJson | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await sitesApi.list();
      setData(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(err);
      if (isSitesApiError(err) && err.status === 401) {
        // session vanished (cookie expired): back to the login form
        useAuthStore.setState({ user: null, session: null, role: null });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sites = useMemo(() => sortSites(data?.sites ?? []), [data]);
  const visible = useMemo(() => sites.filter((s) => matchesQuery(s, query)), [sites, query]);

  const replaceSite = (updated: SiteJson) => {
    setData((prev) => (prev ? { ...prev, sites: prev.sites.map((s) => (s.id === updated.id ? updated : s)) } : prev));
  };

  const runBusy = async (site: SiteJson, label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy({ id: site.id, label });
    try {
      await fn();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openSite = (site: SiteJson) => runBusy(site, 'Opening…', async () => {
    const { redirect } = await sitesApi.open(site.id);
    window.location.assign(redirect || '/ycode');
  });

  const viewSite = (site: SiteJson) => {
    window.open(site.publishedUrl, '_blank', 'noopener,noreferrer');
  };

  const exportSite = (site: SiteJson) => runBusy(site, 'Exporting…', async () => {
    const { blob, filename } = await sitesApi.exportFile(site.id);
    downloadBlob(blob, filename);
    toast.success(`Export of "${site.name}" downloaded`);
  });

  const signOut = async () => {
    await useAuthStore.getState().signOut();
    window.location.reload();
  };

  const registryMissing = isSitesApiError(loadError) && loadError.code === 'registry_missing';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-14 flex items-center gap-3">
          <Link
            href="/webwow"
            className="flex items-center gap-2 shrink-0 text-foreground"
          >
            <BrandMark className="size-5" />
            <span className="text-sm font-medium">Sites</span>
          </Link>

          <div className="relative flex-1 max-w-md ml-2 sm:ml-6">
            <Icon
              name="search"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3 text-muted-foreground pointer-events-none"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sites"
              className="pl-7"
              disableKeyboardStep
              aria-label="Search sites"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {canAdmin && (
              <Button
                size="sm"
                onClick={() => setNewOpen(true)}
                disabled={registryMissing}
              >
                <Icon name="plus" />
                New site
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="size-8 rounded-full bg-secondary text-foreground/80 text-[11px] font-medium inline-flex items-center justify-center hover:bg-secondary/70 cursor-pointer"
                  aria-label="Account menu"
                >
                  {initialsOf(user?.email?.split('@')[0] ?? 'me')}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[14rem]"
              >
                <DropdownMenuLabel className="flex flex-col gap-1">
                  <span className="truncate font-normal">{user?.email}</span>
                  <Badge
                    variant="secondary"
                    className="w-fit capitalize"
                  >
                    {role}
                  </Badge>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/ycode">
                    <Icon name="layers" />
                    Open builder
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={signOut}>
                  <Icon name="arrow-right" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6 py-8">
        <div className="flex items-baseline justify-between gap-4 mb-5">
          <h1 className="text-base font-medium">All sites</h1>
          {data && (
            <span className="text-muted-foreground">
              {visible.length === sites.length ? `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}` : `${visible.length} of ${sites.length} sites`}
              {data.multiSite ? '' : ' · single-site mode'}
            </span>
          )}
        </div>

        {registryMissing && (
          <Alert
            variant="warning"
            className="mb-5"
          >
            <AlertTitle>Multi-site registry missing</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(loadError)}</p>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => void load()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {!!loadError && !registryMissing && (
          <Alert
            variant="destructive"
            className="mb-5"
          >
            <AlertTitle>Could not load the sites</AlertTitle>
            <AlertDescription>
              <p>{errorMessage(loadError)}</p>
              <Button
                variant="secondary"
                size="xs"
                onClick={() => void load()}
              >
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {loading && !data ? (
          <div className="py-24 flex justify-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : data && visible.length === 0 ? (
          <div className="py-24 flex flex-col items-center gap-3 text-center">
            <Icon
              name="globe"
              className="size-6 text-muted-foreground"
            />
            <div className="font-medium">{sites.length === 0 ? 'No sites yet' : 'No sites match your search'}</div>
            <p className="text-muted-foreground max-w-xs">
              {sites.length === 0
                ? 'Create your first site to get started.'
                : 'Try a different name, slug or domain.'}
            </p>
            {sites.length === 0 && canAdmin && (
              <Button
                size="sm"
                onClick={() => setNewOpen(true)}
              >
                <Icon name="plus" />
                New site
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {visible.map((site) => (
              <SiteCard
                key={site.id}
                site={site}
                isCurrent={data?.currentSiteId === site.id}
                canAdmin={canAdmin}
                isOwner={isOwner}
                busy={busy?.id === site.id ? busy.label : null}
                onOpen={openSite}
                onView={viewSite}
                onDuplicate={setDuplicateSource}
                onExport={exportSite}
                onSettings={setSettingsSite}
                onDelete={setDeleteSite}
              />
            ))}
          </div>
        )}
      </main>

      <NewSiteDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={() => void load()}
      />

      <SiteSettingsDialog
        site={settingsSite}
        open={!!settingsSite}
        onOpenChange={(open) => {
          if (!open) setSettingsSite(null);
        }}
        onSaved={(updated) => {
          replaceSite(updated);
          setSettingsSite((current) => (current && current.id === updated.id ? updated : current));
        }}
      />

      <DeleteSiteDialog
        site={deleteSite}
        open={!!deleteSite}
        onOpenChange={(open) => {
          if (!open) setDeleteSite(null);
        }}
        onDeleted={() => {
          setDeleteSite(null);
          void load();
        }}
      />

      <DuplicateSiteDialog
        source={duplicateSource}
        open={!!duplicateSource}
        onOpenChange={(open) => {
          if (!open) setDuplicateSource(null);
        }}
        onDuplicated={() => {
          setDuplicateSource(null);
          void load();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Duplicate (owner only)
// ---------------------------------------------------------------------------

interface DuplicateSiteDialogProps {
  source: SiteJson | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDuplicated: (site: SiteJson) => void;
}

function DuplicateSiteDialog({ source, open, onOpenChange, onDuplicated }: DuplicateSiteDialogProps) {
  return (
    <Dialog
      open={open && !!source}
      onOpenChange={onOpenChange}
    >
      {open && source && (
        <DuplicateForm
          key={source.id}
          source={source}
          onOpenChange={onOpenChange}
          onDuplicated={onDuplicated}
        />
      )}
    </Dialog>
  );
}

function DuplicateForm({ source, onOpenChange, onDuplicated }: { source: SiteJson } & Omit<DuplicateSiteDialogProps, 'source' | 'open'>) {
  const [name, setName] = useState(`${source.name} copy`);
  const [confirmed, setConfirmed] = useState(!source.is_default);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slug = slugifyClient(name);
  const slugError = name.trim() ? slugProblem(slug) : null;
  const canSubmit = !busy && name.trim().length > 0 && name.trim().length <= SITE_NAME_MAX_LENGTH && !slugError && confirmed;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const site = await sitesApi.duplicate(source.id, { name: name.trim(), slug, confirmMainCopy: source.is_default ? confirmed : undefined });
      toast.success(`Site "${site.name}" created as a copy of "${source.name}"`);
      onDuplicated(site);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err, 'Could not duplicate the site'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      showCloseButton={!busy}
      onInteractOutside={(e) => {
        if (busy) e.preventDefault();
      }}
    >
      <form
        onSubmit={submit}
        className="flex flex-col gap-6"
      >
        <DialogHeader>
          <DialogTitle>Duplicate &quot;{source.name}&quot;</DialogTitle>
          <DialogDescription>
            Copies the database and the uploaded files into a new site. API keys, integrations, users, form submissions and
            version history are not copied.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not duplicate</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Field>
          <Label htmlFor="duplicate-site-name">Name of the copy</Label>
          <Input
            id="duplicate-site-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            disabled={busy}
            aria-invalid={!!slugError}
            required
          />
          <p className={slugError ? 'text-destructive' : 'text-muted-foreground'}>{slugError ?? `Slug ${slug}`}</p>
        </Field>

        {source.is_default && (
          <Alert variant="warning">
            <AlertTitle>Brief interruption for all sites</AlertTitle>
            <AlertDescription>
              <p>
                Copying the default site closes its database connections for a moment; requests on every site may fail while the
                copy runs (usually a few seconds).
              </p>
              <label className="flex items-center gap-2 cursor-pointer text-foreground">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmed(v === true)}
                  disabled={busy}
                />
                I understand, continue
              </label>
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
          >
            {busy ? (<><Spinner className="size-3" /> Duplicating…</>) : 'Duplicate site'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
