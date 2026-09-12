import type { Layer } from '@/types';
import { getTiptapTextContent } from '@/lib/text-format-utils';

/**
 * Canonical password-form layer subtree used by:
 *  - `DEFAULT_ERROR_PAGES` (seeding new 401 pages)
 *  - the `add_password_form_to_401_page` migration (backfilling existing 401 pages)
 *
 * At runtime `LayerRendererPublic` detects `settings.form.form_type === 'password_protected'`
 * and wires the submit handler to `/api/page-auth/verify`. The layers are marked
 * `restrictions: { copy: false, delete: false }` so users can restyle but not remove them.
 */
export function buildPasswordFormSubtree(): Layer {
  return {
    id: 'layer-1762789200000-pw-form',
    name: 'form',
    settings: {
      id: 'password-protected-form',
      form: { form_type: 'password_protected' },
    },
    attributes: { method: 'POST', action: '' },
    design: {
      layout: { isActive: true, display: 'Flex', flexDirection: 'column', gap: '16' },
      sizing: { isActive: true, width: '100%' },
      spacing: { isActive: true, marginTop: '1rem' },
    },
    classes: 'w-full flex flex-col mt-[1rem] gap-[16px]',
    restrictions: { copy: false, delete: false },
    customName: 'Password form',
    children: [
      {
        id: 'layer-1762789200002-pw-error',
        name: 'div',
        alertType: 'error',
        hiddenGenerated: true,
        design: {
          backgrounds: { isActive: true, backgroundColor: '#fee2e2' },
          borders: { isActive: true, borderRadius: '0.75rem' },
          layout: { isActive: true, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
          sizing: { isActive: true, height: '38' },
          spacing: { isActive: true, paddingTop: '1rem', paddingBottom: '1rem', paddingLeft: '16', paddingRight: '16' },
          typography: { isActive: true, fontSize: '14px', color: '#991b1b', fontWeight: '500' },
        },
        classes: 'bg-[#fee2e2] text-[#991b1b] text-[14px] font-[500] rounded-[0.75rem] pr-[16px] pl-[16px] h-[38px] justify-center items-center flex flex-col',
        restrictions: { copy: false, delete: false },
        customName: 'Error alert',
        children: [
          {
            id: 'layer-1762789200003-pw-error-text',
            name: 'text',
            settings: { tag: 'span' },
            classes: '',
            design: {},
            children: [],
            customName: 'Message',
            restrictions: { editText: true },
            variables: {
              text: {
                type: 'dynamic_rich_text',
                data: {
                  content: getTiptapTextContent('Incorrect password. Please try again.'),
                },
              },
            },
          },
        ],
      },
      {
        id: 'layer-1762789200010-pw-row',
        name: 'div',
        design: {
          layout: { isActive: true, display: 'Flex', flexDirection: 'row', gap: '12', alignItems: 'stretch' },
          sizing: { isActive: true, width: '100%' },
        },
        classes: 'w-full flex flex-row items-stretch gap-[12px]',
        restrictions: { copy: false, delete: false },
        customName: 'Row',
        children: [
          {
            id: 'layer-1762789200001-pw-input',
            name: 'input',
            attributes: {
              type: 'password',
              name: 'password',
              placeholder: '',
              required: true,
              autoComplete: 'current-password',
            },
            settings: { id: 'password' },
            design: {
              sizing: { isActive: true, width: '100%', height: '38px' },
              spacing: { isActive: true, paddingLeft: '1rem', paddingRight: '1rem' },
              borders: { isActive: true, borderWidth: '1px', borderColor: 'rgba(115, 115, 115, 0.15)', borderRadius: '0.75rem' },
              typography: { isActive: true, fontSize: '14px', color: '#171717', lineHeight: '24px', letterSpacing: '0px', placeholderColor: '#a8a8a8' },
              backgrounds: { isActive: true, backgroundColor: 'rgba(212, 212, 212, 0.1)' },
            },
            classes: 'w-[100%] h-[38px] pl-[16px] pr-[16px] text-[14px] leading-[24px] tracking-[0px] text-[#171717] bg-[#d4d4d4]/10 border border-solid border-[#737373]/[0.15] rounded-[12px] placeholder:text-[#a8a8a8] focus:outline-none focus:border-[#737373]/20 disabled:opacity-50 cursor-text',
            children: [],
            restrictions: { copy: false, delete: false },
            customName: 'Password input',
          },
          {
            id: 'layer-1762789200004-pw-submit',
            name: 'button',
            attributes: { type: 'submit' },
            design: {
              spacing: { isActive: true, paddingLeft: '16', paddingRight: '16' },
              backgrounds: { isActive: true, backgroundColor: '#171717' },
              typography: { isActive: true, color: '#ffffff', fontSize: '14px' },
            },
            classes: 'flex flex-row items-center justify-center text-[#FFFFFF] pr-[16px] pl-[16px] h-[38px] text-[14px] rounded-[12px] bg-[#171717] cursor-pointer',
            restrictions: { copy: false, delete: false },
            customName: 'Submit button',
            children: [
              {
                id: 'layer-1762789200005-pw-submit-text',
                name: 'text',
                settings: { tag: 'span' },
                classes: '',
                design: {},
                children: [],
                customName: 'Label',
                restrictions: { editText: true },
                variables: {
                  text: {
                    type: 'dynamic_rich_text',
                    data: {
                      content: getTiptapTextContent('Submit'),
                    },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
