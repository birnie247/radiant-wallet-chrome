/**
 * Clipboard writes for the extension popup.
 *
 * `navigator.clipboard` needs a secure context. An extension page is one, but a
 * denied permission or a focus race (the popup loses focus the moment another
 * window is clicked) still throws — hence the textarea fallback. The boolean
 * return matters: callers must not say "Copied" when nothing reached the
 * clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
