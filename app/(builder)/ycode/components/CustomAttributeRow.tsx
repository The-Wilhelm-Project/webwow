'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';

interface CustomAttributeRowProps {
  name: string;
  value: string;
  onEdit: (oldName: string, newName: string, newValue: string) => void;
  onRemove: (name: string) => void;
}

/**
 * Renders a single custom attribute with an actions menu to edit or delete it.
 * Editing opens an inline popover prefilled with the attribute's name and value.
 */
export default function CustomAttributeRow({
  name,
  value,
  onEdit,
  onRemove,
}: CustomAttributeRowProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editValue, setEditValue] = useState('');

  const handleStartEdit = () => {
    setEditName(name);
    setEditValue(value);
    // Delay opening the popover until the dropdown has fully closed
    setTimeout(() => setEditOpen(true), 150);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value.replace(/\s+/g, '-'));
  };

  const handleSave = () => {
    if (!editName.trim()) return;
    onEdit(name, editName.trim(), editValue);
    setEditOpen(false);
  };

  return (
    <Popover
      open={editOpen}
      onOpenChange={(open) => {
        if (!open) {
          setEditOpen(false);
          setEditName('');
          setEditValue('');
        }
      }}
    >
      <PopoverAnchor asChild>
        <div className="flex items-center justify-between pl-3 pr-1 h-8 bg-muted text-muted-foreground rounded-lg">
          <span className="truncate">{name}=&quot;{value}&quot;</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="xs">
                <Icon name="more" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={handleStartEdit}>
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRemove(name)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-64"
        align="end"
        onFocusOutside={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-3">
            <Label variant="muted">Name</Label>
            <div className="col-span-2 *:w-full">
              <Input
                value={editName}
                onChange={handleNameChange}
                placeholder="e.g., data-id"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSave();
                  }
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-3">
            <Label>Value</Label>
            <div className="col-span-2 *:w-full">
              <Input
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                placeholder="e.g., 123"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSave();
                  }
                }}
              />
            </div>
          </div>

          <Button
            onClick={handleSave}
            disabled={!editName.trim()}
            size="sm"
            variant="secondary"
          >
            Save attribute
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
