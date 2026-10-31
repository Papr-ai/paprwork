/* global document, clearTimeout, setTimeout */
export const $ = (id) => document.getElementById(id);
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

export function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}

export function empty(listId, message) {
  const list = $(listId);
  list.replaceChildren(el('li', { class: 'empty', text: message }));
}
