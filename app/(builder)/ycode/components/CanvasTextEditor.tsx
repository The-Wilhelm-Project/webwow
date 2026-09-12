'use client';

/**
 * Canvas Text Editor
 *
 * Tiptap-based inline text editor for the canvas that preserves layer styling.
 * Renders with the same classes/textStyles as LayerRenderer for WYSIWYG editing.
 *
 * The formatting toolbar is rendered in CenterCanvas (outside iframe) and
 * communicates with this editor via useCanvasTextEditorStore.
 */

import React, { useEffect, useMemo, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { Mark, mergeAttributes } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Text from '@tiptap/extension-text';
import Paragraph from '@tiptap/extension-paragraph';
import History from '@tiptap/extension-history';
import { EditorState } from '@tiptap/pm/state';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import Underline from '@tiptap/extension-underline';
import Strike from '@tiptap/extension-strike';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Heading from '@tiptap/extension-heading';
import Blockquote from '@tiptap/extension-blockquote';
import Code from '@tiptap/extension-code';
import { RichTextImage } from '@/lib/tiptap-extensions/rich-text-image';
import { getTextStyleClasses } from '@/lib/text-format-utils';
import type { Layer, TextStyle, CollectionField, Collection } from '@/types';
import type { FieldVariable } from '@/types';
import {
  parseValueToContent,
  getVariableLabel,
} from '@/lib/cms-variables-utils';
import { createDynamicVariableNodeView } from '@/lib/dynamic-variable-view';
import { RichTextComponent } from '@/lib/tiptap-extensions/rich-text-component';
import { useCanvasTextEditorStore } from '@/stores/useCanvasTextEditorStore';
import { RichTextLink } from '@/lib/tiptap-extensions/rich-text-link';
import { useEditorStore } from '@/stores/useEditorStore';
import { cn } from '@/lib/utils';

interface CanvasTextEditorProps {
  /** The layer being edited */
  layer: Layer;
  /** Current value (Tiptap JSON or string) */
  value: any;
  /** Called when content changes */
  onChange: (value: any) => void;
  /** Called when editing is complete (blur/escape) */
  onFinish?: () => void;
  /** Collection fields for variable insertion */
  fields?: CollectionField[];
  /** All fields keyed by collection ID for nested references */
  allFields?: Record<string, CollectionField[]>;
  /** All collections for reference field lookups */
  collections?: Collection[];
  /** Collection item data for variable resolution */
  collectionItemData?: Record<string, string>;
  /** Click coordinates for initial cursor position */
  clickCoords?: { x: number; y: number } | null;
}

export interface CanvasTextEditorHandle {
  focus: () => void;
  addFieldVariable: (variableData: FieldVariable) => void;
}

/**
 * DynamicVariable with React node view for the canvas text editor.
 * Extends the shared extension with canvas-specific Badge styling.
 */
const DynamicVariableWithNodeView = createDynamicVariableNodeView('canvas');

/**
 * All block/mark extensions use a ref so renderHTML always reads the latest textStyles.
 * This avoids stale closures when textStyles change while the Tiptap editor is mounted.
 */
type TextStylesRef = React.MutableRefObject<Record<string, TextStyle> | undefined>;

function createBoldExtension(ref: TextStylesRef) {
  return Bold.extend({
    renderHTML({ HTMLAttributes }) {
      return ['strong', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'bold') }), 0];
    },
  });
}

function createItalicExtension(ref: TextStylesRef) {
  return Italic.extend({
    renderHTML({ HTMLAttributes }) {
      return ['em', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'italic') }), 0];
    },
  });
}

function createUnderlineExtension(ref: TextStylesRef) {
  return Underline.extend({
    renderHTML({ HTMLAttributes }) {
      return ['u', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'underline') }), 0];
    },
  });
}

function createStrikeExtension(ref: TextStylesRef) {
  return Strike.extend({
    renderHTML({ HTMLAttributes }) {
      return ['s', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'strike') }), 0];
    },
  });
}

function createSubscriptExtension(ref: TextStylesRef) {
  return Subscript.extend({
    renderHTML({ HTMLAttributes }) {
      return ['sub', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'subscript') }), 0];
    },
  });
}

function createSuperscriptExtension(ref: TextStylesRef) {
  return Superscript.extend({
    renderHTML({ HTMLAttributes }) {
      return ['sup', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'superscript') }), 0];
    },
  });
}

function createBlockquoteExtension(ref: TextStylesRef) {
  return Blockquote.extend({
    renderHTML({ HTMLAttributes }) {
      return ['blockquote', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'blockquote') }), 0];
    },
  });
}

function createParagraphExtension(ref: TextStylesRef) {
  return Paragraph.extend({
    renderHTML({ HTMLAttributes }) {
      return ['p', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'paragraph') }), 0];
    },
  });
}

function createHeadingExtension(ref: TextStylesRef) {
  return Heading.extend({
    renderHTML({ node, HTMLAttributes }) {
      const level = node.attrs.level as 1 | 2 | 3 | 4 | 5 | 6;
      const styleKey = `h${level}` as const;

      return [`h${level}`, mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, styleKey) }), 0];
    },
  }).configure({
    levels: [1, 2, 3, 4, 5, 6],
  });
}

function createRichTextLinkExtension(ref: TextStylesRef) {
  return RichTextLink.extend({
    addOptions() {
      return {
        ...this.parent?.(),
        HTMLAttributes: {},
      };
    },
    renderHTML({ HTMLAttributes }) {
      return ['a', mergeAttributes(HTMLAttributes, { class: getTextStyleClasses(ref.current, 'link') }), 0];
    },
  });
}

/**
 * Create dynamic style Mark extension for applying arbitrary styles to selected text
 * Stores an array of styleKeys to support stacking multiple styles on the same text
 * Classes from all styleKeys are combined at render time
 */
function createDynamicStyleExtension(textStylesRef: React.MutableRefObject<Record<string, TextStyle> | undefined>) {
  return Mark.create({
    name: 'dynamicStyle',

    addAttributes() {
      return {
        styleKeys: {
          default: [],
          parseHTML: (element) => {
            const attr = element.getAttribute('data-style-keys');
            if (!attr) {
              // Backwards compatibility: single styleKey
              const singleKey = element.getAttribute('data-style-key');
              return singleKey ? [singleKey] : [];
            }
            try {
              return JSON.parse(attr);
            } catch {
              return [];
            }
          },
          renderHTML: (attributes) => {
            const keys = attributes.styleKeys || [];
            if (keys.length === 0) return {};
            return { 'data-style-keys': JSON.stringify(keys) };
          },
        },
      };
    },

    parseHTML() {
      return [
        { tag: 'span[data-style-keys]' },
        { tag: 'span[data-style-key]' }, // Backwards compatibility
      ];
    },

    renderHTML({ HTMLAttributes, mark }) {
      const styleKeys: string[] = mark.attrs.styleKeys || [];
      const styles = textStylesRef.current || {};

      // Combine classes from all styleKeys using cn() for intelligent merging
      // Later styles override earlier ones for conflicting properties (e.g., colors)
      const classesArray = styleKeys
        .map(key => styles[key]?.classes || '')
        .filter(Boolean);
      const combinedClasses = cn(...classesArray);

      // Store the last styleKey as data-style-key for click detection
      const lastKey = styleKeys[styleKeys.length - 1] || null;

      return ['span', mergeAttributes(HTMLAttributes, {
        'data-style-keys': JSON.stringify(styleKeys),
        'data-style-key': lastKey, // For click detection
        class: combinedClasses,
      }), 0];
    },
  });
}

const CanvasTextEditor = forwardRef<CanvasTextEditorHandle, CanvasTextEditorProps>(({
  layer,
  value,
  onChange,
  onFinish,
  fields,
  allFields,
  clickCoords,
}, ref) => {
  const textStyles = layer.textStyles;
  const editorRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  // Store cursor position to restore after focus loss
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
  // Store click coordinates on mount (they shouldn't change during editing)
  const clickCoordsRef = useRef(clickCoords);
  // Mutable ref for textStyles that gets updated for real-time style changes
  const textStylesRef = useRef(textStyles);
  // Ref for onFinish callback to avoid stale closures
  const onFinishRef = useRef(onFinish);
  // Keep textStylesRef in sync with textStyles prop
  useEffect(() => {
    textStylesRef.current = textStyles;
  }, [textStyles]);
  // Keep onFinishRef in sync with onFinish prop
  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  // Get store actions
  const setEditor = useCanvasTextEditorStore((s) => s.setEditor);
  const startEditing = useCanvasTextEditorStore((s) => s.startEditing);
  const stopEditing = useCanvasTextEditorStore((s) => s.stopEditing);
  const updateActiveMarks = useCanvasTextEditorStore((s) => s.updateActiveMarks);
  const setOnFinishCallback = useCanvasTextEditorStore((s) => s.setOnFinishCallback);
  const setOnSaveCallback = useCanvasTextEditorStore((s) => s.setOnSaveCallback);

  // Keep valueRef in sync with value prop
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // Track current layer ID to detect layer switches
  const currentLayerIdRef = useRef<string>(layer.id);

  // All extensions use textStylesRef so renderHTML always reads the latest styles
  const extensions = useMemo(() => [
    Document,
    createParagraphExtension(textStylesRef),
    Text,
    History,
    DynamicVariableWithNodeView,
    RichTextComponent,
    createRichTextLinkExtension(textStylesRef),
    createBoldExtension(textStylesRef),
    createItalicExtension(textStylesRef),
    createUnderlineExtension(textStylesRef),
    createStrikeExtension(textStylesRef),
    createSubscriptExtension(textStylesRef),
    createSuperscriptExtension(textStylesRef),
    createHeadingExtension(textStylesRef),
    createBlockquoteExtension(textStylesRef),
    Code,
    RichTextImage,
    createDynamicStyleExtension(textStylesRef),
  ], []);

  // Parse initial content once on mount
  const initialContent = useMemo(() => {
    if (typeof value === 'object' && value?.type === 'doc') {
      return value;
    }
    return parseValueToContent(typeof value === 'string' ? value : '', fields, undefined, allFields);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Create a ref to handle saving on unmount/finish
  const saveChangesRef = useRef<() => void>(() => {});
  // Track whether the user has actually interacted with the editor
  // Prevents Strict Mode double-mount or extension-stripping from persisting unwanted changes
  const hasUserEditedRef = useRef(false);
  // Tracks whether the editor has finished initialization (onCreate fired)
  const editorReadyRef = useRef(false);

  const editor = useEditor({
    immediatelyRender: true,
    extensions,
    content: initialContent,
    editorProps: {
      attributes: {
        class: 'outline-none ycode-text-editor',
      },
      handleKeyDown: (view, event) => {
        // Escape to save and finish editing
        if (event.key === 'Escape') {
          saveChangesRef.current();
          onFinish?.();
          return true;
        }
        return false;
      },
    },
    onSelectionUpdate: ({ editor: editorInstance }) => {
      // Update active marks in store when selection changes
      updateActiveMarks();

      // Save cursor position when selection changes (if editor is focused)
      if (editorInstance && editorInstance.isFocused) {
        const { from, to } = editorInstance.state.selection;
        savedSelectionRef.current = { from, to };
      }
    },
    onTransaction: ({ transaction, editor: editorInstance }) => {
      // Update active marks after any transaction
      updateActiveMarks();

      // Track user-initiated content changes (after editor is ready)
      if (transaction.docChanged && editorReadyRef.current) {
        hasUserEditedRef.current = true;
      }

      // Save cursor position after transaction (if editor is focused)
      if (editorInstance && editorInstance.isFocused) {
        const { from, to } = editorInstance.state.selection;
        savedSelectionRef.current = { from, to };
      }
    },
    onCreate: ({ editor: editorInstance }) => {
      // Reset editor state to clear history so initial content isn't undoable
      const { state } = editorInstance;
      editorInstance.view.updateState(EditorState.create({
        doc: state.doc,
        plugins: state.plugins,
      }));
      // Mark editor as ready — any subsequent docChanged transactions are user edits
      editorReadyRef.current = true;
    },
    onBlur: ({ editor: editorInstance }) => {
      // Save cursor position when editor loses focus
      if (editorInstance) {
        const { from, to } = editorInstance.state.selection;
        savedSelectionRef.current = { from, to };
      }
    },
    onFocus: ({ editor: editorInstance }) => {
      // Restore cursor position when editor regains focus
      if (editorInstance && savedSelectionRef.current) {
        const { from, to } = savedSelectionRef.current;
        try {
          const docSize = editorInstance.state.doc.content.size;
          const safeFrom = Math.min(from, docSize);
          const safeTo = Math.min(to, docSize);

          if (safeFrom >= 0 && safeTo >= 0 && safeFrom <= docSize && safeTo <= docSize) {
            // Use setTimeout to ensure focus is complete before restoring selection
            setTimeout(() => {
              editorInstance.commands.setTextSelection({ from: safeFrom, to: safeTo });
            }, 0);
          }
        } catch (error) {
          // Ignore errors when restoring selection
        }
      }
    },
  }, [extensions]);

  // Function to apply dynamic style classes to DOM elements
  const applyDynamicStyles = useCallback(() => {
    if (!editorRef.current) return;
    const styles = textStylesRef.current || {};

    // Find all elements with data-style-keys and update their classes
    const styledElements = editorRef.current.querySelectorAll('[data-style-keys]');
    styledElements.forEach((el) => {
      const keysAttr = el.getAttribute('data-style-keys');
      if (!keysAttr) return;

      try {
        const styleKeys: string[] = JSON.parse(keysAttr);
        // Combine classes from all styleKeys using cn() for intelligent merging
        // Later styles override earlier ones for conflicting properties
        const classesArray = styleKeys
          .map(key => styles[key]?.classes || '')
          .filter(Boolean);
        el.className = cn(...classesArray);
      } catch {
        // Fallback: single key
        const singleKey = el.getAttribute('data-style-key');
        if (singleKey && styles[singleKey]) {
          el.className = styles[singleKey].classes || '';
        }
      }
    });
  }, []);

  // Subscribe to editor events to apply dynamic styles when content renders
  useEffect(() => {
    if (!editor) return;

    // Apply styles when editor creates/updates content
    const handleCreate = () => {
      // Use requestAnimationFrame to ensure DOM is updated
      requestAnimationFrame(applyDynamicStyles);
    };

    const handleUpdate = () => {
      requestAnimationFrame(applyDynamicStyles);
    };

    editor.on('create', handleCreate);
    editor.on('update', handleUpdate);

    // Also apply immediately and after delays for initial render
    applyDynamicStyles();
    const timeoutId1 = setTimeout(applyDynamicStyles, 50);
    const timeoutId2 = setTimeout(applyDynamicStyles, 150);

    return () => {
      editor.off('create', handleCreate);
      editor.off('update', handleUpdate);
      clearTimeout(timeoutId1);
      clearTimeout(timeoutId2);
    };
  }, [editor, applyDynamicStyles]);

  // Sync block/mark classes when textStyles change (extensions use refs,
  // but ProseMirror won't call renderHTML again for unchanged content)
  useEffect(() => {
    if (!editor?.view?.dom) return;
    const root = editor.view.dom;
    const styles = textStylesRef.current;

    const TAG_TO_STYLE_KEY: Record<string, string> = {
      P: 'paragraph', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
      BLOCKQUOTE: 'blockquote',
      STRONG: 'bold', EM: 'italic', U: 'underline', S: 'strike', SUB: 'subscript', SUP: 'superscript',
      A: 'link',
    };

    for (const [tag, key] of Object.entries(TAG_TO_STYLE_KEY)) {
      const els = root.querySelectorAll(tag.toLowerCase());
      const cls = getTextStyleClasses(styles, key);
      els.forEach(el => { (el as HTMLElement).className = cls; });
    }

    applyDynamicStyles();
  }, [textStyles, editor, applyDynamicStyles]);

  // Register editor with store on mount
  useEffect(() => {
    if (editor) {
      setEditor(editor);
      startEditing(layer.id);

      // Register finish callback so toolbar "Done" button can trigger finish
      // Use refs to avoid stale closures when onChange/onFinish change identity
      setOnFinishCallback(() => {
        saveChangesRef.current();
        onFinishRef.current?.();
      });

      // Register save callback so dynamicStyle application can trigger a save
      setOnSaveCallback(() => {
        saveChangesRef.current();
      });
    }

    return () => {
      // Cleanup: save changes and unregister
      saveChangesRef.current();
      stopEditing();
      // Reset tracking flags for Strict Mode re-mount
      hasUserEditedRef.current = false;
      editorReadyRef.current = false;
    };
  }, [editor, setEditor, startEditing, stopEditing, setOnFinishCallback, setOnSaveCallback, layer.id]);

  // Update save function when editor or onChange changes
  useEffect(() => {
    saveChangesRef.current = () => {
      if (editor && hasUserEditedRef.current) {
        const currentValue = editor.getJSON();
        if (JSON.stringify(currentValue) !== JSON.stringify(valueRef.current)) {
          onChange(currentValue);
          valueRef.current = currentValue;
        }
      }
    };
  }, [editor, onChange]);

  // Handle layer switches: save old content before loading new layer
  useEffect(() => {
    if (!editor) return;

    if (currentLayerIdRef.current !== layer.id) {
      // Layer has changed - save the current editor content before switching
      if (currentLayerIdRef.current && hasUserEditedRef.current) {
        const currentContent = editor.getJSON();
        if (JSON.stringify(currentContent) !== JSON.stringify(valueRef.current)) {
          onChange(currentContent);
        }
      }
      // Update to new layer ID and reset edit tracking for the new layer
      currentLayerIdRef.current = layer.id;
      hasUserEditedRef.current = false;
      editorReadyRef.current = false;
    }
  }, [layer.id, editor, onChange]);

  // Focus editor on mount (only if no saved selection exists)
  useEffect(() => {
    if (!editor) return;

    let retryCount = 0;
    const MAX_RETRIES = 50; // Maximum 50 retries (500ms total)
    let timeoutId: NodeJS.Timeout | null = null;

    // Wait for the view to be fully mounted
    const checkAndFocus = () => {
      // Stop retrying if we've exceeded max retries
      if (retryCount >= MAX_RETRIES) {
        console.warn('Failed to focus editor: max retries exceeded');
        return;
      }

      retryCount++;

      try {
        // Check if editor still exists
        if (!editor || !editor.view) {
          timeoutId = setTimeout(checkAndFocus, 10);
          return;
        }

        // Try to access view.dom safely (it may throw if not ready)
        let dom: HTMLElement | null = null;
        try {
          dom = editor.view.dom;
        } catch (error) {
          // view.dom is not available yet, retry
          timeoutId = setTimeout(checkAndFocus, 10);
          return;
        }

        if (!dom || !dom.isConnected) {
          timeoutId = setTimeout(checkAndFocus, 10);
          return;
        }

        // All checks passed, safe to focus
        // Priority 1: Restore saved selection (from previous blur)
        if (savedSelectionRef.current) {
          const { from, to } = savedSelectionRef.current;
          const docSize = editor.state.doc.content.size;
          const safeFrom = Math.min(from, docSize);
          const safeTo = Math.min(to, docSize);

          if (safeFrom >= 0 && safeTo >= 0 && safeFrom <= docSize && safeTo <= docSize) {
            editor.commands.setTextSelection({ from: safeFrom, to: safeTo });
            editor.commands.focus();
          } else {
            editor.commands.focus('end');
          }
        }
        // Priority 2: Use click coordinates to position cursor
        else if (clickCoordsRef.current && editor.view.dom) {
          try {
            // Use Tiptap's posAtCoords to find the document position at these coordinates
            const pos = editor.view.posAtCoords({
              left: clickCoordsRef.current.x,
              top: clickCoordsRef.current.y
            });

            if (pos) {
              editor.commands.setTextSelection(pos.pos);
              editor.commands.focus();
            } else {
              // Fallback to end if coords are outside content
              editor.commands.focus('end');
            }
          } catch (error) {
            console.warn('Failed to position cursor at click coordinates:', error);
            editor.commands.focus('end');
          }
        }
        // Priority 3: Default to end
        else {
          editor.commands.focus('end');
        }
      } catch (error) {
        // If view is not available, retry after a delay
        if (error instanceof Error && (error.message.includes('view') || error.message.includes('dom'))) {
          if (retryCount < MAX_RETRIES) {
            timeoutId = setTimeout(checkAndFocus, 10);
          } else {
            console.warn('Failed to focus editor:', error);
          }
        } else {
          console.warn('Failed to focus editor:', error);
        }
      }
    };

    timeoutId = setTimeout(checkAndFocus, 0);

    // Cleanup: cancel pending timeout if component unmounts or editor changes
    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [editor]);

  // Update content when value changes externally (but preserve cursor position)
  // IMPORTANT: Skip updates when editor is focused to prevent resetting user edits
  // This is critical for the dynamicStyle auto-apply feature, which modifies content
  // before updating layer.textStyles - we don't want the old value to reset the editor
  useEffect(() => {
    if (!editor) return;

    // Skip external content sync when user is actively editing
    // User edits are saved on finish/unmount, not during editing
    if (editor.isFocused) return;

    const currentContent = editor.getJSON();
    const newContent = typeof value === 'object' && value?.type === 'doc'
      ? value
      : parseValueToContent(typeof value === 'string' ? value : '', fields, undefined, allFields);

    // Only update if content actually changed (not just design properties)
    if (JSON.stringify(currentContent) !== JSON.stringify(newContent)) {
      editor.commands.setContent(newContent, { emitUpdate: false });
      // Update valueRef to track the new content
      valueRef.current = newContent;
    }
  }, [value, fields, allFields, editor, layer.id]);

  // Add field variable
  const addFieldVariable = useCallback((variableData: FieldVariable) => {
    if (!editor || !editor.view) return;

    const { from } = editor.state.selection;
    const doc = editor.state.doc;

    let needsSpaceBefore = false;
    if (from > 0) {
      const nodeBefore = doc.nodeAt(from - 1);
      if (nodeBefore?.type.name === 'dynamicVariable') {
        needsSpaceBefore = true;
      } else {
        const charBefore = doc.textBetween(from - 1, from);
        needsSpaceBefore = Boolean(charBefore && charBefore !== ' ' && charBefore !== '\n');
      }
    }

    let needsSpaceAfter = false;
    if (from < doc.content.size) {
      const nodeAfter = doc.nodeAt(from);
      if (nodeAfter?.type.name === 'dynamicVariable') {
        needsSpaceAfter = true;
      } else {
        const charAfter = doc.textBetween(from, from + 1);
        needsSpaceAfter = Boolean(charAfter && charAfter !== ' ' && charAfter !== '\n');
      }
    }

    const label = getVariableLabel(variableData, fields, allFields);
    const contentToInsert: any[] = [];

    if (needsSpaceBefore) {
      contentToInsert.push({ type: 'text', text: ' ' });
    }

    contentToInsert.push({
      type: 'dynamicVariable',
      attrs: { variable: variableData, label },
    });

    if (needsSpaceAfter) {
      contentToInsert.push({ type: 'text', text: ' ' });
    }

    editor.chain().focus().insertContent(contentToInsert).run();
  }, [editor, fields, allFields]);

  // Handle clicks on styled text to select that style for editing
  const handleEditorClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const setActiveTextStyleKey = useEditorStore.getState().setActiveTextStyleKey;

    // Check if clicked element or its parents have data-style-key (for dynamicStyle marks)
    const styledElement = target.closest('[data-style-key]') as HTMLElement;
    if (styledElement) {
      const styleKey = styledElement.getAttribute('data-style-key');
      if (styleKey) {
        setActiveTextStyleKey(styleKey);
        return;
      }
    }

    // Also check for data-style (for headings, paragraphs, lists from nested rich text)
    const blockStyleElement = target.closest('[data-style]') as HTMLElement;
    if (blockStyleElement) {
      const styleKey = blockStyleElement.getAttribute('data-style');
      if (styleKey) {
        setActiveTextStyleKey(styleKey);
        return;
      }
    }
  }, []);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    focus: () => {
      if (editor?.view) {
        try {
          editor.commands.focus('end');
        } catch (error) {
          console.warn('Failed to focus editor:', error);
        }
      }
    },
    addFieldVariable,
  }), [editor, addFieldVariable]);

  if (!editor) return null;

  return (
    <div
      ref={editorRef}
      className="relative"
      onClick={handleEditorClick}
    >
      <EditorContent editor={editor} />
    </div>
  );
});

CanvasTextEditor.displayName = 'CanvasTextEditor';

export default CanvasTextEditor;
