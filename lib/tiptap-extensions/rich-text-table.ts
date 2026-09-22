import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    richTextTable: {
      insertRichTextTable: (options?: {
        rows?: number;
        cols?: number;
        withHeaderRow?: boolean;
      }) => ReturnType;
      toggleCurrentRowHeader: () => ReturnType;
    };
  }
}

export const RichTextTable = Table.extend({
  name: 'table',

  addOptions() {
    const parent = this.parent?.();
    return {
      HTMLAttributes: parent?.HTMLAttributes ?? {},
      resizable: parent?.resizable ?? false,
      renderWrapper: true,
      handleWidth: parent?.handleWidth ?? 5,
      cellMinWidth: parent?.cellMinWidth ?? 25,
      View: parent?.View ?? null,
      lastColumnResizable: parent?.lastColumnResizable ?? true,
      allowTableNodeSelection: parent?.allowTableNodeSelection ?? false,
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      insertRichTextTable:
        ({ rows = 3, cols = 3, withHeaderRow = true } = {}) =>
          ({ commands }) => {
            return commands.insertTable({ rows, cols, withHeaderRow });
          },
      toggleCurrentRowHeader:
        () =>
          ({ state, tr, dispatch }) => {
            const { selection, schema } = state;
            const $pos = selection.$from;

            const headerType = schema.nodes.tableHeader;
            const cellType = schema.nodes.tableCell;
            if (!headerType || !cellType) return false;

            // Walk up from cursor to find the tableRow node
            let rowDepth: number | null = null;
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name === 'tableRow') {
                rowDepth = d;
                break;
              }
            }
            if (rowDepth === null) return false;

            const row = $pos.node(rowDepth);
            const rowStart = $pos.start(rowDepth);

            // Determine target type: if any cell is tableCell, convert all to tableHeader; otherwise convert to tableCell
            let hasRegularCell = false;
            row.forEach((cell) => {
              if (cell.type === cellType) hasRegularCell = true;
            });
            const targetType = hasRegularCell ? headerType : cellType;

            if (!dispatch) return true;

            let offset = 0;
            row.forEach((cell) => {
              if (cell.type !== targetType) {
                const pos = rowStart + offset;
                tr.setNodeMarkup(pos, targetType, cell.attrs);
              }
              offset += cell.nodeSize;
            });

            return true;
          },
    };
  },
});

export const RichTextTableRow = TableRow.extend({
  name: 'tableRow',
});

export const RichTextTableCell = TableCell.extend({
  name: 'tableCell',
});

export const RichTextTableHeader = TableHeader.extend({
  name: 'tableHeader',
});
