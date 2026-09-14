export type UnpublishedChangeStatus = 'new' | 'modified' | 'deleted' | 'unpublishing';

export interface UnpublishedChange {
  id: string;
  name: string;
  status: UnpublishedChangeStatus;
}

export function displayChangeName(name: string | null | undefined): string {
  return name?.trim() || 'Untitled';
}

export function sortUnpublishedChanges(changes: UnpublishedChange[]): UnpublishedChange[] {
  return [...changes].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}
