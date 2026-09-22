/**
 * Content Elements Templates
 */

import { BlockTemplate } from '@/types';
import { getTiptapTextContent } from '@/lib/text-format-utils';

export const contentTemplates: Record<string, BlockTemplate> = {
  heading: {
    icon: 'heading',
    name: 'Heading',
    template: {
      name: 'heading',
      settings: {
        tag: 'h2',
      },
      classes: ['text-[48px]', 'font-[700]', 'leading-[1.1]', 'tracking-[-0.01em]'],
      restrictions: { editText: true },
      design: {
        typography: {
          isActive: true,
          fontSize: '48px',
          fontWeight: '700',
          lineHeight: '1.1',
          letterSpacing: '-0.01',
        }
      },
      variables: {
        text: {
          type: 'dynamic_rich_text',
          data: {
            content: getTiptapTextContent('Heading')
          }
        }
      }
    }
  },

  text: {
    icon: 'text',
    name: 'Text',
    template: {
      name: 'text',
      settings: {
        tag: 'p',
      },
      classes: ['text-[16px]'],
      restrictions: { editText: true },
      design: {
        typography: {
          isActive: true,
          fontSize: '16px',
        }
      },
      variables: {
        text: {
          type: 'dynamic_rich_text',
          data: {
            content: getTiptapTextContent('Text')
          }
        }
      }
    }
  },

  richText: {
    icon: 'rich-text',
    name: 'Rich Text',
    template: {
      name: 'richText',
      classes: ['flex', 'flex-col', 'gap-[16px]', 'text-[16px]'],
      restrictions: { editText: true },
      design: {
        layout: {
          isActive: true,
          display: 'Flex',
          flexDirection: 'column',
          gap: '16px',
        },
        typography: {
          isActive: true,
          fontSize: '16px',
        }
      },
      variables: {
        text: {
          type: 'dynamic_rich_text',
          data: {
            content: {
              type: 'doc',
              content: [
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading 1' }] },
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading 2' }] },
                { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Heading 3' }] },
                { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Heading 4' }] },
                { type: 'heading', attrs: { level: 5 }, content: [{ type: 'text', text: 'Heading 5' }] },
                { type: 'heading', attrs: { level: 6 }, content: [{ type: 'text', text: 'Heading 6' }] },
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.' }],
                },
                { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Block quote' }] }] },
                {
                  type: 'orderedList',
                  content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 3' }] }] },
                  ],
                },
                {
                  type: 'bulletList',
                  content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item A' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item B' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item C' }] }] },
                  ],
                },
                { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'richTextLink', attrs: { type: 'url', url: { type: 'dynamic_text', data: { content: '#' } } } }], text: 'Text link' }] },
                { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Bold text' }] },
                { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'italic' }], text: 'Italic text' }] },
              ],
            },
          }
        }
      }
    }
  },
};
