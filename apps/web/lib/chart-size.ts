export function chartContainerSize(
  element: Pick<HTMLElement, 'clientWidth' | 'clientHeight'>,
): { width: number; height: number } | null {
  const width = Math.floor(element.clientWidth);
  const height = Math.floor(element.clientHeight);
  return width > 0 && height > 0 ? { width, height } : null;
}
