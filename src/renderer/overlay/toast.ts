import { LOGO_TEXTURE, textureUrl } from '../../shared/pings';

const expiry = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

export function showToast(layer: HTMLElement, title: string, body: string, ms = 1800): void {
  clearTimeout(expiry.get(layer));
  layer.querySelectorAll('.toast').forEach((t) => t.remove());
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = document.createElement('img');
  icon.src = textureUrl(LOGO_TEXTURE);
  const text = document.createElement('div');
  const b = document.createElement('b');
  b.textContent = title;
  const small = document.createElement('small');
  small.textContent = body;
  text.append(b, small);
  toast.append(icon, text);
  layer.append(toast);
  expiry.set(layer, setTimeout(() => {
    toast.classList.add('out');
    expiry.set(layer, setTimeout(() => {
      toast.remove();
      expiry.delete(layer);
    }, 220));
  }, ms));
}
