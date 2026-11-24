// The phone's device key (DEC-35). A random UUID the app generates on first use and keeps in IndexedDB (localStorage as a
// fallback). It identifies the browser INSTALL, not the hardware, and it is untrusted: the server only ever uses it to FLAG
// a submission made from a phone other than the one issued to the driver. Pure helpers here; storage in ui/device-key.ts.
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDeviceKey = (v: unknown): v is string =>
  typeof v === "string" && KEY.test(v);

/** First 8 hex characters, upper case, in two groups: for reading aloud and for checking the full key on the register screen. */
export const deviceShortCode = (key: string): string => {
  const h = key.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4)}`;
};

/** What the administrator types: accept the key with or without dashes, any case, surrounding spaces. */
export function parseDeviceKeyInput(raw: string): string | null {
  const h = raw.trim().replace(/[\s-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
