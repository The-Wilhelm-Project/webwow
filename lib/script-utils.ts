/**
 * Recreates a <script> element so the browser executes it.
 * Browsers ignore scripts inserted via innerHTML — creating a fresh
 * element and copying attributes/content forces execution.
 */
export function recreateScript(original: HTMLScriptElement): HTMLScriptElement {
  const script = document.createElement('script');
  Array.from(original.attributes).forEach((attr) => {
    script.setAttribute(attr.name, attr.value);
  });
  if (original.textContent) {
    script.textContent = original.textContent;
  }
  return script;
}
