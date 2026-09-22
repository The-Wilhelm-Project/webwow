import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    richTextHtmlEmbed: {
      /** Insert an HTML embed block into the editor */
      insertHtmlEmbed: () => ReturnType;
      /** Update the code on the currently selected HTML embed node */
      updateHtmlEmbedCode: (code: string) => ReturnType;
    };
  }
}

/**
 * Block-level Tiptap node for embedding custom HTML/script code in rich-text content.
 * Stores the code string as a data attribute.
 * Node view rendering is handled by the consuming editor via extend().
 */
export const RichTextHtmlEmbed = Node.create({
  name: 'richTextHtmlEmbed',
  group: 'block',
  atom: true,
  draggable: false,

  addStorage() {
    return {
      handleArrowAfter(editor: any, typeName: string): boolean {
        const { selection } = editor.state;
        const node = editor.state.doc.nodeAt(selection.from);
        if (node?.type.name !== typeName) return false;

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
      handleArrowBefore(editor: any, typeName: string): boolean {
        const { selection } = editor.state;
        const node = editor.state.doc.nodeAt(selection.from);
        if (node?.type.name !== typeName) return false;

        const pos = selection.from;
        const $pos = editor.state.doc.resolve(pos);

        if ($pos.index() === 0) {
          editor.chain()
            .insertContentAt(pos, { type: 'paragraph' })
            .run();
          return true;
        }
        return false;
      },
    };
  },

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-html-embed-code') || '',
        renderHTML: (attributes) => {
          if (!attributes.code) return {};
          return { 'data-html-embed-code': attributes.code };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="richTextHtmlEmbed"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'rich-text-html-embed-block',
        'data-type': 'richTextHtmlEmbed',
      }),
      'HTML Embed',
    ];
  },

  addCommands() {
    return {
      insertHtmlEmbed:
        () =>
          ({ commands }) => {
            return commands.insertContent({
              type: this.name,
              attrs: { code: '' },
            });
          },

      updateHtmlEmbedCode:
        (code) =>
          ({ tr, state, dispatch }) => {
            const { selection } = state;
            const node = state.doc.nodeAt(selection.from);

            if (!node || node.type.name !== this.name) {
              return false;
            }

            if (dispatch) {
              tr.setNodeMarkup(selection.from, undefined, {
                ...node.attrs,
                code,
              });
            }

            return true;
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

      ArrowDown: ({ editor }) => this.storage.handleArrowAfter(editor, this.name),
      ArrowRight: ({ editor }) => this.storage.handleArrowAfter(editor, this.name),
      ArrowUp: ({ editor }) => this.storage.handleArrowBefore(editor, this.name),
      ArrowLeft: ({ editor }) => this.storage.handleArrowBefore(editor, this.name),
    };
  },
});
