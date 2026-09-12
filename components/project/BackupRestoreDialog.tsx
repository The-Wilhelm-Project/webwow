'use client';

import React, { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { toast } from 'sonner';
import { ToastError } from '@/lib/toast-error';
import { parseErrorResponse } from '@/lib/utils';

interface BackupRestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BackupRestoreDialog({
  open,
  onOpenChange,
}: BackupRestoreDialogProps) {
  const [activeTab, setActiveTab] = useState<'backup' | 'restore'>('backup');
  const [loading, setLoading] = useState(false);

  const [backupName, setBackupName] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [restorePassword, setRestorePassword] = useState('');
  const [showRestorePassword, setShowRestorePassword] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showError = (err: unknown, fallbackTitle: string) => {
    if (err instanceof ToastError) {
      toast.error(err.title, { description: err.description });
    } else {
      const message = err instanceof Error ? err.message : undefined;
      toast.error(fallbackTitle, message ? { description: message } : undefined);
    }
  };

  const resetState = () => {
    setBackupName('');
    setBackupPassword('');
    setShowBackupPassword(false);
    setRestorePassword('');
    setShowRestorePassword(false);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    if (loading) return;
    resetState();
    onOpenChange(false);
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab as 'backup' | 'restore');
  };

  const handleBackup = async () => {
    setLoading(true);

    try {
      const response = await fetch('/ycode/api/project/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(backupName && { projectName: backupName }),
          ...(backupPassword && { password: backupPassword }),
        }),
      });

      if (!response.ok) {
        // The error body may be JSON (from our route) or plain text/HTML
        // (from an upstream proxy, e.g. a "Bad Gateway" on timeout).
        const message = await parseErrorResponse(response);
        throw new Error(message);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      const filename = filenameMatch?.[1] || 'backup.ycode';

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('The project backup was successfully created.');
      handleClose();
    } catch (err) {
      showError(err, 'Backup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedFile) {
      toast.error('No backup file selected', { description: 'Please select a .ycode backup file' });
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      if (restorePassword) {
        formData.append('password', restorePassword);
      }

      const response = await fetch('/ycode/api/project/import', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        const title = data.errorTitle || 'Restore failed';
        const description = data.error || 'An unknown error occurred';
        toast.error(title, { description });
        return;
      }

      toast.success('Project successfully restored', { description: 'The builder will now reload' });
      handleClose();
      setTimeout(() => { window.location.href = '/ycode'; }, 500);
    } catch (err) {
      showError(err, 'Restore failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={loading ? undefined : handleClose}>
      <DialogContent
        showCloseButton={!loading}
        className="sm:max-w-md"
        onPointerDownOutside={loading ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={loading ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader>
          <DialogTitle>Backup &amp; Restore</DialogTitle>
          <DialogDescription>
            Backup your project or restore it from a previous backup
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
        >
          <TabsList className="w-full">
            <TabsTrigger
              value="backup"
              className="flex-1"
              disabled={loading}
            >
              Backup
            </TabsTrigger>
            <TabsTrigger
              value="restore"
              className="flex-1"
              disabled={loading}
            >
              Restore
            </TabsTrigger>
          </TabsList>

          <TabsContent value="backup">
            <div className="flex flex-col gap-4 pt-2">
              <p className="text-xs text-muted-foreground">
                This will create a <code className="text-foreground/85">.ycode</code> backup file containing all of your project data. The file can be used to restore
                your project data at a later date or to transfer your project to another instance of YCode.
              </p>
              <div className="space-y-2">
                <Label htmlFor="backup-name">
                  Backup name <span className="text-muted-foreground">Optional, used to name the backup file</span>
                </Label>
                <Input
                  id="backup-name"
                  placeholder="ycode-app"
                  value={backupName}
                  onChange={(e) => {
                    const sanitized = e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, '-')
                      .replace(/-{2,}/g, '-')
                      .replace(/^-/, '');
                    setBackupName(sanitized);
                  }}
                  disabled={loading}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="backup-password">
                  Password <span className="text-muted-foreground">Optional, used to encrypt the backup file</span>
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    id="backup-password"
                    type={showBackupPassword ? 'text' : 'password'}
                    placeholder="No password"
                    value={backupPassword}
                    onChange={(e) => setBackupPassword(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-18"
                    onClick={() => setShowBackupPassword(!showBackupPassword)}
                  >
                    {showBackupPassword ? 'Hide' : 'Show'}
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="restore">
            <div className="flex flex-col gap-4 pt-2">
              <p className="text-xs text-muted-foreground">
                Upload a <code className="text-foreground/85">.ycode</code> backup file to restore a project. Warning: This will delete all the current project data
                and replace it with the backup data, make sure you have a recent backup before attempting to restore!
              </p>
              <div className="space-y-2">
                <Label>Backup file</Label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".ycode"
                  className="hidden"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                  >
                    Choose file
                  </Button>
                  <span className="text-xs text-muted-foreground truncate">
                    {selectedFile ? selectedFile.name : 'No file selected'}
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="restore-password">
                  Password <span className="text-muted-foreground">Needed if the backup was password encrypted</span>
                </Label>
                <div className="flex gap-1.5">
                  <Input
                    id="restore-password"
                    type={showRestorePassword ? 'text' : 'password'}
                    placeholder="No password"
                    value={restorePassword}
                    onChange={(e) => setRestorePassword(e.target.value)}
                    disabled={loading}
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-18"
                    onClick={() => setShowRestorePassword(!showRestorePassword)}
                  >
                    {showRestorePassword ? 'Hide' : 'Show'}
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="secondary"
            onClick={handleClose}
            disabled={loading}
          >
            Cancel
          </Button>
          {activeTab === 'backup' ? (
            <Button onClick={handleBackup} disabled={loading}>
              {loading && <Spinner />}
              {loading ? 'Creating backup...' : 'Create backup'}
            </Button>
          ) : (
            <Button
              onClick={handleRestore}
              disabled={loading || !selectedFile}
            >
              {loading && <Spinner />}
              {loading ? 'Restoring project...' : 'Restore project'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
