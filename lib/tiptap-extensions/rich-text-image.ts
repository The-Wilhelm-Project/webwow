import Image from '@tiptap/extension-image';
import { mergeAttributes } from '@tiptap/core';
import type { LinkSettings } from '@/types';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    richTextImage: {
      setRichTextImage: (attrs: { src: string; alt?: string; assetId?: string; link?: LinkSettings | null }) => ReturnType;
    };
  }
}

/**
 * Block-level image node for rich-text content.
 * Stores the asset ID alongside src/alt so images can be resolved
 * from the asset system at render time.
 * Link data is stored in the `link` attribute (full LinkSettings JSON).
 */
export const RichTextImage = Image.extend({
  name: 'richTextImage',
  group: 'block',
  inline: false,
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-asset-id') || null,
        renderHTML: (attributes) => {
          if (!attributes.assetId) return {};
          return { 'data-asset-id': attributes.assetId };
        },
      },
      link: {
        default: null,
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  addCommands() {
    return {
      setRichTextImage:
        (attrs) =>
          ({ commands }) => {
            return commands.insertContent({
              type: this.name,
              attrs: {
                src: attrs.src,
                alt: attrs.alt || null,
                assetId: attrs.assetId || null,
                link: attrs.link || null,
              },
            });
          },
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { selection } = editor.state;
        const node = editor.state.doc.nodeAt(selection.from);
        if (node?.type.name !== this.name) return false;

        const pos = selection.from + node.nodeSize;
        const after = editor.state.doc.nodeAt(pos);

        if (!after) {
          editor.chain()
            .insertContentAt(pos, { type: 'paragraph' })
            .setTextSelection(pos + 1)
            .run();
        } else {
          editor.chain().setTextSelection(pos + 1).run();
        }
        return true;
      },
      ArrowDown: ({ editor }) => {
        const { selection } = editor.state;
        const node = editor.state.doc.nodeAt(selection.from);
        if (node?.type.name !== this.name) return false;
        const pos = selection.from + node.nodeSize;
        const after = editor.state.doc.nodeAt(pos);
        if (!after) {
          editor.chain()
            .insertContentAt(pos, { type: 'paragraph' })
            .setTextSelection(pos + 1)
            .run();
          return true;
        }
        return false;
      },
      ArrowUp: ({ editor }) => {
        const { selection } = editor.state;
        const node = editor.state.doc.nodeAt(selection.from);
        if (node?.type.name !== this.name) return false;
        const $pos = editor.state.doc.resolve(selection.from);
        if ($pos.index() === 0) {
          editor.chain()
            .insertContentAt(selection.from, { type: 'paragraph' })
            .run();
          return true;
        }
        return false;
      },
    };
  },
});

export default RichTextImage;
