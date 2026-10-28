/** One retriggerable line: rejected attempts never accumulate a stack of notices. */
export function blockedHint(layer: HTMLElement): (text: string) => void {
  const line = document.createElement('div');
  line.className = 'marker-blocked';
  line.setAttribute('role', 'status');
  let animation: Animation | null = null;
  return (text) => {
    line.textContent = text;
    animation?.cancel();
    if (!line.isConnected) layer.append(line);
    const next = line.animate([
      { opacity: 0, transform: 'translate(-50%, 9px)', offset: 0 },
      { opacity: 1, transform: 'translate(-50%, 0px)', offset: 0.14 },
      { opacity: 1, transform: 'translate(-50%, -6px)', offset: 0.65 },
      { opacity: 0, transform: 'translate(-50%, -20px)', offset: 1 },
    ], { duration: 1500, easing: 'ease-out', fill: 'none' });
    animation = next;
    next.onfinish = () => {
      if (animation !== next) return;
      animation = null;
      line.remove();
    };
  };
}
