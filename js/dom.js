// js/dom.js
// Builds DOM nodes from plain values. Text always goes in through
// textContent, never innerHTML, so names typed by the public render as text.

/**
 * el('button', { className: 'btn-primary', text: 'Save', type: 'button' }, child, …)
 * Attributes set to false, null or undefined are left off; true sets an
 * empty (boolean) attribute.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** "2026-08-15" → "15 Aug 2026" without a time-zone shift. */
export function dayLabel(isoDate) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [y, m, d] = String(isoDate || '').split('-').map(Number);
  return y && m && d ? `${d} ${months[m - 1]} ${y}` : String(isoDate || '');
}

/** A timestamp as a local time of day, e.g. "10:42 am". */
export function timeLabel(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}
