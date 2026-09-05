export function BrandIcon({ className = '' }: { className?: string }) {
  return (
    <img
      className={`brand-icon-image ${className}`.trim()}
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
