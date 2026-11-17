export type Outcome<T = object> =
  ({ ok: true } & T) | { ok: false; message: string; details?: string[] };
