/**
 * Structure Elements Templates
 */

import { BlockTemplate } from '@/types';
import { getTemplateRef } from '@/lib/templates/blocks';
import { getTiptapTextContent } from '@/lib/text-format-utils';

type CellBorders = { top?: boolean; left?: boolean };

const BORDER_COLOR_HEX = '#000000';
const BORDER_COLOR_OPACITY = '10';
const BORDER_COLOR_CLASS = `border-[${BORDER_COLOR_HEX}]/${BORDER_COLOR_OPACITY}`;
const BORDER_COLOR_VALUE = `${BORDER_COLOR_HEX}/${BORDER_COLOR_OPACITY}`;

function cellBorderClasses(borders?: CellBorders): string[] {
  const classes: string[] = [];
  if (borders?.top) classes.push('border-t-[1px]', BORDER_COLOR_CLASS);
  if (borders?.left) classes.push('border-l-[1px]', BORDER_COLOR_CLASS);
  return classes;
}

function cellBorderDesign(borders?: CellBorders) {
  if (!borders?.top && !borders?.left) {
    return { borders: { isActive: true } };
  }
  return {
    borders: {
      isActive: true,
      borderWidthMode: 'individual',
      borderColor: BORDER_COLOR_VALUE,
      borderStyle: 'solid',
      ...(borders?.top ? { borderTopWidth: '1' } : {}),
      ...(borders?.left ? { borderLeftWidth: '1' } : {}),
    },
  };
}

function cellTextChild(text: string) {
  return getTemplateRef('text', {
    variables: {
      text: {
        type: 'dynamic_rich_text',
        data: { content: getTiptapTextContent(text) },
      },
    },
  });
}

function headerCell(text: string, borders?: CellBorders) {
  return {
    name: 'th',
    classes: [
      'text-left',
      'font-[500]',
      'pt-[12px]',
      'pr-[12px]',
      'pb-[12px]',
      'pl-[12px]',
      'bg-[#000000]/5',
      ...cellBorderClasses(borders),
    ],
    children: [cellTextChild(text)],
    design: {
      ...cellBorderDesign(borders),
      spacing: { isActive: true, paddingTop: '12', paddingRight: '12', paddingBottom: '12', paddingLeft: '12' },
      typography: { isActive: true, fontWeight: '500', textAlign: 'left' },
      backgrounds: { isActive: true, backgroundColor: '#000000/5' },
    },
  };
}

function bodyCell(text: string, borders?: CellBorders) {
  return {
    name: 'td',
    classes: [
      'pt-[12px]',
      'pr-[12px]',
      'pb-[12px]',
      'pl-[12px]',
      ...cellBorderClasses(borders),
    ],
    children: [cellTextChild(text)],
    design: {
      ...cellBorderDesign(borders),
      spacing: { isActive: true, paddingTop: '12', paddingRight: '12', paddingBottom: '12', paddingLeft: '12' },
      typography: { isActive: true, textAlign: 'left', verticalAlign: 'top' },
    },
  };
}

export const structureTemplates: Record<string, BlockTemplate> = {
  div: {
    icon: 'block',
    name: 'Block',
    template: {
      name: 'div',
      classes: ['flex', 'flex-col'],
      children: [],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
      }
    }
  },

  section: {
    icon: 'section',
    name: 'Section',
    template: {
      name: 'section',
      classes: ['flex', 'flex-col', 'w-[100%]', 'pt-[80px]', 'pb-[80px]', 'items-center'],
      children: [],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column', alignItems: 'center' },
        sizing: { isActive: true, width: '100%' },
        spacing: { isActive: true, paddingTop: '80px', paddingBottom: '80px' }
      }
    }
  },

  container: {
    icon: 'container',
    name: 'Container',
    template: {
      name: 'div',
      classes: ['flex', 'flex-col', 'max-w-[1280px]', 'w-[100%]', 'pl-[32px]', 'pr-[32px]'],
      children: [],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
        sizing: { isActive: true, width: '100%', maxWidth: '1280px' },
        spacing: { isActive: true, paddingLeft: '32px', paddingRight: '32px' },
      }
    }
  },

  hr: {
    icon: 'separator',
    name: 'Separator',
    template: {
      name: 'hr',
      classes: ['border-t-[1px]', 'border-[#aeaeae]'],
      design: {
        borders: { isActive: true, borderTopWidth: '1px', borderColor: '#aeaeae' },
      }
    }
  },

  columns: {
    icon: 'columns',
    name: 'Columns',
    template: {
      name: 'div',
      classes: ['flex', 'gap-[16px]'],
      children: [
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        },
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        }
      ] as any[],
      design: {
        layout: { isActive: true, display: 'Flex', gap: '16px' }
      }
    }
  },

  rows: {
    icon: 'rows',
    name: 'Rows',
    template: {
      name: 'div',
      classes: ['flex', 'flex-col', 'gap-[16px]'],
      children: [
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        },
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        }
      ] as any[],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '16px' }
      }
    }
  },

  grid: {
    icon: 'grid',
    name: 'Grid',
    template: {
      name: 'div',
      classes: ['grid', 'grid-cols-[repeat(2,_1fr)]', 'gap-[16px]'],
      children: [
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        },
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        },
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        },
        {
          name: 'div',
          classes: ['flex', 'flex-col'],
          children: [],
          design: {
            layout: { isActive: true, display: 'Flex', flexDirection: 'column' },
          }
        }
      ] as any[],
      design: {
        layout: { isActive: true, display: 'Grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px' }
      }
    }
  },

  table: {
    icon: 'table',
    name: 'Table',
    template: {
      name: 'table',
      classes: [
        'w-full',
        'border-separate',
        'border-spacing-0',
        'border-solid',
        'border-[1px]',
        BORDER_COLOR_CLASS,
        'rounded-[10px]',
        'overflow-hidden',
      ],
      children: [
        {
          name: 'tbody',
          classes: [],
          children: [
            {
              name: 'tr',
              classes: [],
              children: [
                headerCell('Header 1'),
                headerCell('Header 2', { left: true }),
                headerCell('Header 3', { left: true }),
              ] as any[],
            },
            {
              name: 'tr',
              classes: [],
              children: [
                bodyCell('Cell 1-1', { top: true }),
                bodyCell('Cell 1-2', { top: true, left: true }),
                bodyCell('Cell 1-3', { top: true, left: true }),
              ] as any[],
            },
            {
              name: 'tr',
              classes: [],
              children: [
                bodyCell('Cell 2-1', { top: true }),
                bodyCell('Cell 2-2', { top: true, left: true }),
                bodyCell('Cell 2-3', { top: true, left: true }),
              ] as any[],
            },
          ] as any[],
        },
      ] as any[],
      design: {
        sizing: { isActive: true, width: '100%' },
        borders: {
          isActive: true,
          borderWidth: '1',
          borderStyle: 'solid',
          borderColor: BORDER_COLOR_VALUE,
          borderRadius: '10',
        },
      },
    },
  },

  thead: {
    icon: 'header',
    name: 'Head',
    template: {
      name: 'thead',
      classes: [],
      children: [
        {
          name: 'tr',
          classes: [],
          children: [headerCell('Header')] as any[],
        },
      ] as any[],
    },
  },

  tbody: {
    icon: 'body',
    name: 'Body',
    template: {
      name: 'tbody',
      classes: [],
      children: [
        {
          name: 'tr',
          classes: [],
          children: [bodyCell('Cell')] as any[],
        },
      ] as any[],
    },
  },

  tr: {
    icon: 'section',
    name: 'Row',
    template: {
      name: 'tr',
      classes: [],
      children: [bodyCell('Cell')] as any[],
    },
  },

  th: {
    icon: 'container',
    name: 'Header',
    template: headerCell('Header') as any,
  },

  td: {
    icon: 'container',
    name: 'Cell',
    template: bodyCell('Cell') as any,
  },

  collection: {
    icon: 'database',
    name: 'Collection',
    template: {
      name: 'div',
      classes: ['flex', 'flex-col', 'gap-[1rem]'],
      children: [],
      design: {
        layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '1rem' }
      },
      variables: {
        collection: {
          id: '' // To be set by user
        }
      }
    }
  }
};
