'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectSeparator,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty';
import Icon from '@/components/ui/icon';
import { toast } from 'sonner';

import { useCollectionsStore } from '@/stores/useCollectionsStore';
import { isFieldTypeCompatible, getAirtableFieldTypeLabel } from '@/lib/apps/airtable/field-mapping';
import { formatRelativeTime } from '@/lib/utils';
import { getFieldIcon, getFieldTypeLabel } from '@/lib/collection-field-utils';
import { airtableApi } from '@/lib/apps/airtable/client';
import { ToastError } from '@/lib/toast-error';
import type {
  AirtableConnection,
  AirtableBase,
  AirtableTable,
  AirtableField,
  AirtableFieldMapping,
} from '@/lib/apps/airtable/types';
import type { CollectionField, CollectionFieldType } from '@/types';

// =============================================================================
// Types
// =============================================================================

interface AirtableSettingsProps {
  onDisconnect: () => void;
  onConnectionChange: (connected: boolean) => void;
  onCloseAndNavigate?: (path: string) => void;
}

interface NewConnectionForm {
  baseId: string;
  tableId: string;
  collectionId: string;
  fieldMapping: AirtableFieldMapping[];
}

const EMPTY_FORM: NewConnectionForm = {
  baseId: '',
  tableId: '',
  collectionId: '',
  fieldMapping: [],
};

const SYSTEM_FIELD_KEYS = new Set(['id', 'status']);

/** Build a mapping entry from an Airtable field + CMS field pair */
function buildMappingEntry(
  atField: AirtableField,
  cmsField: CollectionField
): AirtableFieldMapping {
  return {
    airtableFieldId: atField.id,
    airtableFieldName: atField.name,
    airtableFieldType: atField.type,
    cmsFieldId: cmsField.id,
    cmsFieldName: cmsField.name,
    cmsFieldType: cmsField.type,
  };
}

/** Update a mapping list: remove existing entry for the CMS field, optionally add a new one */
function updateMappingList(
  prev: AirtableFieldMapping[],
  cmsField: CollectionField,
  atField: AirtableField | undefined
): AirtableFieldMapping[] {
  const filtered = prev.filter((m) => m.cmsFieldId !== cmsField.id);
  if (!atField) return filtered;
  return [...filtered, buildMappingEntry(atField, cmsField)];
}

// =============================================================================
// Component
// =============================================================================

export default function AirtableSettings({
  onDisconnect,
  onConnectionChange,
  onCloseAndNavigate,
}: AirtableSettingsProps) {
  const router = useRouter();

  // Token state
  const [token, setToken] = useState('');
  const [savedToken, setSavedToken] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Airtable metadata
  const [bases, setBases] = useState<AirtableBase[]>([]);
  const [tables, setTables] = useState<AirtableTable[]>([]);
  const [tablesByBaseId, setTablesByBaseId] = useState<Record<string, AirtableTable[]>>({});
  const [isLoadingBases, setIsLoadingBases] = useState(false);
  const [isLoadingTables, setIsLoadingTables] = useState(false);

  // Connections
  const [connections, setConnections] = useState<AirtableConnection[]>([]);
  const [connectionToDelete, setConnectionToDelete] = useState<AirtableConnection | null>(null);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());

  // New connection form
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState<NewConnectionForm>(EMPTY_FORM);
  const [isSavingConnection, setIsSavingConnection] = useState(false);

  // Edit connection state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMapping, setEditMapping] = useState<AirtableFieldMapping[]>([]);
  const [fieldsByTableId, setFieldsByTableId] = useState<Record<string, AirtableField[]>>({});
  const [isLoadingEditFields, setIsLoadingEditFields] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  // Disconnect
  const [showDisconnect, setShowDisconnect] = useState(false);

  // Collections from store
  const collections = useCollectionsStore((s) => s.collections);
  const fields = useCollectionsStore((s) => s.fields);
  // =========================================================================
  // Load settings on mount
  // =========================================================================

  useEffect(() => {
    loadSettings();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const [settings, conns] = await Promise.all([
        airtableApi.getSettings(),
        airtableApi.getConnections(),
      ]);

      if (settings?.api_token) {
        setSavedToken(settings.api_token);
        setToken(settings.api_token);
        setIsConnected(true);
        onConnectionChange(true);
        loadBases();
      }

      setConnections(conns || []);

      if (settings?.api_token && conns.length > 0) {
        preloadConnectionFields(conns);
      }
    } catch {
      toast.error('Failed to load Airtable settings');
    } finally {
      setIsLoading(false);
    }
  };

  const preloadConnectionFields = async (conns: AirtableConnection[]) => {
    const baseIds = [...new Set(conns.map((c) => c.baseId))];
    const results = await Promise.allSettled(
      baseIds.map((baseId) => airtableApi.listTables(baseId))
    );

    const fieldsCache: Record<string, AirtableField[]> = {};
    const tablesCache: Record<string, AirtableTable[]> = {};
    baseIds.forEach((baseId, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        const loadedTables = result.value;
        tablesCache[baseId] = loadedTables;
        loadedTables.forEach((t) => { fieldsCache[t.id] = t.fields; });
      }
    });
    if (Object.keys(fieldsCache).length > 0) {
      setFieldsByTableId((prev) => ({ ...prev, ...fieldsCache }));
    }
    if (Object.keys(tablesCache).length > 0) {
      setTablesByBaseId((prev) => ({ ...prev, ...tablesCache }));
    }
  };

  // =========================================================================
  // Token management
  // =========================================================================

  const handleTestToken = async () => {
    setIsTesting(true);
    try {
      const result = await airtableApi.testToken(token);

      if (result?.valid) {
        toast.success('Connection successful', {
          description: 'Your token is valid and has the required permissions.',
        });
      } else {
        toast.error('Connection failed', {
          description: 'Check the token has the required scopes and hasn\'t expired.',
        });
      }
    } catch {
      toast.error('Connection failed', {
        description: 'Could not reach Airtable. Check your network connection.',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveToken = async () => {
    setIsSavingToken(true);
    try {
      await airtableApi.saveSettings({ api_token: token });
      setSavedToken(token);
      setIsConnected(true);
      onConnectionChange(true);
      loadBases();
    } catch {
      toast.error('Failed to save token');
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await airtableApi.deleteSettings();
      setToken('');
      setSavedToken('');
      setIsConnected(false);
      setConnections([]);
      setBases([]);
      setTables([]);
      onConnectionChange(false);
      onDisconnect();
    } catch {
      toast.error('Failed to disconnect');
    } finally {
      setShowDisconnect(false);
    }
  };

  // =========================================================================
  // Airtable metadata loading
  // =========================================================================

  const loadBases = useCallback(async () => {
    if (bases.length === 0) setIsLoadingBases(true);
    try {
      const data = await airtableApi.listBases();
      setBases(data || []);
    } catch {
      if (bases.length === 0) toast.error('Failed to load bases');
    } finally {
      setIsLoadingBases(false);
    }
  }, [bases.length]);

  /** Fetch tables for a base, caching fields for all tables in the base */
  const fetchAndCacheTables = useCallback(async (baseId: string): Promise<AirtableTable[]> => {
    const loadedTables = await airtableApi.listTables(baseId);

    setTablesByBaseId((prev) => ({ ...prev, [baseId]: loadedTables }));

    const newFieldsCache: Record<string, AirtableField[]> = {};
    loadedTables.forEach((t) => { newFieldsCache[t.id] = t.fields; });
    setFieldsByTableId((prev) => ({ ...prev, ...newFieldsCache }));

    return loadedTables;
  }, []);

  const loadTables = useCallback(async (baseId: string) => {
    const cached = tablesByBaseId[baseId];
    if (cached) setTables(cached);
    else setIsLoadingTables(true);

    try {
      const loadedTables = await fetchAndCacheTables(baseId);
      setTables(loadedTables);
    } catch {
      if (!cached) toast.error('Failed to load tables');
    } finally {
      setIsLoadingTables(false);
    }
  }, [tablesByBaseId, fetchAndCacheTables]);

  // =========================================================================
  // New connection form
  // =========================================================================

  const handleStartAddConnection = () => {
    setIsAdding(true);
    setForm(EMPTY_FORM);
    loadBases();
  };

  const handleCancelAdd = () => {
    setIsAdding(false);
    setForm(EMPTY_FORM);
  };

  const handleBaseChange = (baseId: string) => {
    setForm({ ...EMPTY_FORM, baseId });
    if (baseId) loadTables(baseId);
  };

  const handleTableChange = (tableId: string) => {
    const table = tables.find((t) => t.id === tableId);
    if (!table) return;

    setForm((prev) => ({
      ...prev,
      tableId,
      fieldMapping: [],
    }));
  };

  const handleCollectionChange = (collectionId: string) => {
    const selectedTable = tables.find((t) => t.id === form.tableId);
    const cmsFields = fields[collectionId] || [];

    // Auto-map fields by name match
    const autoMapping: AirtableFieldMapping[] = [];
    if (selectedTable) {
      for (const atField of selectedTable.fields) {
        const matchedCmsField = cmsFields.find(
          (f: CollectionField) =>
            f.name.toLowerCase() === atField.name.toLowerCase() &&
            isFieldTypeCompatible(atField.type, f.type)
        );
        if (matchedCmsField) {
          autoMapping.push(buildMappingEntry(atField, matchedCmsField));
        }
      }
    }

    setForm((prev) => ({
      ...prev,
      collectionId,
      fieldMapping: autoMapping,
    }));
  };

  const handleFieldMappingChange = (
    cmsField: CollectionField,
    airtableFieldId: string
  ) => {
    const atField = tables
      .find((t) => t.id === form.tableId)
      ?.fields.find((f) => f.id === airtableFieldId);

    setForm((prev) => ({
      ...prev,
      fieldMapping: updateMappingList(prev.fieldMapping, cmsField, atField),
    }));
  };

  const handleSaveConnection = async () => {
    if (!form.baseId || !form.tableId || !form.collectionId) return;

    setIsSavingConnection(true);
    try {
      const base = bases.find((b) => b.id === form.baseId);
      const table = tables.find((t) => t.id === form.tableId);
      const collection = collections.find((c) => c.id === form.collectionId);

      const newConn = await airtableApi.createConnection({
        baseId: form.baseId,
        baseName: base?.name,
        tableId: form.tableId,
        tableName: table?.name,
        collectionId: form.collectionId,
        collectionName: collection?.name,
        fieldMapping: form.fieldMapping,
      });

      setConnections((prev) => [...prev, newConn]);
      setIsAdding(false);
      setForm(EMPTY_FORM);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create connection');
    } finally {
      setIsSavingConnection(false);
    }
  };

  // =========================================================================
  // Connection actions
  // =========================================================================

  const refreshConnections = async () => {
    const conns = await airtableApi.getConnections();
    setConnections(conns);
    return conns;
  };

  const handleSync = async (connectionId: string) => {
    setSyncingIds((prev) => new Set(prev).add(connectionId));
    try {
      await airtableApi.sync(connectionId);
      const freshConns = await refreshConnections();
      const conn = freshConns.find((c) => c.id === connectionId);
      if (conn) {
        const store = useCollectionsStore.getState();
        const q = store.lastItemsQuery[conn.collectionId] || {};
        store.loadItems(conn.collectionId, q.page, q.limit, q.sortBy, q.sortOrder);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sync failed');
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(connectionId);
        return next;
      });
    }
  };

  const handleSetupWebhook = async (connectionId: string) => {
    try {
      await airtableApi.setupWebhook(connectionId);
      toast.success('Auto-sync successfully enabled');
      await refreshConnections();
    } catch (error) {
      if (error instanceof ToastError) {
        toast.error(error.title, { description: error.description });
      } else {
        toast.error(error instanceof Error ? error.message : 'Failed to enable auto-sync');
      }
    }
  };

  const handleDisableWebhook = async (connectionId: string) => {
    try {
      await airtableApi.disableWebhook(connectionId);
      toast.success('Auto-sync disabled');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to disable auto-sync');
    } finally {
      await refreshConnections();
    }
  };

  const handleDeleteConnection = async () => {
    if (!connectionToDelete) return;

    try {
      await airtableApi.deleteConnection(connectionToDelete.id);
      setConnections((prev) => prev.filter((c) => c.id !== connectionToDelete.id));
    } catch {
      toast.error('Failed to remove connection');
    } finally {
      setConnectionToDelete(null);
    }
  };

  // =========================================================================
  // Edit connection handlers
  // =========================================================================

  const handleStartEdit = async (connection: AirtableConnection) => {
    setEditMapping([...connection.fieldMapping]);
    setEditingId(connection.id);

    if (fieldsByTableId[connection.tableId]) return;

    setIsLoadingEditFields(true);
    try {
      await fetchAndCacheTables(connection.baseId);
    } catch {
      toast.error('Failed to load Airtable fields');
    } finally {
      setIsLoadingEditFields(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditMapping([]);
  };

  const getEditAirtableFields = (): AirtableField[] => {
    if (!editingId) return [];
    const conn = connections.find((c) => c.id === editingId);
    return conn ? (fieldsByTableId[conn.tableId] || []) : [];
  };

  const handleEditMappingChange = (cmsField: CollectionField, airtableFieldId: string) => {
    const atField = airtableFieldId
      ? getEditAirtableFields().find((f) => f.id === airtableFieldId)
      : undefined;
    setEditMapping((prev) => updateMappingList(prev, cmsField, atField));
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;

    try {
      setIsSavingEdit(true);
      await airtableApi.updateConnection(editingId, editMapping);

      setConnections((prev) =>
        prev.map((c) =>
          c.id === editingId ? { ...c, fieldMapping: editMapping } : c
        )
      );
      handleCancelEdit();
    } catch {
      toast.error('Failed to update field mapping');
    } finally {
      setIsSavingEdit(false);
    }
  };

  // =========================================================================
  // Render helpers
  // =========================================================================

  /** Filter CMS fields to only editable, non-system fields */
  const getEditableCmsFields = (collectionId: string): CollectionField[] => {
    return (fields[collectionId] || []).filter(
      (f: CollectionField) =>
        !f.hidden && !f.is_computed && f.fillable !== false && !SYSTEM_FIELD_KEYS.has(f.key ?? '')
    );
  };

  const selectedTable = tables.find((t) => t.id === form.tableId);
  const selectedCollectionFields = form.collectionId
    ? getEditableCmsFields(form.collectionId)
    : [];

  // =========================================================================
  // Render
  // =========================================================================

  if (isLoading) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Airtable</SheetTitle>
          <SheetDescription className="sr-only">Airtable integration settings</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      </>
    );
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="mr-auto">Airtable</SheetTitle>
        {isConnected && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => setShowDisconnect(true)}
          >
            Disconnect
          </Button>
        )}
        <SheetDescription className="sr-only">
          Airtable integration settings
        </SheetDescription>
      </SheetHeader>

      <div className="mt-3 space-y-8">
        {/* Token Section */}
        <div className="space-y-4">
          <FieldDescription className="flex flex-col gap-2">
            <span>
              Enter your Airtable Personal Access Token. Required scopes:{' '}
              <span className="text-foreground">data.records:read</span>,{' '}
              <span className="text-foreground">schema.bases:read</span>,{' '}
              <span className="text-foreground">webhook:manage</span>.
            </span>
            <span>
              Create a token in your{' '}
              <a
                href="https://airtable.com/create/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline"
              >
                Airtable developer dashboard
              </a>.
            </span>
          </FieldDescription>

          <Field>
            <FieldLabel htmlFor="airtable-token">Personal Access Token</FieldLabel>
            <Input
              id="airtable-token"
              type="password"
              placeholder="pat..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex gap-2 mt-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleTestToken}
                disabled={!token.trim() || isTesting}
              >
                {isTesting && <Spinner className="size-3" />}
                Test connection
              </Button>
              <Button
                size="sm"
                onClick={handleSaveToken}
                disabled={!token.trim() || token === savedToken || isSavingToken}
              >
                {isSavingToken && <Spinner className="size-3" />}
                Save
              </Button>
            </div>
          </Field>
        </div>

        {/* Connections Section */}
        {isConnected && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <FieldLabel>Connections</FieldLabel>
              <Button
                variant="secondary"
                size="xs"
                onClick={handleStartAddConnection}
                disabled={isAdding}
              >
                <Icon name="plus" className="mr-1" />
                Add
              </Button>
            </div>

            {/* Existing connections list */}
            {connections.length === 0 && !isAdding && (
              <Empty>
                <EmptyTitle>No connections</EmptyTitle>
                <EmptyDescription>
                  Add a new connection to start syncing Airtable data into Ycode collections.
                </EmptyDescription>
              </Empty>
            )}

            {connections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                isSyncing={syncingIds.has(conn.id)}
                isEditing={editingId === conn.id}
                editMapping={editingId === conn.id ? editMapping : []}
                airtableFields={editingId === conn.id ? (fieldsByTableId[conn.tableId] || []) : []}
                cmsFields={editingId === conn.id ? getEditableCmsFields(conn.collectionId) : []}
                isLoadingFields={editingId === conn.id && isLoadingEditFields}
                isSavingEdit={isSavingEdit}
                onSync={() => handleSync(conn.id)}
                onSetupWebhook={() => handleSetupWebhook(conn.id)}
                onDisableWebhook={() => handleDisableWebhook(conn.id)}
                onDelete={() => setConnectionToDelete(conn)}
                onGoToCollection={() => {
                  if (onCloseAndNavigate) {
                    onCloseAndNavigate(`/ycode/collections/${conn.collectionId}`);
                  } else {
                    router.push(`/ycode/collections/${conn.collectionId}`);
                  }
                }}
                onStartEdit={() => handleStartEdit(conn)}
                onCancelEdit={handleCancelEdit}
                onSaveEdit={handleSaveEdit}
                onEditMappingChange={handleEditMappingChange}
              />
            ))}

            {/* New connection form */}
            {isAdding && (
              <div className="border rounded-lg bg-secondary/30">
                <div className="flex items-center p-3">
                  <div className="flex-1 min-w-0 gap-px flex flex-col">
                    <span className="text-sm font-medium">New connection</span>
                    <span className="text-[10px] text-muted-foreground">
                      Select a base, table, and collection to sync.
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={handleCancelAdd}
                  >
                    <Icon name="x" />
                  </Button>
                </div>

                <div className="px-3 pb-3 space-y-3 border-t pt-3">
                  {/* Base / Table / Collection selectors */}
                  <div className="flex items-end gap-2">
                    <Field className="flex-1 min-w-0">
                      <FieldLabel>Airtable Base</FieldLabel>
                      <Select
                        value={form.baseId}
                        onValueChange={handleBaseChange}
                        disabled={isLoadingBases}
                      >
                        <SelectTrigger>
                          {isLoadingBases ? (
                            <span className="flex items-center gap-1.5">
                              <Spinner className="size-3" />
                              <span>Loading...</span>
                            </span>
                          ) : (
                            <SelectValue placeholder="Select a base" />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {bases.map((base) => (
                            <SelectItem
                              key={base.id}
                              value={base.id}
                            >
                              {base.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field className="flex-1 min-w-0">
                      <FieldLabel>Airtable Table</FieldLabel>
                      <Select
                        value={form.tableId}
                        onValueChange={handleTableChange}
                        disabled={!form.baseId || isLoadingTables}
                      >
                        <SelectTrigger>
                          {isLoadingTables ? (
                            <span className="flex items-center gap-1.5">
                              <Spinner className="size-3" />
                              <span>Loading...</span>
                            </span>
                          ) : (
                            <SelectValue placeholder="Select a table" />
                          )}
                        </SelectTrigger>
                        <SelectContent>
                          {tables.map((table) => (
                            <SelectItem
                              key={table.id}
                              value={table.id}
                            >
                              {table.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field className="flex-1 min-w-0">
                      <FieldLabel>Ycode Collection</FieldLabel>
                      <Select
                        value={form.collectionId}
                        onValueChange={handleCollectionChange}
                        disabled={!form.tableId}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a collection" />
                        </SelectTrigger>
                        <SelectContent>
                          {collections.map((c) => (
                            <SelectItem
                              key={c.id}
                              value={c.id}
                            >
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>

                  {/* Field mapping + actions */}
                  {form.collectionId && selectedTable && (
                    <>
                      <hr />
                      <FieldMappingGrid
                        cmsFields={selectedCollectionFields}
                        airtableFields={selectedTable.fields}
                        mapping={form.fieldMapping}
                        onMappingChange={handleFieldMappingChange}
                      />

                      <hr />
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          size="xs"
                          onClick={handleCancelAdd}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          onClick={handleSaveConnection}
                          disabled={
                            !form.baseId || !form.tableId || !form.collectionId ||
                            form.fieldMapping.length === 0 || isSavingConnection
                          }
                        >
                          {isSavingConnection && <Spinner className="size-3" />}
                          Create connection
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Disconnect dialog */}
      <ConfirmDialog
        open={showDisconnect}
        onOpenChange={setShowDisconnect}
        title="Disconnect Airtable?"
        description="This will remove your token and all sync connections. CMS data already synced will remain."
        confirmLabel="Disconnect"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDisconnect}
        onCancel={() => setShowDisconnect(false)}
      />

      {/* Delete connection dialog */}
      <ConfirmDialog
        open={!!connectionToDelete}
        onOpenChange={(open: boolean) => { if (!open) setConnectionToDelete(null); }}
        title="Delete connection?"
        description={`This will stop syncing "${connectionToDelete?.tableName}" → "${connectionToDelete?.collectionName}". Existing CMS data will remain.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        confirmVariant="destructive"
        onConfirm={handleDeleteConnection}
        onCancel={() => setConnectionToDelete(null)}
      />
    </>
  );
}

// =============================================================================
// Field Mapping Grid Sub-component
// =============================================================================

interface FieldMappingGridProps {
  cmsFields: CollectionField[];
  airtableFields: AirtableField[];
  mapping: AirtableFieldMapping[];
  isLoading?: boolean;
  onMappingChange: (cmsField: CollectionField, airtableFieldId: string) => void;
}

function FieldMappingGrid({
  cmsFields,
  airtableFields,
  mapping,
  isLoading = false,
  onMappingChange,
}: FieldMappingGridProps) {
  const mappingById = useMemo(
    () => new Map(mapping.map((m) => [m.cmsFieldId, m])),
    [mapping]
  );

  const compatibleFieldsMap = useMemo(() => {
    const seen = new Map<CollectionFieldType, AirtableField[]>();
    return (cmsType: CollectionFieldType) => {
      const cached = seen.get(cmsType);
      if (cached) return cached;
      const result = airtableFields.filter((atField) =>
        isFieldTypeCompatible(atField.type, cmsType)
      );
      seen.set(cmsType, result);
      return result;
    };
  }, [airtableFields]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium">Ycode fields</span>
        <span className="w-3" />
        <span className="flex-1 text-xs font-medium">Airtable fields</span>
      </div>

      {cmsFields.map((cmsField) => {
        const fieldMapping = mappingById.get(cmsField.id);
        const compatibleFields = compatibleFieldsMap(cmsField.type);

        return (
          <div
            key={cmsField.id}
            className="flex items-center gap-2"
          >
            <div className="flex-1 min-w-0">
              <Select value={cmsField.id}>
                <SelectTrigger className="w-full text-xs h-8 pointer-events-none [&_svg.opacity-50]:hidden">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={cmsField.id}>
                    <span className="flex items-center justify-between gap-2 w-full">
                      <span className="flex items-center gap-1.5 truncate">
                        <Icon
                          name={getFieldIcon(cmsField.type)}
                          className="size-2.5 shrink-0 text-muted-foreground"
                        />
                        <span className="truncate">{cmsField.name}</span>
                      </span>
                      <span className="text-muted-foreground text-[10px] shrink-0">{getFieldTypeLabel(cmsField.type)}</span>
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Icon
              name="chevronLeft"
              className="shrink-0 text-muted-foreground size-3"
            />
            <div className="flex-1">
              <Select
                value={isLoading ? '_loading' : (fieldMapping?.airtableFieldId || '_none')}
                onValueChange={(val) =>
                  onMappingChange(cmsField, val === '_none' ? '' : val)
                }
              >
                <SelectTrigger className="w-full text-xs h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {isLoading && (
                    <SelectItem disabled value="_loading">
                      <span className="text-muted-foreground">Loading fields...</span>
                    </SelectItem>
                  )}
                  <SelectItem value="_none">
                    <span className="flex items-center justify-between gap-2 w-full">
                      <span className="text-muted-foreground truncate">Do not sync this field</span>
                    </span>
                  </SelectItem>
                  <SelectSeparator />
                  {compatibleFields.map((atField) => (
                    <SelectItem
                      key={atField.id}
                      value={atField.id}
                    >
                      <span className="flex items-center justify-between gap-2 w-full">
                        <span className="truncate">{atField.name}</span>
                        <span className="text-muted-foreground text-[10px] shrink-0">{getAirtableFieldTypeLabel(atField.type)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// Connection Card Sub-component
// =============================================================================

interface ConnectionCardProps {
  connection: AirtableConnection;
  isSyncing: boolean;
  isEditing: boolean;
  editMapping: AirtableFieldMapping[];
  airtableFields: AirtableField[];
  cmsFields: CollectionField[];
  isLoadingFields: boolean;
  isSavingEdit: boolean;
  onSync: () => void;
  onSetupWebhook: () => void;
  onDisableWebhook: () => void;
  onDelete: () => void;
  onGoToCollection: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onEditMappingChange: (cmsField: CollectionField, airtableFieldId: string) => void;
}

function ConnectionCard({
  connection,
  isSyncing,
  isEditing,
  editMapping,
  airtableFields,
  cmsFields,
  isLoadingFields,
  isSavingEdit,
  onSync,
  onSetupWebhook,
  onDisableWebhook,
  onDelete,
  onGoToCollection,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditMappingChange,
}: ConnectionCardProps) {
  const statusBadge = () => {
    if (isSyncing || connection.syncStatus === 'syncing') {
      return <Badge variant="secondary" className="text-[10px]">Syncing...</Badge>;
    }
    if (connection.syncStatus === 'error') {
      return <Badge variant="destructive" className="text-[10px]">Errored</Badge>;
    }
    return connection.lastSyncedAt
      ? <Badge variant="secondary" className="text-[10px]">Synced {formatRelativeTime(connection.lastSyncedAt, false)}</Badge>
      : <Badge variant="secondary" className="text-[10px]">Never synced</Badge>;
  };

  const webhookLabel = connection.webhookId
    ? 'Auto-syncing with Webhook'
    : connection.webhookExpiredAt
      ? `Webhook expired ${formatRelativeTime(connection.webhookExpiredAt, false)}`
      : 'Manual sync';

  return (
    <div className="border rounded-lg bg-secondary/30">
      <div
        className="flex items-center p-3 cursor-pointer hover:bg-secondary/20 rounded-t-lg transition-colors"
        onClick={onStartEdit}
      >
        <div className="flex-1 min-w-0 gap-px flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium">
              [{connection.baseName}] {connection.tableName}
            </span>
            {statusBadge()}
          </div>
          <span className="text-[10px] text-muted-foreground">
            {connection.collectionName} · {connection.fieldMapping.length} {connection.fieldMapping.length === 1 ? 'field' : 'fields'} mapped · {webhookLabel}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <Icon name="dotsHorizontal" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem
              onClick={onSync}
              disabled={isSyncing}
            >
              {isSyncing ? 'Syncing...' : 'Sync now'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onGoToCollection}>
              Go to collection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onStartEdit}>
              Edit mapping
            </DropdownMenuItem>
            {connection.webhookId ? (
              <DropdownMenuItem onClick={onDisableWebhook}>
                Disable auto-sync
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={onSetupWebhook}>
                Enable auto-sync
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onDelete}
              className="text-destructive focus:text-destructive"
            >
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {connection.syncError && (
        <p className="text-xs text-destructive px-3 pb-3">
          Error: {connection.syncError}
        </p>
      )}

      {isEditing && (
        <div className="px-3 pb-3 space-y-3 border-t pt-3">
          <FieldMappingGrid
            cmsFields={cmsFields}
            airtableFields={airtableFields}
            mapping={editMapping}
            isLoading={isLoadingFields}
            onMappingChange={onEditMappingChange}
          />

          <hr />
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="xs"
              onClick={onCancelEdit}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              onClick={onSaveEdit}
              disabled={isSavingEdit}
            >
              {isSavingEdit && <Spinner className="size-3" />}
              Save changes
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
