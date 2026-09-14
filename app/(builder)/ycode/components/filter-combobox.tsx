'use client';

import React, { useCallback, useId, useRef, useState } from 'react';

import { buttonVariants } from '@/components/ui/button';
import Icon from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { Spinner } from '@/components/ui/spinner';

import { cn } from '@/lib/utils';

export interface FilterComboboxRenderProps {
  search: string;
  hasQuery: boolean;
  close: () => void;
}

export interface FilterComboboxProps {
  displayValue: string;
  placeholder?: string;
  searchPlaceholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  isLoading?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
  popoverClassName?: string;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onOpen?: () => void;
  onEnter?: (search: string) => void;
  onSearchChange?: (search: string) => void;
  children: (ctx: FilterComboboxRenderProps) => React.ReactNode;
}

function placeCaretAtEnd(input: HTMLInputElement | null) {
  if (!input) return;
  const length = input.value.length;
  input.setSelectionRange(length, length);
}

/**
 * Combobox whose trigger is the filter field. Typing filters the popover
 * list; opening places a caret at the end of the current value.
 */
export function FilterCombobox({
  displayValue,
  placeholder = 'Select...',
  searchPlaceholder = 'Search...',
  ariaLabel,
  disabled = false,
  isLoading = false,
  className,
  align = 'end',
  popoverClassName,
  leading,
  trailing,
  onOpen,
  onEnter,
  onSearchChange,
  children,
}: FilterComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const hasQuery = search.trim().length > 0;

  const updateSearch = useCallback((next: string) => {
    setSearch(next);
    onSearchChange?.(next);
  }, [onSearchChange]);

  const openDropdown = useCallback(() => {
    setIsOpen(true);
    onOpen?.();
  }, [onOpen]);

  const closeDropdown = useCallback((options?: { blur?: boolean }) => {
    setIsOpen(false);
    setIsEditing(false);
    updateSearch('');
    if (options?.blur) inputRef.current?.blur();
  }, [updateSearch]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (open) {
      openDropdown();
      return;
    }
    closeDropdown();
  }, [openDropdown, closeDropdown]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setIsEditing(true);
    updateSearch(e.target.value);
    if (!isOpen) openDropdown();
  }, [isOpen, openDropdown, updateSearch]);

  const handleInputFocus = useCallback(() => {
    if (disabled) return;
    if (!isOpen) {
      openDropdown();
      requestAnimationFrame(() => placeCaretAtEnd(inputRef.current));
    }
  }, [disabled, isOpen, openDropdown]);

  const handleInputClick = useCallback(() => {
    if (disabled || isOpen) return;
    openDropdown();
    requestAnimationFrame(() => placeCaretAtEnd(inputRef.current));
  }, [disabled, isOpen, openDropdown]);

  const handleChevronMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    if (isOpen) {
      closeDropdown({ blur: true });
      return;
    }
    openDropdown();
    inputRef.current?.focus();
    requestAnimationFrame(() => placeCaretAtEnd(inputRef.current));
  }, [disabled, isOpen, openDropdown, closeDropdown]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && !isOpen) {
      e.preventDefault();
      openDropdown();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (hasQuery) {
        onEnter?.(search);
        closeDropdown({ blur: true });
      }
      return;
    }
    if (e.key !== 'Escape') {
      e.stopPropagation();
    }
  }, [isOpen, hasQuery, search, onEnter, openDropdown, closeDropdown]);

  const inputValue = isEditing ? search : displayValue;

  return (
    <Popover
      open={isOpen}
      onOpenChange={handleOpenChange}
      modal={false}
    >
      <PopoverAnchor asChild>
        <div
          ref={triggerRef}
          className={cn(
            buttonVariants({ variant: 'input', size: 'sm' }),
            'w-full justify-between',
            (displayValue || isEditing) && 'text-foreground',
            disabled && 'pointer-events-none opacity-50',
            className
          )}
          onMouseDown={(e) => {
            if (disabled) return;
            if (e.target === inputRef.current) return;
            if ((e.target as HTMLElement).closest('button')) return;
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          {leading}
          <Input
            ref={inputRef}
            size="xs"
            disableKeyboardStep
            disabled={disabled}
            value={inputValue}
            placeholder={isEditing ? searchPlaceholder : placeholder}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded={isOpen}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-label={ariaLabel}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            onClick={handleInputClick}
            onKeyDown={handleKeyDown}
            className="h-auto w-auto! min-w-0 flex-1 border-0 bg-transparent p-0 shadow-none rounded-none focus-visible:border-transparent focus-visible:ring-0"
          />
          {!isEditing && trailing}
          {isLoading && <Spinner className="size-3.5 shrink-0" />}
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={isOpen ? 'Close list' : 'Open list'}
            onMouseDown={handleChevronMouseDown}
            className="shrink-0 inline-flex items-center justify-center"
          >
            <Icon name="chevronDown" className="size-2.5! shrink-0 opacity-50" />
          </button>
        </div>
      </PopoverAnchor>

      <PopoverContent
        id={listboxId}
        role="listbox"
        className={cn('w-auto min-w-56 max-w-96 p-1', popoverClassName)}
        align={align}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (triggerRef.current?.contains(e.target as Node)) {
            e.preventDefault();
          }
        }}
      >
        <div className="max-h-100 overflow-y-auto">
          {children({ search, hasQuery, close: () => closeDropdown({ blur: true }) })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
