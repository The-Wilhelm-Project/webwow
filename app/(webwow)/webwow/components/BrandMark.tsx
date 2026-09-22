import { cn } from '@/lib/utils';

/** Webwow logo mark (same path as app/icon.svg), `currentColor`. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12.506 11.972"
      className={cn('size-5 fill-current', className)}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M7.456,4.644A5.558,5.558,0,0,1,10.062.112L10.023.044A8.685,8.685,0,0,1,11.159,5.08a15.806,15.806,0,0,1-.993,4.688A5.439,5.439,0,0,1,7.456,4.644ZM1.328,4.87.005,0,7.448,4.822,0,9.7ZM10.007.019l.016.025Z"
        transform="translate(0.833 1.13)"
      />
    </svg>
  );
}

export default BrandMark;
